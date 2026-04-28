/* eslint-disable @typescript-eslint/no-explicit-any */
import { Minting } from "../entities/Minting";
import { Redemption } from "../entities/Redemption";
import { DirectMinting, DirectMintingStatus } from "../entities/DirectMinting";
import { DirectMintingExecutedEvent } from "../entities/DirectMintingExecutedEvent";
import { DirectMintingExecutedToSmartAccountEvent } from "../entities/DirectMintingExecutedToSmartAccountEvent";
import { DirectMintingPaymentTooSmallForFeeEvent } from "../entities/DirectMintingPaymentTooSmallForFeeEvent";
import { DirectMintingDelayedEvent } from "../entities/DirectMintingDelayedEvent";
import { LargeDirectMintingDelayedEvent } from "../entities/LargeDirectMintingDelayedEvent";
import { RedemptionWithTagRequestedEvent, RedemptionWithTagStatus } from "../entities/RedemptionWithTagRequestedEvent";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { dateStringToTimestamp } from "src/utils/utils";
import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { RedeemData } from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { MintingDefaultEvent } from "src/entities/MintingDefaultEvent";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { TEN_MINUTES } from "src/utils/constants";
import { RedemptionBlocked } from "src/entities/RedemptionBlockedEvent";
import { RedemptionDefaultEvent as RedemptionDefaultEventEntity } from "src/entities/RedemptionDefaultEvent";
import { EthersService } from "./ethers.service";
import { ContractService } from "./contract.service";
import { DalService, AttestationNotProved, AttestationProof, OptionalAttestationProof } from "./dal.service";
import { ITransaction } from "./verifier.service";
import { FassetConfigService } from "./fasset.config.service";
import { IIAssetManager__factory } from "../typechain-ethers-v6";
import { MintingFacet__factory } from "../typechain-ethers-v6/factories/contracts/assetManager/facets/MintingFacet__factory";
import { RedemptionDefaultsFacet__factory } from "../typechain-ethers-v6/factories/contracts/assetManager/facets/RedemptionDefaultsFacet__factory";
import type { IIAssetManager } from "../typechain-ethers-v6";
import type { IWNat } from "../typechain-ethers-v6";
import { Interface, ContractTransactionReceipt } from "ethers";

/* -------------------------------------------------------------------------- */
/*                                 CONSTANTS                                  */
/* -------------------------------------------------------------------------- */

const MAX_TX_RETRIES = 3;

/** Escalating gas buffer percentages for each retry attempt (130% → 140% → 150%) */
const GAS_BUFFER_PERCENTS = [130n, 140n, 150n];

/* -------------------------------------------------------------------------- */
/*                                   TYPES                                    */
/* -------------------------------------------------------------------------- */

enum RedemptionStatus {
    EXPIRED = "EXPIRED",
    SUCCESS = "SUCCESS",
    DEFAULT = "DEFAULT",
    PENDING = "PENDING",
}

/* -------------------------------------------------------------------------- */
/*                               SERVICE CLASS                                */
/* -------------------------------------------------------------------------- */

@Injectable()
export class RunnerService implements OnApplicationBootstrap {
    private em: EntityManager;
    private assetManagerMap = new Map<string, IIAssetManager>();
    private fassetNames: string[] = [];
    private executorAddress: string;
    private iface: Interface;

    constructor(
        private readonly orm: MikroORM,
        private readonly ethersService: EthersService,
        private readonly contractService: ContractService,
        private readonly dalService: DalService,
        private readonly fassetConfigService: FassetConfigService
    ) {
        // Merge ABIs from IIAssetManager and the facets that define minting/redemption custom errors.
        // IIAssetManager alone does not include facet-level errors (e.g. InvalidCrtId, InvalidRedemptionStatus),
        // so parseError() would fail to decode them, causing infinite retry loops.
        const combinedAbi = [
            ...IIAssetManager__factory.abi,
            ...MintingFacet__factory.abi.filter((f) => f.type === "error"),
            ...RedemptionDefaultsFacet__factory.abi.filter((f) => f.type === "error"),
        ];
        this.iface = new Interface(combinedAbi);
    }

