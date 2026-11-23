import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { IndexerState } from "src/entities/IndexerState";
import { DirectMinting } from "src/entities/DirectMinting";
import { DirectMintingRecoveryPayment } from "src/entities/DirectMintingRecoveryPayment";
import { logger } from "src/logger/winston.logger";
import { ContractService } from "./contract.service";
import { EthersService } from "./ethers.service";
import { FassetConfigService } from "./fasset.config.service";
import { getBridgeDestinationEid, getBridgeDestinationKind, SmartAccountsService } from "./smart.accounts.service";
import type { DirectMintingScanTransaction } from "./verifier.service";
import type { IIAssetManager } from "../typechain-ethers-v6";

/** How many blocks to process per verifier request. */
const BLOCK_BATCH_SIZE = 20;

/** Delay between scan cycles in milliseconds. */
const SCAN_INTERVAL_MS = 5000;

/**
 * Returns the per-fasset IndexerState key for tracking the last processed XRP block.
 * Each fasset has its own cursor to avoid one fasset skipping blocks for another.
 */
function stateKeyForFasset(fasset: string): string {
    return `directMintingLastXrpBlock_${fasset}`;
}

interface DirectMintingClassification {
    mintType: string;
    tagId: string | null;
    targetAddress: string | null;
    executorFeeUBA: bigint;
}

/**
 * Scans the XRP ledger for transactions sent to the Core Vault payment address.
 * Identifies direct minting transactions by destination tag or memo field and
 * creates DirectMinting entities to track their lifecycle.
 *
 * This is a SEPARATE service from EventReaderService — it reads from the
 * underlying-chain indexer, not from EVM logs.
 */
@Injectable()
export class DirectMintingScannerService implements OnApplicationBootstrap {
    private em: EntityManager;
    private fassetNames: string[] = [];
    /** Maps fasset → Core Vault payment address on the underlying chain. */
    private paymentAddresses = new Map<string, string>();
    private assetManagerMap = new Map<string, IIAssetManager>();

    constructor(
        private readonly orm: MikroORM,
        private readonly fassetConfigService: FassetConfigService,
        private readonly contractService: ContractService,
        private readonly ethersService: EthersService,
        private readonly configService: ConfigService,
        private readonly smartAccountsService: SmartAccountsService
    ) {}

    private isOftCandidateSource(fasset: string): boolean {
        const network = this.configService.get<string>("NETWORK");
        if (network !== "flare" && network !== "coston2") return false;
        const oftFasset = this.configService.get<string>("APP_TYPE") === "dev" ? "FTestXRP" : "FXRP";
        return fasset === oftFasset;
    }

    private normalizeTxHash(transactionId: string): string {
        return "0x" + transactionId.replace(/^0x/i, "").toLowerCase();
    }

    private buildDirectMinting(
        tx: DirectMintingScanTransaction,
        normalizedTxHash: string,
        timestamp: number,
        fasset: string,
        feeBIPS: bigint,
        minimumFeeUBA: bigint,
        classification: DirectMintingClassification
    ): DirectMinting {
        const directMinting = new DirectMinting(
            normalizedTxHash,
            tx.sourceAddress,
            classification.targetAddress,
            classification.mintType,
            classification.tagId,
            tx.amount,
            timestamp,
            fasset
        );
        const receivedAmount = BigInt(tx.amount);
        const computedFee = (receivedAmount * feeBIPS) / 10000n;
        directMinting.mintingFeeUBA = (computedFee > minimumFeeUBA ? computedFee : minimumFeeUBA).toString();
        directMinting.executorFeeUBA = classification.executorFeeUBA.toString();
        return directMinting;
    }

    private async persistOftCandidate(
        tx: DirectMintingScanTransaction,
        timestamp: number,
        fasset: string,
        feeBIPS: bigint,
        minimumFeeUBA: bigint,
        executorFeeUBA: bigint
    ): Promise<void> {
        const em = this.orm.em.fork();
        const normalizedTxHash = this.normalizeTxHash(tx.transactionId);
        if ((await em.count(DirectMinting, { fasset, txhash: normalizedTxHash })) > 0) return;

        const directMinting = this.buildDirectMinting(tx, normalizedTxHash, timestamp, fasset, feeBIPS, minimumFeeUBA, {
            mintType: "oft_candidate",
            tagId: tx.destinationTag,
            targetAddress: null,
            executorFeeUBA,
        });
        directMinting.smartStatusLastCheckedAt = Date.now();
        const smartStatus = await this.smartAccountsService.getDirectMintStatus(normalizedTxHash);
        directMinting.destinationEid = getBridgeDestinationEid(smartStatus);
        directMinting.destinationKind = getBridgeDestinationKind(smartStatus);
        await em.persistAndFlush(directMinting);
    }

