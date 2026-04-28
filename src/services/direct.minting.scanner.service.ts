import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { IndexerState } from "src/entities/IndexerState";
import { DirectMinting } from "src/entities/DirectMinting";
import { logger } from "src/logger/winston.logger";
import { ContractService } from "./contract.service";
import { EthersService } from "./ethers.service";
import { FassetConfigService } from "./fasset.config.service";
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
        private readonly ethersService: EthersService
    ) {}

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

            try {
                // Normalize XRP tx hash to 0x-prefixed lowercase to match bytes32 format
                // emitted by Solidity events (e.g. DirectMintingExecuted).
                const normalizedTxHash = tx.transactionId.startsWith("0x") ? tx.transactionId.toLowerCase() : "0x" + tx.transactionId.toLowerCase();

                // Skip if we already have this transaction recorded
                const existing = await this.em.count(DirectMinting, { txhash: normalizedTxHash });
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
                } else if (tx.decodedMemo?.type === "DIRECT_MINTING") {
                    mintType = "address";
                    targetAddress = tx.decodedMemo.recipient || null;
                } else if (tx.decodedMemo?.type === "DIRECT_MINTING_EX") {
                    mintType = "address_executor";
                    targetAddress = tx.decodedMemo.recipient || null;
                } else {
                    // No tag or recognizable memo — skip
                    continue;
                }

                const directMinting = new DirectMinting(normalizedTxHash, tx.sourceAddress, targetAddress, mintType, tagId, tx.amount, timestamp, fasset);

                // Pre-calculate estimated fees so users see them immediately.
                // Formula: systemFee = max(amount * feeBIPS / 10000, minimumFeeUBA)
                // BigInt division truncates like Solidity, matching on-chain behavior.
                const receivedAmount = BigInt(tx.amount);
                const computedFee = (receivedAmount * feeBIPS) / 10000n;
                const systemFee = computedFee > minimumFeeUBA ? computedFee : minimumFeeUBA;
                directMinting.mintingFeeUBA = systemFee.toString();
                // Only executor-type mintings incur an executor fee on-chain.
                directMinting.executorFeeUBA = executorFeeUBA.toString();

                await this.em.persistAndFlush(directMinting);
            } catch (error: any) {
                // Log per-transaction errors but continue processing remaining transactions
                logger.error(`Error processing tx ${tx.transactionId} in DirectMintingScanner:`, error);
            }
        }

        // Advance the block cursor
        stateEntity.lastBlock = toBlock + 1;
        await this.em.persistAndFlush(stateEntity);
    }
}
