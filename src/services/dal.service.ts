import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { ContractTransactionReceipt } from "ethers";
import { ContractService } from "./contract.service";
import { EthersService } from "./ethers.service";
import type { IRelay } from "../typechain-ethers-v6/flare-smart-contracts-v2/contracts/userInterfaces/IRelay";
import type { IFdcHub } from "../typechain-ethers-v6/flare-smart-contracts-v2/contracts/userInterfaces/IFdcHub";
import type { IFdcVerification } from "../typechain-ethers-v6/flare-smart-contracts-v2/contracts/userInterfaces/IFdcVerification";
import { IFdcRequestFeeConfigurations__factory } from "../typechain-ethers-v6";
import { retry } from "../utils/retry";

/* -------------------------------------------------------------------------- */
/*                                   TYPES                                    */
/* -------------------------------------------------------------------------- */

export interface AttestationRequestId {
    round: number;
    data: string;
}

export interface AttestationProof {
    merkleProof: string[];
    data: Record<string, any>;
}

export enum AttestationNotProved {
    NOT_FINALIZED = "NOT_FINALIZED",
    DISPROVED = "DISPROVED",
}

export type OptionalAttestationProof = AttestationProof | AttestationNotProved;

export interface FspStatusResult {
    active: FspLatestRoundResult;
    latest_fdc: FspLatestRoundResult;
    latest_ftso: FspLatestRoundResult;
}

export interface FspLatestRoundResult {
    voting_round_id: number | string;
    start_timestamp: number | string;
}

interface VotingRoundResult {
    response: Record<string, any>;
    proof: string[];
}

/* -------------------------------------------------------------------------- */
/*                                 CONSTANTS                                  */
/* -------------------------------------------------------------------------- */

const FDC_PROTOCOL_ID = 200;

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Bytes32-encoded attestation type identifiers used to dispatch proof verification. */
const ATTESTATION_TYPE_PAYMENT = "0x5061796d656e7400000000000000000000000000000000000000000000000000";
const ATTESTATION_TYPE_REFERENCED_PAYMENT_NONEXISTENCE = "0x5265666572656e6365645061796d656e744e6f6e6578697374656e6365000000";
const ATTESTATION_TYPE_CONFIRMED_BLOCK_HEIGHT_EXISTS = "0x436f6e6669726d6564426c6f636b486569676874457869737473000000000000";
const ATTESTATION_TYPE_BALANCE_DECREASING_TRANSACTION = "0x42616c616e636544656372656173696e675472616e73616374696f6e00000000";
const ATTESTATION_TYPE_ADDRESS_VALIDITY = "0x4164647265737356616c69646974790000000000000000000000000000000000";

/** Number of business-logic level retries for proof and submission operations. */
const BUSINESS_RETRY_COUNT = 3;
const BUSINESS_RETRY_DELAY_MS = 2000;

/** Hard kill timeout for multi-client races (matches fasset-bots DEFAULT_KILL_AFTER). */
const MULTI_CLIENT_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/*                               SERVICE CLASS                                */
/* -------------------------------------------------------------------------- */

@Injectable()
export class DalService implements OnModuleInit {
    private readonly logger = new Logger(DalService.name);
    private readonly clients: { url: string; client: AxiosInstance }[] = [];

    private relay: IRelay;
    private fdcHub: IFdcHub;
    private fdcVerification: IFdcVerification;

    constructor(
        private readonly configService: ConfigService,
        private readonly contractService: ContractService,
        private readonly ethersService: EthersService
    ) {
        // Use ConfigService instead of process.env for consistency with other services
        const urls = (this.configService.get<string>("DAL_URLS") || "")
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean);
        const apiKeys = (this.configService.get<string>("DAL_API_KEY") || "").split(",").map((k) => k.trim());

        if (!urls.length) {
            throw new Error("DAL_URLS not configured");
        }

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