    private async persistTaggedFallback(
        tx: DirectMintingScanTransaction,
        timestamp: number,
        fasset: string,
        feeBIPS: bigint,
        minimumFeeUBA: bigint,
        executorFeeUBA: bigint
    ): Promise<void> {
        const em = this.orm.em.fork();
        const normalizedTxHash = this.normalizeTxHash(tx.transactionId);
        if ((await em.count(DirectMinting, { fasset, txhash: normalizedTxHash })) > 0) return;

        let targetAddress: string | null = null;
        try {
            const tagManager = this.contractService.getMintingTagManagerContract(fasset);
            targetAddress = await tagManager.mintingRecipient(BigInt(tx.destinationTag!));
        } catch {
            // Match legacy tag handling: persist the row even if the tag cannot be resolved.
        }

        const directMinting = this.buildDirectMinting(tx, normalizedTxHash, timestamp, fasset, feeBIPS, minimumFeeUBA, {
            mintType: "tag",
            tagId: tx.destinationTag,
            targetAddress,
            executorFeeUBA,
        });
        await em.persistAndFlush(directMinting);
    }

    private async processOftCandidate(
        tx: DirectMintingScanTransaction,
        timestamp: number,
        fasset: string,
        feeBIPS: bigint,
        minimumFeeUBA: bigint,
        candidateExecutorFeeUBA: bigint,
        legacyExecutorFeeUBA: bigint
    ): Promise<void> {
        try {
            await this.persistOftCandidate(tx, timestamp, fasset, feeBIPS, minimumFeeUBA, candidateExecutorFeeUBA);
            return;
        } catch (error) {
            logger.error(`Error persisting OFT candidate ${tx.transactionId} for ${fasset}:`, error);
        }

        if (!tx.destinationTag) {
            logger.warn(`Dropping tagless OFT candidate ${tx.transactionId} for ${fasset} after candidate processing failed`);
            return;
        }

        try {
            await this.persistTaggedFallback(tx, timestamp, fasset, feeBIPS, minimumFeeUBA, legacyExecutorFeeUBA);
        } catch (error) {
            logger.error(`Dropping OFT candidate ${tx.transactionId} for ${fasset} after legacy tag fallback failed:`, error);
        }
    }

    async onApplicationBootstrap() {
        this.em = this.orm.em.fork();
        this.fassetNames = this.fassetConfigService.getFAssetNames();

        const contractNames = this.contractService.getContractNames();
        for (const fasset of this.fassetNames) {
            const key = `AssetManager_${fasset}`;
            if (!contractNames.includes(key)) continue;
            const assetManager = this.contractService.get<IIAssetManager>(key);
            this.assetManagerMap.set(fasset, assetManager);
            try {
                const paymentAddress = await assetManager.directMintingPaymentAddress();
                this.paymentAddresses.set(fasset, paymentAddress);
            } catch (error: any) {
                logger.warn(`Could not get directMintingPaymentAddress for ${fasset}: ${error?.message ?? error}`);
            }
        }

        void this.startScanning();
    }