    async onApplicationBootstrap() {
        this.em = this.orm.em.fork();
        this.executorAddress = this.ethersService.getExecutorAddress();
        this.fassetNames = this.fassetConfigService.getFAssetNames();

        const contractNames = this.contractService.getContractNames();
        for (const fasset of this.fassetNames) {
            const deploymentKey = `AssetManager_${fasset}`;
            if (contractNames.includes(deploymentKey)) {
                this.assetManagerMap.set(fasset, this.contractService.get<IIAssetManager>(deploymentKey));
            }
        }

        void this.startProcessing();
    }

    /* ---------------------------------------------------------------------- */
    /*                            MAIN LOOP                                   */
    /* ---------------------------------------------------------------------- */

    async startProcessing() {
        logger.info(`Starting runner.service`);
        let lastRun = 0;
        while (true) {
            try {
                const now = Date.now();
                for (const fasset of this.fassetNames) {
                    //TODO: make this in parallel for each fasset (when mysql will be used)
                    await this.processMintings(fasset);
                    await this.processRedemptions(fasset);
                    await this.processDirectMintings(fasset);
                    await this.processRedemptionsWithTag(fasset);
                    //TODO: FIX this if multiple fassets.
                    if (now - lastRun >= TEN_MINUTES) {
                        await this.withdrawWNAT();
                        lastRun = now;
                    }
                }
            } catch (error) {
                logger.error(`Starting runner.service run into error`, error);
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    /* ---------------------------------------------------------------------- */
    /*                        CONTRACT INTERACTIONS                            */
    /* ---------------------------------------------------------------------- */

    /**
     * Execute a minting on the AssetManager contract with retry + gas escalation.
     * Returns the tx receipt on success.
     */
    private async executeMinting(fasset: string, proof: AttestationProof, collateralReservationId: string): Promise<ContractTransactionReceipt> {
        const assetManager = this.getAssetManager(fasset);
        // The proof data comes from DAL and matches the on-chain struct at runtime
        const proofStruct = { merkleProof: proof.merkleProof, data: proof.data } as any;
        return this.sendTransactionWithRetry(
            () => assetManager.executeMinting.estimateGas(proofStruct, collateralReservationId),
            (gasLimit) => assetManager.executeMinting(proofStruct, collateralReservationId, { gasLimit })
        );
    }

    /**
     * Withdraw any wrapped native tokens (WNAT) accumulated from executor fees.
     */
    private async withdrawWNAT() {
        try {
            const wNat = this.contractService.get<IWNat>("WNat");
            const balance = await wNat.balanceOf(this.executorAddress);
            if (balance > 0n) {
                await this.sendTransactionWithRetry(
                    () => wNat.withdraw.estimateGas(balance),
                    (gasLimit) => wNat.withdraw(balance, { gasLimit })
                );
            }
        } catch (error) {
            logger.error(`Error in withdrawWNAT:`, error);
        }
    }

    /* ---------------------------------------------------------------------- */
    /*                      TRANSACTION RETRY HELPER                          */
    /* ---------------------------------------------------------------------- */

    /**
     * Sends a contract transaction with up to MAX_TX_RETRIES attempts.
     * Re-estimates gas on each attempt with an escalating buffer (130% → 140% → 150%).
     * Contract reverts are thrown immediately (more gas won't help).
     * Network/nonce issues are retried with increasing backoff.
     */
    private async sendTransactionWithRetry(
        estimateGasFn: () => Promise<bigint>,
        sendFn: (gasLimit: bigint) => Promise<{ wait: () => Promise<ContractTransactionReceipt | null> }>
    ): Promise<ContractTransactionReceipt> {
        let lastError: any;

        for (let attempt = 1; attempt <= MAX_TX_RETRIES; attempt++) {
            try {
                const gasEstimate = await estimateGasFn();
                const bufferPercent = GAS_BUFFER_PERCENTS[attempt - 1] ?? GAS_BUFFER_PERCENTS[GAS_BUFFER_PERCENTS.length - 1];
                const gasLimit = (gasEstimate * bufferPercent) / 100n;
                const tx = await sendFn(gasLimit);
                const receipt = await tx.wait();
                if (!receipt) {
                    throw new Error("Transaction receipt is null");
                }
                return receipt;
            } catch (error: any) {
                lastError = error;
                logger.warn(`Transaction attempt ${attempt}/${MAX_TX_RETRIES} failed: ${error.message}`);

                // Only retry if it looks like a gas/nonce/network issue, not a revert
                const isRevert = this.isContractRevert(error);
                if (isRevert) {
                    // Contract reverts won't succeed with more gas, throw immediately
                    throw error;
                }

                if (attempt < MAX_TX_RETRIES) {
                    // Brief delay before retry
                    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
                }
            }
        }
        throw lastError;
    }

    /**
     * Check if an error is a contract revert (custom error or require failure).
     * These should not be retried since more gas won't help.
     */
    private isContractRevert(error: any): boolean {
        // ethers v6 revert indicators
        if (error?.code === "CALL_EXCEPTION") return true;
        if (error?.code === "ACTION_REJECTED") return true;
        const revertData = error?.data ?? error?.error?.data ?? error?.info?.error?.data;
        if (revertData && typeof revertData === "string" && revertData.startsWith("0x")) return true;
        // Check for common revert message patterns
        const msg = error?.message ?? "";
        if (msg.includes("execution reverted") || msg.includes("revert")) return true;
        return false;
    }

    /* ---------------------------------------------------------------------- */
    /*                        CUSTOM ERROR DECODING                           */
    /* ---------------------------------------------------------------------- */

    /**
     * Checks if an error from a contract call contains one of the specified
     * custom error names. Works with ethers v6 revert data.
     */
    private errorIncluded(error: any, errorNames: string[]): boolean {
        try {
            // ethers v6 attaches revert data in various ways
            const revertData = error?.data ?? error?.error?.data ?? error?.info?.error?.data;
            if (revertData && typeof revertData === "string") {
                const parsed = this.iface.parseError(revertData);
                if (parsed && errorNames.includes(parsed.name)) {
                    return true;
                }
            }
            // Fallback: check error message string for the error name
            const message = error?.message ?? error?.reason ?? "";
            for (const name of errorNames) {
                if (message.includes(name)) {
                    return true;
                }
            }
        } catch {
            // If parsing fails, fall through to message check
            const message = error?.message ?? error?.reason ?? "";
            for (const name of errorNames) {
                if (message.includes(name)) {
                    return true;
                }
            }
        }
        return false;
    }

    /* ---------------------------------------------------------------------- */
    /*                       UNDERLYING CHAIN HELPERS                         */
    /* ---------------------------------------------------------------------- */

    /**
     * Check if a transaction exists on the underlying chain by its hash.
     * Returns the transaction or null.
     */
    private async getUnderlyingTransaction(fasset: string, txHash: string): Promise<ITransaction | null> {
        try {
            return await this.fassetConfigService.getVerifier(fasset).getTransaction(txHash);
        } catch {
            return null;
        }
    }

    /**
     * Find a specific transaction in a list that sends at least `amountUBA`
     * to the given `underlyingAddress`.
     */
    private getSpecificTransaction(txs: ITransaction[], underlyingAddress: string, amountUBA: bigint): ITransaction | null {
        for (const tx of txs) {
            const amount = tx.outputs.filter((o) => o[0] === underlyingAddress).reduce((sum, o) => sum + o[1], 0n);
            if (amount >= amountUBA) {
                return tx;
            }
        }
        return null;
    }

    /* ---------------------------------------------------------------------- */
    /*                       ATTESTATION HELPERS                              */
    /* ---------------------------------------------------------------------- */

    /**
     * Request a payment proof via verifier + FDC.
     * Replaces attestationProvider.requestPaymentProof.
     */
    private async requestPaymentProof(fasset: string, txHash: string): Promise<{ round: number; data: string }> {
        const abiEncodedRequest = await this.fassetConfigService.getVerifier(fasset).getPaymentEncodedRequest(txHash);
        return this.dalService.submitRequestToFlareDataConnector(abiEncodedRequest);
    }

    /* ---------------------------------------------------------------------- */
    /*                         HELPER GETTERS                                 */
    /* ---------------------------------------------------------------------- */

    private getAssetManager(fasset: string): IIAssetManager {
        const am = this.assetManagerMap.get(fasset);
        if (!am) {
            throw new Error(`AssetManager not found for fasset ${fasset}`);
        }
        return am;
    }

    /* ---------------------------------------------------------------------- */
    /*                         PROCESS MINTINGS                               */
    /* ---------------------------------------------------------------------- */

    private async processMintings(fasset: string) {
        //TODO fix query to get unprocessed mintings younger than 1 day.
        const mintings = await this.em.find(Minting, { processed: false, fasset: fasset }, { orderBy: { id: "ASC" } });
        const time = Date.now();
        for (const minting of mintings) {
            try {
                if (minting == null) {
                    continue;
                }
                const defaultEvent = await this.em.findOne(MintingDefaultEvent, {
                    collateralReservationId: minting.collateralReservationId,
                });
                if (defaultEvent) {
                    minting.processed = true;
                    await this.em.persistAndFlush(minting);
                }
                if (minting.txhash == null) {
                    if (time - minting.timestamp > 1000 * 60 * 60 * 24) {
                        minting.processed = true;
                        await this.em.persistAndFlush(minting);
                        continue;
                    }
                    const underlyingPayment = await this.em.findOne(UnderlyingPayment, {
                        paymentReference: minting.paymentReference,
                    });
                    if (!underlyingPayment) {
                        const crt = await this.em.findOne(CollateralReservationEvent, {
                            paymentReference: minting.paymentReference,
                        });
                        if (!crt) {
                            continue;
                        }
                        const txs = await this.fassetConfigService.getVerifier(fasset).getTransactionsByReference(minting.paymentReference);
                        if (txs.length == 0) {
                            continue;
                        }
                        const amount = BigInt(crt.feeUBA) + BigInt(crt.valueUBA);
                        const transaction = this.getSpecificTransaction(txs, minting.paymentAddress, amount);
                        if (!transaction) {
                            continue;
                        }
                        minting.txhash = transaction.hash;
                        await this.em.persistAndFlush(minting);
                    } else {
                        minting.txhash = underlyingPayment.underlyingHash;
                        await this.em.persistAndFlush(minting);
                    }
                }
                if (minting.state == false) {
                    try {
                        const tx = await this.getUnderlyingTransaction(fasset, minting.txhash);
                        if (tx == null) {
                            if (time - minting.timestamp > 1000 * 60 * 60 * 24) {
                                minting.processed = true;
                                await this.em.persistAndFlush(minting);
                                continue;
                            }
                            continue;
                        }
                    } catch (error) {
                        logger.error(`Error in processMintings (get transaction):`, error);
                        continue;
                    }
                    let request: { round: number; data: string } | null = null;
                    if (fasset.includes("BTC") || fasset.includes("DOGE")) {
                        try {
                            request = await this.requestPaymentProof(fasset, minting.txhash);
                        } catch (error) {
                            logger.error(`Error in processMintings (request payment proof):`, error);
                            continue;
                        }
                    } else {
                        try {
                            request = await this.requestPaymentProof(fasset, minting.txhash);
                        } catch (error) {
                            logger.error(`Error in processMintings (request payment proof):`, error);
                            if (error.message?.includes("not used in transaction")) {
                                minting.txhash = null;
                                await this.em.persistAndFlush(minting);
                                await this.em.nativeDelete(UnderlyingPayment, {
                                    paymentReference: minting.paymentReference,
                                });
                            }
                            continue;
                        }
                    }
                    if (request) {
                        minting.state = true;
                        minting.proofRequestData = request.data;
                        minting.proofRequestRound = request.round;
                        await this.em.persistAndFlush(minting);
                    } else {
                        continue;
                    }
                }
                if (minting.state == true) {
                    try {
                        let proof: OptionalAttestationProof;
                        try {
                            proof = await this.dalService.obtainProof(minting.proofRequestRound, minting.proofRequestData);
                        } catch (error) {
                            if (error.message?.includes("There aren't any working attestation providers")) {
                                if (await this.dalService.roundFinalized(minting.proofRequestRound)) {
                                    minting.state = false;
                                    minting.proofRequestData = null;
                                    minting.proofRequestRound = null;
                                }
                                logger.error(`Error in processMintings (obtainPaymentProof):`, error);
                            }
                            continue;
                        }
                        if (proof === AttestationNotProved.NOT_FINALIZED) {
                            if (await this.dalService.roundFinalized(minting.proofRequestRound)) {
                                proof = await this.dalService.obtainProof(minting.proofRequestRound, minting.proofRequestData);
                                if (this.dalService.attestationProved(proof)) {
                                    continue;
                                }
                                minting.state = false;
                                minting.proofRequestData = null;
                                minting.proofRequestRound = null;
                                await this.em.persistAndFlush(minting);
                            }
                            continue;
                        }
                        if (proof === AttestationNotProved.DISPROVED) {
                            minting.proved = true;
                            minting.processed = true;
                            await this.em.persistAndFlush(minting);
                            continue;
                        }
                        if (this.dalService.attestationProved(proof)) {
                            minting.proved = true;
                            await this.em.persistAndFlush(minting);
                            try {
                                await this.executeMinting(fasset, proof as AttestationProof, minting.collateralReservationId);
                                minting.processed = true;
                                await this.em.persistAndFlush(minting);
                            } catch (error) {
                                logger.error(`Error in processMintings (executeMinting):`, error);
                                if (this.errorIncluded(error, ["InvalidCrtId"])) {
                                    minting.processed = true;
                                    await this.em.persistAndFlush(minting);
                                }
                                if (this.errorIncluded(error, ["InvalidMintingReference"])) {
                                    minting.processed = true;
                                    await this.em.persistAndFlush(minting);
                                }
                                if (this.errorIncluded(error, ["MintingPaymentTooOld"])) {
                                    minting.processed = true;
                                    await this.em.persistAndFlush(minting);
                                }
                                if (this.errorIncluded(error, ["PaymentFailed"])) {
                                    minting.processed = true;
                                    await this.em.persistAndFlush(minting);
                                }
                                continue;
                            }
                        } else {
                            //Check if round+1 is finalized. If it is retry with payment proof
                            if (await this.dalService.roundFinalized(minting.proofRequestRound)) {
                                minting.state = false;
                                minting.proofRequestData = null;
                                minting.proofRequestRound = null;
                                await this.em.persistAndFlush(minting);
                            }
                            logger.info("Cannot obtain proof at this round, retrying");
                            continue;
                        }
                    } catch (error) {
                        logger.error(`Error in processMintings (proof):`, error);
                        continue;
                    }
                } else {
                    continue;
                }
            } catch (error) {
                logger.error(`Error in processMintings:`, error);
                continue;
            }
        }
    }

    /* ---------------------------------------------------------------------- */
    /*                       PROCESS REDEMPTIONS                              */
    /* ---------------------------------------------------------------------- */

    /**
     * Passively observes unprocessed redemptions and updates their status.
     * Does NOT execute defaults on-chain — another system/executor handles that.
     * Checks for: underlying payment, default events, blocked events, and expiry.
     */
    private async processRedemptions(fasset: string) {
        const redemptions = await this.em.find(Redemption, { processed: false, fasset: fasset }, { orderBy: { id: "ASC" } });
        const time = Date.now();

        for (const redemption of redemptions) {
            try {
                if (redemption == null) {
                    continue;
                }

                // Safety check: mark as processed if close to expiry (within 5 days of validUntil)
                if (time > redemption.validUntil - 5 * 24 * 60 * 60 * 1000) {
                    redemption.processed = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }

                // Check if the underlying payment was made via verifier
                const verifier = this.fassetConfigService.getVerifier(fasset);
                const txs = await verifier.getTransactionsByReference(redemption.paymentReference);
                const amountUBA = BigInt(redemption.amountUBA);
                let paymentFound = false;
                for (const tx of txs) {
                    const outputAmount = tx.outputs
                        .filter((o: [string, bigint]) => o[0] === redemption.underlyingAddress)
                        .reduce((sum: bigint, o: [string, bigint]) => sum + o[1], 0n);
                    if (outputAmount >= amountUBA) {
                        paymentFound = true;
                        break;
                    }
                }

                if (paymentFound) {
                    redemption.processed = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }

                // Check for default event (from chain events imported by event reader)
                const defaultEvent = await this.em.findOne(RedemptionDefaultEventEntity, {
                    requestId: redemption.requestId,
                });
                if (defaultEvent) {
                    redemption.processed = true;
                    redemption.defaulted = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }

                // Check for blocked event
                const blockedEvent = await this.em.findOne(RedemptionBlocked, {
                    requestId: redemption.requestId,
                });
                if (blockedEvent) {
                    redemption.processed = true;
                    redemption.blocked = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }

                // Still in progress — nothing to do, will check again next iteration
            } catch (error) {
                logger.error(`Error in processRedemptions for requestId ${redemption.requestId}:`, error);
                continue;
            }
        }
    }

    /* ---------------------------------------------------------------------- */
    /*                     REDEMPTION STATUS HELPERS                          */
    /* ---------------------------------------------------------------------- */

    /**
     * Determine redemption status based on attestation window, payment existence,
     * and time elapsed on the underlying chain.
     */
    async redemptionStatus(fasset: string, state: RedeemData, timestamp: number, settings: { attestationWindowSeconds: bigint }): Promise<RedemptionStatus> {
        const stateTs = dateStringToTimestamp(state.createdAt);
        if (timestamp - stateTs >= Number(settings.attestationWindowSeconds)) {
            return RedemptionStatus.EXPIRED;
        } else if (await this.findRedemptionPayment(fasset, state)) {
            return RedemptionStatus.SUCCESS;
        } else if (await this.redemptionTimeElapsed(fasset, state)) {
            return RedemptionStatus.DEFAULT;
        } else {
            return RedemptionStatus.PENDING;
        }
    }

    /**
     * Check if a redemption payment was made by looking for matching
     * transactions on the underlying chain.
     */
    async findRedemptionPayment(fasset: string, state: RedeemData): Promise<ITransaction | undefined> {
        const verifier = this.fassetConfigService.getVerifier(fasset);
        const txs = await verifier.getTransactionsByReference(state.paymentReference);
        for (const tx of txs) {
            const amount = tx.outputs.filter((o) => o[0] === state.underlyingAddress).reduce((sum, o) => sum + o[1], 0n);
            if (amount >= BigInt(state.amountUBA)) {
                return tx;
            }
        }
        return undefined;
    }

    /**
     * Check if the time window for a redemption payment has elapsed
     * on the underlying chain.
     */
    async redemptionTimeElapsed(fasset: string, state: RedeemData): Promise<boolean> {
        const verifier = this.fassetConfigService.getVerifier(fasset);
        const blockHeight = await verifier.getLastFinalizedBlockNumber();
        const lastBlock = await verifier.getBlock(blockHeight);
        if (!lastBlock) {
            throw new Error("Cannot get finalized block from verifier");
        }
        return blockHeight > Number(state.lastUnderlyingBlock) && lastBlock.timestamp > Number(state.lastUnderlyingTimestamp);
    }

    /* ---------------------------------------------------------------------- */
    /*                    PROCESS DIRECT MINTINGS                              */
    /* ---------------------------------------------------------------------- */

    /**
     * Checks unprocessed DirectMinting entities against on-chain events to
     * update their status. Terminal states (EXECUTED, TOO_SMALL, etc.)
     * mark the entity as processed.
     */
    private async processDirectMintings(fasset: string): Promise<void> {
        const directMintings = await this.em.find(DirectMinting, { processed: false, fasset }, { orderBy: { id: "ASC" } });

        for (const dm of directMintings) {
            try {
                // Match events by transactionId (the XRP tx hash stored on the DirectMinting)
                const txId = dm.txhash;

                // Check for DirectMintingExecuted event matching this specific transaction
                const executedEvent = await this.em.findOne(DirectMintingExecutedEvent, { transactionId: txId, fasset });
                if (executedEvent) {
                    dm.status = DirectMintingStatus.EXECUTED;
                    dm.mintedAmountUBA = executedEvent.mintedAmountUBA;
                    dm.mintingFeeUBA = executedEvent.mintingFeeUBA;
                    dm.executorFeeUBA = executedEvent.executorFeeUBA;
                    dm.evm_txhash = executedEvent.txhash ?? null;
                    dm.processed = true;
                    await this.em.persistAndFlush(dm);
                    continue;
                }

                // Check for DirectMintingExecutedToSmartAccount event
                const smartAcctEvent = await this.em.findOne(DirectMintingExecutedToSmartAccountEvent, { transactionId: txId, fasset });
                if (smartAcctEvent) {
                    dm.status = DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT;
                    dm.mintedAmountUBA = smartAcctEvent.mintedAmountUBA;
                    dm.mintingFeeUBA = smartAcctEvent.mintingFeeUBA;
                    dm.evm_txhash = smartAcctEvent.txhash ?? null;
                    dm.processed = true;
                    await this.em.persistAndFlush(dm);
                    continue;
                }

                // Check for payment too small for fee
                const tooSmallEvent = await this.em.findOne(DirectMintingPaymentTooSmallForFeeEvent, { transactionId: txId, fasset });
                if (tooSmallEvent) {
                    dm.status = DirectMintingStatus.MINTING_PAYMENT_TOO_SMALL_FOR_FEE;
                    dm.evm_txhash = tooSmallEvent.txhash ?? null;
                    dm.processed = true;
                    await this.em.persistAndFlush(dm);
                    continue;
                }

                // Check for delayed minting events
                const delayedEvent = await this.em.findOne(DirectMintingDelayedEvent, { transactionId: txId, fasset });
                const largeDelayedEvent = await this.em.findOne(LargeDirectMintingDelayedEvent, { transactionId: txId, fasset });
                if (delayedEvent || largeDelayedEvent) {
                    dm.status = DirectMintingStatus.DELAYED;
                    dm.delayTimestamp = delayedEvent ? delayedEvent.executionAllowedAt : largeDelayedEvent.executionAllowedAt;
                    await this.em.persistAndFlush(dm);
                    continue;
                }
            } catch (error) {
                logger.error(`Error in processDirectMintings for ${dm.txhash}:`, error);
                continue;
            }
        }
    }

    /* ---------------------------------------------------------------------- */
    /*                   PROCESS REDEMPTIONS WITH TAG                         */
    /* ---------------------------------------------------------------------- */

    /**
     * Checks unprocessed RedemptionWithTagRequestedEvent entities to update
     * their status. We do NOT execute defaults — another process handles that.
     * We only observe and update status.
     */
    private async processRedemptionsWithTag(fasset: string): Promise<void> {
        const tagRedemptions = await this.em.find(
            RedemptionWithTagRequestedEvent,
            {
                processed: false,
                fasset,
            },
            { orderBy: { id: "ASC" } }
        );

        for (const tagRedeem of tagRedemptions) {
            try {
                // Check if the underlying payment was made via verifier
                const verifier = this.fassetConfigService.getVerifier(fasset);
                const txs = await verifier.getTransactionsByReference(tagRedeem.paymentReference);

                // Check if payment with correct amount was sent
                const amountUBA = BigInt(tagRedeem.valueUBA) - BigInt(tagRedeem.feeUBA);
                let paymentFound = false;
                for (const tx of txs) {
                    const outputAmount = tx.outputs
                        .filter((o: [string, bigint]) => o[0] === tagRedeem.paymentAddress)
                        .reduce((sum: bigint, o: [string, bigint]) => sum + o[1], 0n);
                    if (outputAmount >= amountUBA) {
                        paymentFound = true;
                        break;
                    }
                }

                if (paymentFound) {
                    tagRedeem.status = RedemptionWithTagStatus.COMPLETED;
                    tagRedeem.processed = true;
                    await this.em.persistAndFlush(tagRedeem);
                    continue;
                }

                // Check for default event (from chain events imported by event reader)
                const defaultEvent = await this.em.findOne(RedemptionDefaultEventEntity, {
                    requestId: tagRedeem.requestId,
                });
                if (defaultEvent) {
                    tagRedeem.status = RedemptionWithTagStatus.DEFAULTED;
                    tagRedeem.processed = true;
                    await this.em.persistAndFlush(tagRedeem);
                    continue;
                }

                // Check for blocked event
                const blockedEvent = await this.em.findOne(RedemptionBlocked, {
                    requestId: tagRedeem.requestId,
                });
                if (blockedEvent) {
                    tagRedeem.status = RedemptionWithTagStatus.BLOCKED;
                    tagRedeem.processed = true;
                    await this.em.persistAndFlush(tagRedeem);
                    continue;
                }

                // Still in progress — nothing to do
            } catch (error) {
                logger.error(`Error in processRedemptionsWithTag for requestId ${tagRedeem.requestId}:`, error);
                continue;
            }
        }
    }
}