    onModuleInit() {
        this.relay = this.contractService.get<IRelay>("Relay");
        this.fdcHub = this.contractService.get<IFdcHub>("FdcHub");
        this.fdcVerification = this.contractService.get<IFdcVerification>("FdcVerification");
    }

    /* -------------------------------------------------------------------------- */
    /*                                 HTTP CORE                                  */
    /* -------------------------------------------------------------------------- */

    /**
     * Races a POST request across all DAL clients, returning the first successful response.
     * Uses AbortController to cancel remaining requests once one succeeds, and a hard kill
     * timeout (MULTI_CLIENT_TIMEOUT_MS) to prevent unbounded waits when all servers are slow.
     */
    private async postWithClients<T = any>(endpoint: string, body?: any): Promise<T | null> {
        const controller = new AbortController();
        const killTimeout = setTimeout(() => controller.abort(), MULTI_CLIENT_TIMEOUT_MS);

        try {
            const result = await Promise.any(
                this.clients.map(({ client }) => client.post<T>(endpoint, body, { signal: controller.signal }).then((r) => r.data))
            );
            controller.abort();
            return result;
        } catch {
            this.logger.error(`All DAL clients failed for POST ${endpoint}`);
            return null;
        } finally {
            clearTimeout(killTimeout);
        }
    }

