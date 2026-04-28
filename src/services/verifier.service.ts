import { Logger, InternalServerErrorException } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { keccak256, toUtf8Bytes, encodeBytes32String } from "ethers";
import { retry } from "../utils/retry";

/* -------------------------------------------------------------------------- */
/*                                   TYPES                                    */
/* -------------------------------------------------------------------------- */

export type TxInputOutput = [string, bigint];

export interface ITransaction {
    hash: string;
    inputs: TxInputOutput[];
    outputs: TxInputOutput[];
    reference: string;
    status: number;
}

export interface IBlock {
    hash: string;
    number: number;
    timestamp: number;
}

interface IndexerTransaction {
    transactionId: string;
    transactionType: string;
    paymentReference?: string;
    response: any;
    isNativePayment?: boolean;
}

/**
 * Wrapper for indexer API responses. The indexer returns { status, data?, errorMessage? }.
 * We check status === "OK" before using data (matching fasset-bots pattern).
 */
interface ApiWrapper<T> {
    status: string;
    data?: T;
    errorMessage?: string;
}

/* -------------------------------------------------------------------------- */
/*                                  CONSTANTS                                 */
/* -------------------------------------------------------------------------- */

const PAYMENT_TYPE = "0x5061796d656e7400000000000000000000000000000000000000000000000000";

const PAYMENT_NONEXISTENCE_TYPE = "0x5265666572656e6365645061796d656e744e6f6e6578697374656e6365000000";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const TX_SUCCESS = 1;
const TX_FAILED = 2;
const TX_BLOCKED = 3;

/** Satoshi multiplier for UTXO chains (BTC/DOGE). Raw API values are
 *  floating-point coin amounts, so we multiply by 1e8 to get satoshis. */
const BTC_MDU = 1e8;

/** Number of business-logic level retries for key verifier methods. */
const BUSINESS_RETRY_COUNT = 3;
const BUSINESS_RETRY_DELAY_MS = 1000;

/** Hard kill timeout for multi-client races (matches fasset-bots DEFAULT_KILL_AFTER). */
const MULTI_CLIENT_TIMEOUT_MS = 20_000;

/** Pagination limit for transaction list queries. */
const TRANSACTION_PAGE_LIMIT = 100;

export enum ChainId {
    BTC = "BTC",
    DOGE = "DOGE",
    testBTC = "testBTC",
    testDOGE = "testDOGE",
    XRP = "XRP",
    testXRP = "testXRP",
}

/* -------------------------------------------------------------------------- */
/*                               SERVICE CLASS                                */
/* -------------------------------------------------------------------------- */

/**
 * Verifier client for a specific underlying chain.
 * NOT an @Injectable() — instances are created by FassetConfigService,
 * one per fasset, so each fasset uses the correct chainId.
 */