    /**
     * Main scan loop — reads XRP blocks in batches, finds transactions sent
     * to the Core Vault address, and creates DirectMinting tracking entities.
     */
    private async startScanning(): Promise<void> {
        logger.info("Starting DirectMintingScannerService");

        while (true) {
            try {
                for (const fasset of this.fassetNames) {
                    if (!this.paymentAddresses.has(fasset)) continue;
                    await this.scanForFasset(fasset);
                }
            } catch (error) {
                logger.error("Error in DirectMintingScannerService:", error);
            }
            await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL_MS));
        }
    }

    /**
     * Scans a batch of XRP blocks for a specific fasset, looking for transactions
     * sent to its Core Vault payment address.
     */
    private async scanForFasset(fasset: string): Promise<void> {
        const verifier = this.fassetConfigService.getVerifier(fasset);
        const coreVaultAddress = this.paymentAddresses.get(fasset);
        if (!coreVaultAddress) return;

        // Get or initialize the last processed block (per-fasset cursor)
        const stateKey = stateKeyForFasset(fasset);
        let stateEntity = await this.em.findOne(IndexerState, { name: stateKey });
        if (!stateEntity) {
            const lastFinalized = await verifier.getLastFinalizedBlockNumber();
            stateEntity = new IndexerState(stateKey, lastFinalized);
            await this.em.persistAndFlush(stateEntity);
            return;
        }

        const lastFinalized = await verifier.getLastFinalizedBlockNumber();
        const fromBlock = stateEntity.lastBlock;
        if (fromBlock >= lastFinalized) return;

        const toBlock = Math.min(fromBlock + BLOCK_BATCH_SIZE - 1, lastFinalized);
        const txs = await verifier.getTransactionsByBlockRange(fromBlock, toBlock);
        const timestamp = Date.now();

        // Fetch direct minting fee parameters once per fasset per scan cycle.
        // These are on-chain constants that change infrequently, so one batch of
        // calls per cycle is sufficient rather than per-transaction.
        let feeBIPS = 0n;
        let minimumFeeUBA = 0n;
        let executorFeeUBA = 0n;
        try {
            const assetManager = this.assetManagerMap.get(fasset)!;
            [feeBIPS, minimumFeeUBA, executorFeeUBA] = await Promise.all([
                assetManager.getDirectMintingFeeBIPS(),
                assetManager.getDirectMintingMinimumFeeUBA(),
                assetManager.getDirectMintingExecutorFeeUBA(),
            ]);
        } catch (error: any) {
            // Abort this cycle so the block range is retried next time with correct fees,
            // rather than persisting entities with zero-fee defaults.
            logger.warn(`Could not fetch direct minting fee params for ${fasset}, skipping cycle: ${error?.message ?? error}`);
            return;
        }

        for (const tx of txs) {
            // Only process transactions sent TO the Core Vault address
            if (tx.destinationAddress !== coreVaultAddress) continue;
            if (tx.status !== "SUCCESS") continue;

            const decodedMemo = tx.decodedMemo;
            if (this.isOftCandidateSource(fasset) && decodedMemo.type === "RECOVERY" && "originalTxHash" in decodedMemo) {
                // Ignore duplicate inserts without resetting matched records. A failed
                // write aborts this batch so the cursor cannot skip the recovery payment.
                await this.orm.em.fork().upsert(
                    DirectMintingRecoveryPayment,
                    new DirectMintingRecoveryPayment(
                        this.normalizeTxHash(tx.transactionId),
                        this.normalizeTxHash(decodedMemo.originalTxHash),
                        tx.sourceAddress,
                        fasset,
                        timestamp
                    ),
                    { onConflictFields: ["fasset", "txhash"], onConflictAction: "ignore" }
                );
                continue;
            }

            const smartAccountMemo =
                this.isOftCandidateSource(fasset) && decodedMemo.type === "SMART_ACCOUNT" && "executorFeeUBA" in decodedMemo ? decodedMemo : null;

            if (smartAccountMemo) {
                await this.processOftCandidate(
                    tx,
                    timestamp,
                    fasset,
                    feeBIPS,
                    minimumFeeUBA,
                    smartAccountMemo.executorFeeUBA,
                    executorFeeUBA
                );
                continue;
            }

            try {
                // Normalize XRP tx hash to 0x-prefixed lowercase to match bytes32 format
                // emitted by Solidity events (e.g. DirectMintingExecuted).
                const normalizedTxHash = this.normalizeTxHash(tx.transactionId);

                // Skip if we already have this transaction recorded
                const existing = await this.em.count(DirectMinting, { fasset, txhash: normalizedTxHash });
                if (existing > 0) continue;

                let mintType = "address";
                let tagId: string | null = null;
                let targetAddress: string | null = null;

                if (tx.destinationTag) {
                    // Transaction uses a destination tag → tag-based minting
                    mintType = "tag";
                    tagId = tx.destinationTag;
                    // The MintingTagManager contract resolves tag → recipient on-chain
                    try {
                        const tagManager = this.contractService.getMintingTagManagerContract(fasset);
                        targetAddress = await tagManager.mintingRecipient(BigInt(tagId));
                    } catch {
                        // Tag may not exist in the contract — still record it
                    }
                } else if (decodedMemo.type === "DIRECT_MINTING" && "recipient" in decodedMemo) {
                    mintType = "address";
                    targetAddress = decodedMemo.recipient || null;
                } else if (decodedMemo.type === "DIRECT_MINTING_EX" && "recipient" in decodedMemo) {
                    mintType = "address_executor";
                    targetAddress = decodedMemo.recipient || null;
                } else {
                    // No tag or recognizable memo — skip
                    continue;
                }

                const directMinting = this.buildDirectMinting(tx, normalizedTxHash, timestamp, fasset, feeBIPS, minimumFeeUBA, {
                    mintType,
                    tagId,
                    targetAddress,
                    executorFeeUBA,
                });

                await this.em.persistAndFlush(directMinting);
            } catch (error: any) {
                logger.error(`Error processing tx ${tx.transactionId} in DirectMintingScanner:`, error);
            }
        }

        // Advance the block cursor
        stateEntity.lastBlock = toBlock + 1;
        await this.em.persistAndFlush(stateEntity);
    }
}