    /**
     * Races a GET request across all DAL clients, returning the first successful response.
     * Uses AbortController to cancel remaining requests once one succeeds, and a hard kill
     * timeout (MULTI_CLIENT_TIMEOUT_MS) to prevent unbounded waits when all servers are slow.
     */
    private async getWithClients<T = any>(endpoint: string): Promise<T | null> {
        const controller = new AbortController();
        const killTimeout = setTimeout(() => controller.abort(), MULTI_CLIENT_TIMEOUT_MS);

        try {
            const result = await Promise.any(this.clients.map(({ client }) => client.get<T>(endpoint, { signal: controller.signal }).then((r) => r.data)));
            controller.abort();
            return result;
        } catch {
            this.logger.error(`All DAL clients failed for GET ${endpoint}`);
            return null;
        } finally {
            clearTimeout(killTimeout);
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                              ROUND HELPERS                                 */
    /* -------------------------------------------------------------------------- */

    async roundFinalized(round: number): Promise<boolean> {
        try {
            const latestRound = await this.latestFinalizedRound();
            return round <= latestRound;
        } catch (error: any) {
            this.logger.error(`Error checking round finalization: ${error.message}`);
            return false;
        }
    }

    private async roundFinalizedOnChain(round: number): Promise<boolean> {
        try {
            const merkleRoot = await this.relay.merkleRoots(FDC_PROTOCOL_ID, round);
            return merkleRoot !== ZERO_BYTES32;
        } catch (error: any) {
            this.logger.error(`Error checking on-chain round finalization: ${error.message}`);
            return false;
        }
    }

    async latestFinalizedRound(): Promise<number> {
        const latestRound = await this.latestFinalizedRoundOnDal();
        const finalized = await this.roundFinalizedOnChain(latestRound);
        return finalized ? latestRound : latestRound - 1;
    }

    /**
     * Queries all DAL clients for their latest FDC round and returns the maximum.
     * Throws if no clients respond successfully (matching fasset-bots pattern).
     */
    private async latestFinalizedRoundOnDal(): Promise<number> {
        const results = await Promise.allSettled(
            this.clients.map(({ client }) => client.get<FspStatusResult>("/api/v0/fsp/status").then((r) => Number(r.data.latest_fdc.voting_round_id)))
        );

        let latestRound = -1;
        for (const result of results) {
            if (result.status === "fulfilled") {
                latestRound = Math.max(latestRound, result.value);
            }
        }

        if (latestRound < 0) {
            throw new Error("No data access layer clients available for obtaining latest round");
        }

        return latestRound;
    }

    /* -------------------------------------------------------------------------- */
    /*                           PER-CLIENT ROUND CHECK                           */
    /* -------------------------------------------------------------------------- */

    /**
     * Checks whether a specific DAL client has data for the requested round
     * by querying its /api/v0/fsp/status endpoint. This avoids unnecessary
     * proof requests to clients that haven't finalized the round yet.
     */
    private async clientHasRound(client: AxiosInstance, url: string, roundId: number): Promise<boolean> {
        try {
            const response = await client.get<FspStatusResult>("/api/v0/fsp/status");
            const clientRound = Number(response.data.latest_fdc.voting_round_id);
            if (clientRound < roundId) {
                this.logger.warn(`DAL client ${url} latest round ${clientRound} < requested round ${roundId}, skipping`);
                return false;
            }
            return true;
        } catch (error: any) {
            this.logger.warn(`Failed to check round status on ${url}: ${error.message}`);
            return false;
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                          ON-CHAIN PROOF VERIFICATION                       */
    /* -------------------------------------------------------------------------- */

    /**
     * Verifies a proof on-chain by dispatching to the appropriate FdcVerification
     * contract method based on the attestationType in the proof data.
     * Returns true if the proof is valid, false otherwise.
     * This matches the fasset-bots pattern where every proof from a DAL client
     * is verified before being returned to the caller.
     */
    async verifyProof(proofData: AttestationProof): Promise<boolean> {
        try {
            const attestationType = proofData.data?.attestationType;
            const proof = { merkleProof: proofData.merkleProof, data: proofData.data };

            switch (attestationType) {
                case ATTESTATION_TYPE_PAYMENT:
                    return await this.fdcVerification.verifyPayment(proof as any);

                case ATTESTATION_TYPE_REFERENCED_PAYMENT_NONEXISTENCE:
                    return await this.fdcVerification.verifyReferencedPaymentNonexistence(proof as any);

                case ATTESTATION_TYPE_CONFIRMED_BLOCK_HEIGHT_EXISTS:
                    return await this.fdcVerification.verifyConfirmedBlockHeightExists(proof as any);

                case ATTESTATION_TYPE_BALANCE_DECREASING_TRANSACTION:
                    return await this.fdcVerification.verifyBalanceDecreasingTransaction(proof as any);

                case ATTESTATION_TYPE_ADDRESS_VALIDITY:
                    return await this.fdcVerification.verifyAddressValidity(proof as any);

                default:
                    this.logger.error(`Unknown attestation type: ${attestationType}`);
                    return false;
            }
        } catch (error: any) {
            this.logger.error(`On-chain proof verification failed: ${error.message}`);
            return false;
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                              OBTAIN PROOF                                  */
    /* -------------------------------------------------------------------------- */

    /**
     * Obtains a proof for the given round and request bytes, with business-logic
     * level retry. Checks each client's round availability before requesting,
     * and verifies returned proofs on-chain before accepting them.
     */
    async obtainProof(roundId: number, requestBytes: string): Promise<OptionalAttestationProof> {
        return retry(() => this.obtainProofInner(roundId, requestBytes), BUSINESS_RETRY_COUNT, BUSINESS_RETRY_DELAY_MS);
    }

    /** Inner implementation of obtainProof, wrapped by retry logic. */
    private async obtainProofInner(roundId: number, requestBytes: string): Promise<OptionalAttestationProof> {
        try {
            const roundFinalized = await this.roundFinalizedOnChain(roundId);
            if (!roundFinalized) {
                return AttestationNotProved.NOT_FINALIZED;
            }

            let disproved = 0;

            for (const { client, url } of this.clients) {
                /* Check if this client has data for the requested round before fetching */
                const hasRound = await this.clientHasRound(client, url, roundId);
                if (!hasRound) {
                    continue;
                }

                const proof = await this.obtainProofFromClient(client, url, roundId, requestBytes);

                if (proof === null) {
                    continue;
                }

                if (proof === AttestationNotProved.NOT_FINALIZED) {
                    return AttestationNotProved.NOT_FINALIZED;
                }

                if (!this.attestationProved(proof)) {
                    disproved++;
                    continue;
                }

                /* Verify the proof on-chain before returning it */
                const verified = await this.verifyProof(proof);
                if (!verified) {
                    this.logger.warn(`Proof from ${url} failed on-chain verification for round ${roundId}`);
                    continue;
                }

                return proof;
            }

            if (disproved > 0) {
                return AttestationNotProved.DISPROVED;
            }

            this.logger.error(`Cannot obtain proof for round ${roundId} and request bytes ${requestBytes}`);
            throw new Error("There aren't any working attestation providers");
        } catch (error: any) {
            this.logger.error(`Error obtaining proof for round ${roundId}: ${error.message}`);
            throw error;
        }
    }

    private async obtainProofFromClient(
        client: AxiosInstance,
        url: string,
        roundId: number,
        requestBytes: string
    ): Promise<AttestationProof | AttestationNotProved | null> {
        const request = { votingRoundId: roundId, requestBytes };

        try {
            const response = await client.post<VotingRoundResult>("/api/v0/fdc/get-proof-round-id-bytes", request);
            const proof: AttestationProof = {
                data: response.data.response,
                merkleProof: response.data.proof,
            };
            return proof;
        } catch (error: any) {
            if (error.response?.status === 400) {
                const errorData = error.response?.data;
                this.logger.error(`Request not proved on ${url}: ${errorData?.error || "unknown error"}`);
                return AttestationNotProved.DISPROVED;
            }
            this.logger.error(`Error obtaining proof from ${url}: ${error.message}`);
            return null;
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                       SUBMIT REQUEST TO FDC                                */
    /* -------------------------------------------------------------------------- */

    /**
     * Submits an attestation request to the Flare Data Connector with
     * business-logic level retry around the entire submission flow.
     */
    async submitRequestToFlareDataConnector(abiEncodedRequest: string): Promise<AttestationRequestId> {
        return retry(() => this.submitRequestInner(abiEncodedRequest), BUSINESS_RETRY_COUNT, BUSINESS_RETRY_DELAY_MS);
    }

    /** Inner implementation of submitRequestToFlareDataConnector, wrapped by retry logic. */
    private async submitRequestInner(abiEncodedRequest: string): Promise<AttestationRequestId> {
        try {
            const fdcFeeConfigAddress = await this.fdcHub.fdcRequestFeeConfigurations();
            const signer = this.ethersService.getSigner();
            const fdcFeeConfig = IFdcRequestFeeConfigurations__factory.connect(fdcFeeConfigAddress, signer);

            const requestFee = await fdcFeeConfig.getRequestFee(abiEncodedRequest);

            const tx = await this.fdcHub.requestAttestation(abiEncodedRequest, { value: requestFee });
            const receipt: ContractTransactionReceipt | null = await tx.wait();

            if (!receipt) {
                throw new Error("Transaction receipt is null");
            }

            const txHash = receipt.hash;
            this.logger.log(`Submitted proof request, txhash: ${txHash}`);

            const block = await this.ethersService.getProvider().getBlock(receipt.blockNumber);
            if (!block) {
                throw new Error("Block not found for transaction receipt");
            }

            const roundId = await this.relay.getVotingRoundId(block.timestamp);

            this.logger.log(`Submitted proof request for abi encoded request: ${abiEncodedRequest}, txhash: ${txHash}, round id: ${roundId}`);

            return {
                round: Number(roundId),
                data: abiEncodedRequest,
            };
        } catch (error: any) {
            this.logger.error(`Error submitting request to FDC: ${error.message}`);
            throw error;
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                                 HELPERS                                    */
    /* -------------------------------------------------------------------------- */

    attestationProved(proof: OptionalAttestationProof | null | undefined): proof is AttestationProof {
        return typeof proof === "object" && proof !== null;
    }
}