export class VerifierService {
    private readonly logger = new Logger(VerifierService.name);
    private readonly clients: { url: string; client: AxiosInstance }[] = [];
    private readonly sourceId: string;
    private readonly chainId: ChainId;
    private readonly isUTXOchain: boolean;
    constructor(chainId: ChainId, urls: string[], apiKeys: string[]) {
        if (!urls.length) {
            throw new Error("Verifier URLs not configured");
        }

        this.chainId = chainId;
        this.isUTXOchain = [ChainId.BTC, ChainId.DOGE, ChainId.testBTC, ChainId.testDOGE].includes(this.chainId);
        this.sourceId = encodeBytes32String(this.chainId);

        urls.forEach((url, index) => {
            const apiKey = apiKeys[index] || "";

            const instance = axios.create({
                baseURL: url,
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": apiKey,
                    "x-apikey": apiKey,
                },
                timeout: 10_000,
            });

            axiosRetry(instance, {
                retries: 1,
                retryDelay: axiosRetry.exponentialDelay,
                retryCondition: (error) =>
                    axiosRetry.isNetworkOrIdempotentRequestError(error) || [408, 429, 500, 502, 503, 504].includes(error.response?.status || 0),
            });

            this.clients.push({ url, client: instance });
        });
    }

    /* -------------------------------------------------------------------------- */
    /*                                 HTTP CORE                                  */
    /* -------------------------------------------------------------------------- */

    /**
     * Races a POST request across all verifier clients, returning the first successful response.
     * Uses AbortController to cancel remaining requests once one succeeds, and a hard kill
     * timeout (MULTI_CLIENT_TIMEOUT_MS) to prevent unbounded waits when all servers are slow.
     */
    private async postWithClients(endpoint: string, body?: any) {
        const controller = new AbortController();
        const killTimeout = setTimeout(() => controller.abort(), MULTI_CLIENT_TIMEOUT_MS);
        try {
            const result = await Promise.any(this.clients.map(({ client }) => client.post(endpoint, body, { signal: controller.signal }).then((r) => r.data)));
            controller.abort();
            return result;
        } catch {
            this.logger.error(`All verifier clients failed for POST ${endpoint}`);
            return null;
        } finally {
            clearTimeout(killTimeout);
        }
    }

    /**
     * Races a GET request across all verifier clients, returning the first successful response.
     * Uses AbortController to cancel remaining requests once one succeeds, and a hard kill
     * timeout (MULTI_CLIENT_TIMEOUT_MS) to prevent unbounded waits when all servers are slow.
     */
    private async getWithClients(endpoint: string) {
        const controller = new AbortController();
        const killTimeout = setTimeout(() => controller.abort(), MULTI_CLIENT_TIMEOUT_MS);
        try {
            const result = await Promise.any(this.clients.map(({ client }) => client.get(endpoint, { signal: controller.signal }).then((r) => r.data)));
            controller.abort();
            return result;
        } catch {
            this.logger.error(`All verifier clients failed for GET ${endpoint}`);
            return null;
        } finally {
            clearTimeout(killTimeout);
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                              PAYMENT METHODS                               */
    /* -------------------------------------------------------------------------- */

    async getPaymentEncodedRequest(transactionHash: string): Promise<string> {
        const request = {
            attestationType: PAYMENT_TYPE,
            sourceId: this.sourceId,
            messageIntegrityCode: "0x" + "0".repeat(64),
            requestBody: {
                transactionId: this.prefix0x(transactionHash),
                inUtxo: "0",
                utxo: "0",
            },
        };

        const response = await this.postWithClients("/Payment/prepareRequest", request);

        if (!response) {
            throw new InternalServerErrorException("Cannot get ABI encoded request");
        }

        return response.abiEncodedRequest;
    }

    async getPaymentNonexistenceEncodedRequest(
        minimalBlockNumber: string,
        deadlineBlockNumber: string,
        deadlineTimestamp: string,
        destinationAddress: string,
        amount: string,
        paymentReference: string,
        checkSourceAddressesRoot = false,
        sourceAddressesRoot: string = ZERO_BYTES32
    ): Promise<string> {
        const request = {
            attestationType: PAYMENT_NONEXISTENCE_TYPE,
            sourceId: this.sourceId,
            messageIntegrityCode: "0x" + "0".repeat(64),
            requestBody: {
                minimalBlockNumber,
                deadlineBlockNumber,
                deadlineTimestamp,
                destinationAddressHash: keccak256(toUtf8Bytes(destinationAddress)),
                amount: this.toHex(BigInt(amount)),
                standardPaymentReference: paymentReference,
                checkSourceAddresses: checkSourceAddressesRoot,
                sourceAddressesRoot,
            },
        };

        const response = await this.postWithClients("/ReferencedPaymentNonexistence/prepareRequest", request);

        if (!response) {
            throw new InternalServerErrorException("Cannot get ABI encoded request");
        }

        if (response.status?.includes("INVALID: REFERENCED TRANSACTION EXISTS")) {
            return "INVALID";
        }

        if (!response.abiEncodedRequest) {
            throw new InternalServerErrorException("ABI encoded request missing");
        }

        return response.abiEncodedRequest;
    }

    /* -------------------------------------------------------------------------- */
    /*                              BLOCK FUNCTIONS                               */
    /* -------------------------------------------------------------------------- */

    /**
     * Returns the last finalized (indexed) block number from the indexer.
     * Validates the API response status before returning (matching fasset-bots pattern).
     * Wrapped with business-logic level retry.
     */
    async getLastFinalizedBlockNumber(): Promise<number> {
        return retry(() => this.getLastFinalizedBlockNumberInner(), BUSINESS_RETRY_COUNT, BUSINESS_RETRY_DELAY_MS);
    }

    private async getLastFinalizedBlockNumberInner(): Promise<number> {
        const response: ApiWrapper<number> | null = await this.getWithClients("/api/indexer/block-height-indexed");

        if (!response) {
            throw new InternalServerErrorException("Cannot get last finalized block number");
        }

        if (response.status !== "OK") {
            this.logger.error(`Indexer block-height-indexed returned status: ${response.status}, error: ${response.errorMessage}`);
            throw new InternalServerErrorException(`Block height query failed: ${response.errorMessage || response.status}`);
        }

        return response.data!;
    }

    /**
     * Returns a confirmed block at the given block number from the indexer.
     * Returns null if the block is not found. Wrapped with business-logic level retry.
     */
    async getBlock(blockNumber: number): Promise<IBlock | null> {
        return retry(() => this.getBlockInner(blockNumber), BUSINESS_RETRY_COUNT, BUSINESS_RETRY_DELAY_MS);
    }

    private async getBlockInner(blockNumber: number): Promise<IBlock | null> {
        const response: ApiWrapper<any> | null = await this.getWithClients(`/api/indexer/confirmed-block-at/${blockNumber}`);

        if (!response) {
            throw new InternalServerErrorException("Cannot get block");
        }

        if (response.status !== "OK") {
            /* "Block not found" is not an error — return null instead of throwing */
            if (response.errorMessage?.includes("not found")) {
                return null;
            }
            this.logger.error(`Indexer confirmed-block-at returned status: ${response.status}, error: ${response.errorMessage}`);
            throw new InternalServerErrorException(`Block query failed: ${response.errorMessage || response.status}`);
        }

        if (!response.data) {
            return null;
        }

        return {
            hash: response.data.blockHash,
            number: response.data.blockNumber,
            timestamp: response.data.timestamp,
        };
    }

    /* -------------------------------------------------------------------------- */
    /*                          TRANSACTION BY HASH                               */
    /* -------------------------------------------------------------------------- */

    /**
     * Fetches a single transaction by hash from the indexer.
     * Returns null if the transaction is not found. Wrapped with retry.
     */
    async getTransaction(txHash: string): Promise<ITransaction | null> {
        return retry(() => this.getTransactionInner(txHash), BUSINESS_RETRY_COUNT, BUSINESS_RETRY_DELAY_MS);
    }

    private async getTransactionInner(txHash: string): Promise<ITransaction | null> {
        const normalizedHash = this.prefix0x(txHash);
        const response: ApiWrapper<any> | null = await this.getWithClients(`/api/indexer/transaction/${normalizedHash}?returnResponse=true`);

        if (!response) {
            return null;
        }

        if (response.status !== "OK") {
            /* "Transaction not found" is not an error — return null */
            if (response.errorMessage?.includes("not found")) {
                return null;
            }
            return null;
        }

        if (!response.data) {
            return null;
        }

        return this.convertToITransaction(response.data);
    }

    /* -------------------------------------------------------------------------- */
    /*                          TRANSACTION BY REFERENCE                          */
    /* -------------------------------------------------------------------------- */

    /**
     * Fetches all transactions matching a payment reference.
     * Wrapped with business-logic level retry.
     */
    async getTransactionsByReference(reference: string): Promise<ITransaction[]> {
        return retry(() => this.getTransactionsByReferenceFromIndexer(reference), BUSINESS_RETRY_COUNT, BUSINESS_RETRY_DELAY_MS);
    }

    /**
     * Fetches transactions by payment reference from the indexer with pagination.
     * Uses limit/offset to handle cases where there are more transactions
     * than the default page size (matching fasset-bots pattern).
     */
    private async getTransactionsByReferenceFromIndexer(reference: string): Promise<ITransaction[]> {
        const allTxs = await this.getTransactionList(reference);
        const result: ITransaction[] = [];
        for (const tx of allTxs) {
            result.push(await this.convertToITransaction(tx));
        }

        return result;
    }

    /**
     * Paginates through the indexer transaction list endpoint, fetching all
     * transactions matching the given payment reference. Each page requests
     * up to TRANSACTION_PAGE_LIMIT records; stops when a page returns fewer
     * records than the limit.
     */
    private async getTransactionList(reference: string): Promise<IndexerTransaction[]> {
        const allTxs: IndexerTransaction[] = [];
        let offset = 0;

        while (true) {
            const url = `/api/indexer/transaction?paymentReference=${reference}&returnResponse=true&limit=${TRANSACTION_PAGE_LIMIT}&offset=${offset}`;
            const response: ApiWrapper<IndexerTransaction[]> | null = await this.getWithClients(url);
            if (!response) {
                throw new Error(`Cannot retrieve transaction by reference ${reference}`);
            }

            if (response.status !== "OK") {
                throw new Error(`Cannot retrieve transaction by reference ${reference}: ${response.errorMessage || response.status}`);
            }

            if (!response.data) {
                throw new Error(`Cannot retrieve transaction by reference ${reference}`);
            }
            allTxs.push(...response.data["items"]);

            /* If fewer results than the limit, we've reached the last page */
            if (response.data["items"].length == 0) {
                break;
            }

            offset += TRANSACTION_PAGE_LIMIT;
        }

        return allTxs;
    }

    /* -------------------------------------------------------------------------- */
    /*                           TRANSACTION CONVERSION                           */
    /* -------------------------------------------------------------------------- */

    private async convertToITransaction(tx: IndexerTransaction): Promise<ITransaction> {
        return {
            hash: this.normalizeTxHash(tx.transactionId),
            inputs: await this.handleInputsOutputs(tx, true),
            outputs: await this.handleInputsOutputs(tx, false),
            reference: tx.paymentReference ? this.prefix0x(tx.paymentReference) : ZERO_BYTES32,
            status: this.successStatus(tx),
        };
    }

    private async handleInputsOutputs(data: IndexerTransaction, input: boolean): Promise<TxInputOutput[]> {
        switch (this.chainId) {
            case ChainId.BTC:
            case ChainId.DOGE:
            case ChainId.testBTC:
            case ChainId.testDOGE:
                return this.UTXOInputsOutputs(data.transactionType, data.response, input);

            case ChainId.XRP:
            case ChainId.testXRP:
                return this.XRPInputsOutputs(data, input);

            default:
                throw new Error(`Invalid SourceId: ${this.chainId}`);
        }
    }

    private UTXOInputsOutputs(type: string, data: any, input: boolean): TxInputOutput[] {
        if (input) {
            if (type === "coinbase") {
                return [["", BigInt(0)]];
            }

            const inputs: TxInputOutput[] = [];

            for (const vin of data.vin || []) {
                const address = vin.prevout?.scriptPubKey?.address || "";
                const value = this.toBnValue(vin.prevout?.value || 0);
                inputs.push([address, value]);
            }

            return inputs.length ? inputs : [["", BigInt(0)]];
        }

        const outputs: TxInputOutput[] = [];

        for (const vout of data.vout || []) {
            outputs.push([vout.scriptPubKey?.address || "", this.toBnValue(vout.value)]);
        }

        return outputs.length ? outputs : [["", BigInt(0)]];
    }

    private XRPInputsOutputs(data: IndexerTransaction, input: boolean): TxInputOutput[] {
        const response = data.response.result;

        if (input) {
            if (data.isNativePayment) {
                return [[response.Account, BigInt(response.Amount) + BigInt(response.Fee || 0)]];
            }
            return [[response.Account, BigInt(response.Fee || 0)]];
        }

        if (data.isNativePayment && this.successStatus(data) === TX_SUCCESS) {
            const metaData = response.meta || response.metaData;
            return [[response.Destination, BigInt(metaData.delivered_amount)]];
        }

        return [["", BigInt(0)]];
    }

    private successStatus(data: IndexerTransaction): number {
        if (this.isUTXOchain) {
            return TX_SUCCESS;
        }

        const response = data.response.result;
        const metaData = response.meta || response.metaData;
        const result = metaData?.TransactionResult;

        if (result === "tesSUCCESS") {
            return TX_SUCCESS;
        }

        if (result?.startsWith("tec")) {
            switch (result) {
                case "tecDST_TAG_NEEDED":
                case "tecNO_DST":
                case "tecNO_DST_INSUF_XRP":
                case "tecNO_PERMISSION":
                    return TX_BLOCKED;
                default:
                    return TX_FAILED;
            }
        }

        return TX_FAILED;
    }

    private normalizeTxHash(txhash: string): string {
        if (this.chainId === ChainId.XRP || this.chainId === ChainId.testXRP) {
            return txhash.toUpperCase();
        }
        return txhash;
    }

    /* -------------------------------------------------------------------------- */
    /*                        TRANSACTIONS BY BLOCK RANGE                         */
    /* -------------------------------------------------------------------------- */

    /**
     * Fetches all transactions in a block range from the indexer API.
     * Returns extended transaction data including destination tags and decoded memo fields
     * for identifying direct minting transactions sent to the Core Vault.
     */
    async getTransactionsByBlockRange(from: number, to: number): Promise<any[]> {
        return retry(() => this.getTransactionsByBlockRangeInner(from, to), BUSINESS_RETRY_COUNT, BUSINESS_RETRY_DELAY_MS);
    }

    private async getTransactionsByBlockRangeInner(from: number, to: number): Promise<any[]> {
        const results: any[] = [];
        let offset = 0;

        // The indexer paginates — a single unbounded request returns at most
        // one page, so we have to loop until an empty page signals the end.
        // Matches the pattern in getTransactionList() above and in fasset-bots.
        while (true) {
            const url = `/api/indexer/transaction?from=${from}&to=${to}&returnResponse=true&limit=${TRANSACTION_PAGE_LIMIT}&offset=${offset}`;
            const response: ApiWrapper<any> | null = await this.getWithClients(url);

            if (!response) {
                throw new InternalServerErrorException("Cannot get transactions by block range");
            }
            if (response.status !== "OK") {
                this.logger.error(`Indexer transactions returned status: ${response.status}, error: ${response.errorMessage}`);
                throw new InternalServerErrorException(`Transactions query failed: ${response.errorMessage || response.status}`);
            }
            if (!response.data) {
                break;
            }

            // ApiPaginated shape: { items, offset, limit, ... }.
            // Older shapes may return a bare array in `data` — tolerate both.
            const page = response.data;
            const items: any[] = Array.isArray(page) ? page : Array.isArray(page.items) ? page.items : [];
            if (items.length === 0) break;

            for (const tx of items) {
                const result = tx.response?.result;
                if (!result) continue;
                const destinationTag = result.DestinationTag?.toString() || null;
                let decodedMemo: { type: string | null; recipient?: string; executor?: string } = { type: null };

                // Try to decode FBPR direct-minting reference. Prefer the top-level
                // paymentReference that the indexer already extracts — it's the same
                // byte string as the on-chain memo but normalized by the indexer and
                // populated uniformly across tx payloads. Fall back to walking
                // result.Memos only when the top-level field is absent.
                if (!destinationTag) {
                    decodedMemo = this.decodeDirectMintingRef(tx.paymentReference);
                    if (decodedMemo.type === null) {
                        const memos = result.Memos;
                        if (memos && Array.isArray(memos)) {
                            for (const memo of memos) {
                                const memoData = memo.Memo?.MemoData;
                                if (!memoData) continue;
                                const parsed = this.decodeDirectMintingRef(memoData);
                                if (parsed.type !== null) {
                                    decodedMemo = parsed;
                                    break;
                                }
                            }
                        }
                    }
                }

                results.push({
                    transactionId: tx.transactionId,
                    sourceAddress: result.Account,
                    destinationAddress: result.Destination,
                    amount: result.Amount?.toString() || "0",
                    destinationTag,
                    decodedMemo,
                    status: this.successStatus(tx) === TX_SUCCESS ? "SUCCESS" : "FAILED",
                });
            }

            // Advance offset using the server-reported page position when available,
            // otherwise fall back to the requested offset + our limit.
            const pageOffset = typeof (page as any).offset === "number" ? (page as any).offset : offset;
            const pageLimit = typeof (page as any).limit === "number" ? (page as any).limit : TRANSACTION_PAGE_LIMIT;
            offset = pageOffset + pageLimit;

            // Fewer items than the limit means we've reached the last page.
            if (items.length < pageLimit) break;
        }

        return results;
    }

    /* -------------------------------------------------------------------------- */
    /*                                  HELPERS                                   */
    /* -------------------------------------------------------------------------- */

    private prefix0x(value: string): string {
        return value.startsWith("0x") ? value : `0x${value}`;
    }

    /**
     * Decodes a FBPR direct-minting payment reference, mirroring
     * DirectMintingFacet._decodeTarget + PaymentReference.isValid/decodeId.
     *
     * DIRECT_MINTING (32 bytes): built as toBN(addr).or(DIRECT_MINTING << 192).
     *   - type prefix = top 64 bits = 0x4642505266410018
     *   - addressNumeric = low 192 bits; MUST fit in uint160 (i.e. the 32 bits
     *     above the address are zero — bytes [8:12] all zero), otherwise on-chain
     *     falls through to smart-account minting and this is NOT a DIRECT_MINTING.
     *   - recipient = address(uint160(addressNumeric)) = bytes [12:32].
     *   - PaymentReference.isValid also requires refLowBits != 0.
     *
     * DIRECT_MINTING_EX (48 bytes, not a bytes32): packed bytes, length strictly 48.
     *   - prefix(8) = 0x4642505266410021
     *   - recipient = bytes [8:28]; on-chain requires target != address(0).
     *   - executor  = bytes [28:48].
     *
     * Accepts hex with or without the 0x prefix. Returns { type: null } for
     * anything that doesn't exactly match.
     */
    private decodeDirectMintingRef(ref: string | null | undefined): { type: string | null; recipient?: string; executor?: string } {
        if (!ref) return { type: null };
        const body = (ref.startsWith("0x") || ref.startsWith("0X") ? ref.slice(2) : ref).toLowerCase();
        const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

        // 32-byte DIRECT_MINTING
        if (body.length === 64 && body.startsWith("4642505266410018")) {
            // bytes [8:12] must be zero — otherwise addressNumeric > uint160.max on-chain,
            // which the Solidity treats as smart-account minting, not direct minting.
            if (body.slice(16, 24) !== "00000000") return { type: null };
            const recipient = "0x" + body.slice(24, 64);
            if (recipient === ZERO_ADDR) return { type: null };
            return { type: "DIRECT_MINTING", recipient };
        }
        // 48-byte DIRECT_MINTING_EX
        if (body.length === 96 && body.startsWith("4642505266410021")) {
            const recipient = "0x" + body.slice(16, 56);
            if (recipient === ZERO_ADDR) return { type: null };
            const executor = "0x" + body.slice(56, 96);
            return { type: "DIRECT_MINTING_EX", recipient, executor };
        }
        return { type: null };
    }

    private toHex(value: string | number | bigint): string {
        return "0x" + BigInt(value).toString(16);
    }

    /**
     * Converts a UTXO value (floating-point BTC/DOGE) to satoshi as bigint.
     * UTXO chain APIs return values like 0.0005 BTC; we multiply by BTC_MDU (1e8)
     * and round to get the satoshi integer representation.
     * This matches the fasset-bots pattern: Math.round(value * BTC_MDU).
     */
    private toBnValue(value: number | string): bigint {
        if (typeof value === "string") {
            /* String values (e.g. XRP drops) are already integer strings */
            return BigInt(value);
        }
        /* Numeric values from UTXO APIs are floating-point coin amounts */
        return BigInt(Math.round(value * BTC_MDU).toFixed(0));
    }
}
