import { Injectable } from "@nestjs/common";
import { EntityManager, expr } from "@mikro-orm/core";
import { ConfigService } from "@nestjs/config";
import { OFTRedemption } from "src/entities/OFTRedemption";
import { OFTRedemptionFailed } from "src/entities/OFTRedemptionFailed";
import { OFTComposerFeeCollected } from "src/entities/OFTComposerFeeCollected";
import {
    ComposerFeeResponse,
    OFTHistory,
    OFTLimitsResponse,
    RedeemerAccountResponse,
    RedemptionFeesResponse,
    RedemptionOFT,
} from "src/interfaces/requestResponse";
import { OFTSent } from "src/entities/OFTSent";
import { OFTReceived } from "src/entities/OFTReceived";
import { formatBigIntToDisplayDecimals, formatBigIntToStringForceDecimals } from "src/utils/utils";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { RedemptionAmountIncompleteEvent } from "src/entities/RedemptionAmountIncompleteEvent";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { Collateral } from "src/entities/Collaterals";
import { Pool } from "src/entities/Pool";
import { logger } from "src/logger/winston.logger";
import { OFTEventReaderService, OFT_FIRST_TRUSTED_BLOCK_STATE, OFT_LAST_BLOCK_STATE } from "./oft.event.reader.service";
import { DirectMinting, DirectMintingStatus } from "src/entities/DirectMinting";
import { DirectMintingExecutedEvent } from "src/entities/DirectMintingExecutedEvent";
import { DirectMintingExecutedToSmartAccountEvent } from "src/entities/DirectMintingExecutedToSmartAccountEvent";
import { IndexerState } from "src/entities/IndexerState";

const OFT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PROVISIONAL_OFT_STATUSES = new Set<string>([
    DirectMintingStatus.INPROGRESS,
    DirectMintingStatus.DELAYED,
    DirectMintingStatus.AWAITING_RECOVERY,
    DirectMintingStatus.RECOVERY_PENDING,
    DirectMintingStatus.RECOVERED,
    DirectMintingStatus.MINTING_PAYMENT_TOO_SMALL_FOR_FEE,
]);

type DirectMintExecutionEvent = DirectMintingExecutedEvent | DirectMintingExecutedToSmartAccountEvent;

@Injectable()
export class OFTService {
    constructor(
        private readonly em: EntityManager,
        private readonly oftEventReaderService: OFTEventReaderService,
        private readonly configService: ConfigService
    ) {}

    getLimits(): OFTLimitsResponse {
        return this.oftEventReaderService.getLimits();
    }

    getPaused(): Promise<boolean> {
        return this.oftEventReaderService.getPaused();
    }

    async getRedemptionTxhash(guid: string): Promise<RedemptionOFT> {
        const redemption = await this.em.findOne(OFTRedemption, {
            guid: guid,
        });
        if (!redemption) {
            return { txhash: "NotFound" };
        }
        return { txhash: redemption.txhash };
    }

    async getComposerFee(srcEid: number): Promise<ComposerFeeResponse> {
        const composerFeePPM = await this.oftEventReaderService.getComposerFeePPM(srcEid);
        return { composerFeePPM };
    }

    /** Fetches the composer fee PPM and default executor address + fee for redemptions. */
    async getRedemptionFees(srcEid: number): Promise<RedemptionFeesResponse> {
        const [composerFeePPM, executorAddress] = await Promise.all([
            this.oftEventReaderService.getComposerFeePPM(srcEid),
            this.oftEventReaderService.getDefaultExecutor(),
        ]);
        const executorFee = this.oftEventReaderService.getExecutorFee();
        return {
            composerFeePPM,
            executorAddress,
            executorFee,
        };
    }

    async getRedeemerAccountAddress(redeemer: string): Promise<RedeemerAccountResponse> {
        const address = await this.oftEventReaderService.getRedeemerAccountAddress(redeemer);
        const balances = await this.oftEventReaderService.getRedeemerAccountBalances(address);
        return { address, balances };
    }

    private historyJoinKey(txhash: string, fasset: string): string {
        return `${txhash.toLowerCase()}:${fasset}`;
    }

    private alertMissingExecutionMetadata(
        candidate: DirectMinting,
        eventType: "DirectMintingExecuted" | "DirectMintingExecutedToSmartAccount",
        event: DirectMintExecutionEvent | undefined
    ): void {
        logger.error(
            JSON.stringify({
                code: "OFT_HISTORY_MISSING_EXECUTION_METADATA",
                candidateId: candidate.id,
                xrplTxHash: candidate.txhash,
                fasset: candidate.fasset,
                eventType,
                evmTxHash: event?.txhash ?? null,
                executionBlockNumber: event?.blockNumber ?? null,
            })
        );
    }

    private alertUntrustedCoverage(
        candidate: DirectMinting,
        reason: "missing_indexer_state" | "execution_before_first_trusted_block",
        executionBlockNumber: number,
        oftLastBlock: IndexerState | undefined,
        firstTrustedBlock: IndexerState | undefined
    ): void {
        logger.error(
            JSON.stringify({
                code: "OFT_HISTORY_UNTRUSTED_OFT_COVERAGE",
                reason,
                candidateId: candidate.id,
                xrplTxHash: candidate.txhash,
                fasset: candidate.fasset,
                directMintingStatus: candidate.status,
                executionBlockNumber,
                oftLastBlock: oftLastBlock?.lastBlock ?? null,
                firstTrustedBlock: firstTrustedBlock?.lastBlock ?? null,
            })
        );
    }

    private buildDirectMintBridgeHistory(candidate: DirectMinting, executionEvent: DirectMintExecutionEvent | undefined, oftSent: OFTSent | null): OFTHistory {
        const xrplTxHash = candidate.txhash.replace(/^0x/i, "").toUpperCase();
        const fees = BigInt(candidate.mintingFeeUBA) + BigInt(candidate.executorFeeUBA);
        const grossAmount = BigInt(candidate.amount);
        const estimatedAmount = grossAmount >= fees ? grossAmount - fees : 0n;
        const amount = oftSent ? BigInt(oftSent.amountSentLD) : estimatedAmount;

        return {
            action: "DIRECT_MINT_BRIDGE",
            timestamp: Number(candidate.timestamp),
            amount: formatBigIntToStringForceDecimals(amount, 2, 6),
            amountEstimated: oftSent === null,
            fasset: candidate.fasset,
            status: candidate.processed,
            directMinting: true,
            directMintingStatus: candidate.status,
            delayTimestamp: candidate.delayTimestamp === null ? null : Number(candidate.delayTimestamp),
            txhash: xrplTxHash,
            xrplTxHash,
            evmTxHash: executionEvent?.txhash ?? candidate.evm_txhash ?? null,
            eid: oftSent?.dstEid ?? candidate.destinationEid ?? null,
            destinationKind: candidate.destinationKind ?? null,
            toHypercore: oftSent?.toHypercore ?? null,
            oftSent: oftSent
                ? {
                      guid: oftSent.guid,
                      dstEid: oftSent.dstEid,
                      fromAddress: oftSent.fromAddress,
                      amountSentLD: oftSent.amountSentLD,
                      amountReceivedLD: oftSent.amountReceivedLD,
                      txhash: oftSent.txhash,
                  }
                : null,
        };
    }

    async getOFTShortHistory(address: string, xrpAddress?: string): Promise<OFTHistory[]> {
        const history = await this.getOFTHistory(address, xrpAddress);
        return history.filter((entry) => ["REDEEM", "REDEEMFAIL", "DIRECT_MINT_BRIDGE"].includes(entry.action));
    }

    async getOFTHistory(address: string, xrpAddress?: string): Promise<OFTHistory[]> {
        const date = Date.now() - OFT_HISTORY_WINDOW_MS;
        const oftFasset = this.configService.get<string>("APP_TYPE") === "dev" ? "FTestXRP" : "FXRP";
        const directMintingsPromise =
            xrpAddress === undefined
                ? Promise.resolve([] as DirectMinting[])
                : this.em.find(DirectMinting, {
                      userAddress: xrpAddress,
                      fasset: oftFasset,
                      mintType: "oft_candidate",
                      $or: [
                          { timestamp: { $gte: date } },
                          { status: { $in: [DirectMintingStatus.AWAITING_RECOVERY, DirectMintingStatus.RECOVERY_PENDING] } },
                      ],
                  });
        const [oftSent, oftReceived, oftRedemptions, oftRedemptionsFailed, directMintings] = await Promise.all([
            this.em.find(OFTSent, { fromAddress: address, timestamp: { $gte: date } }),
            this.em.find(OFTReceived, { toAddress: address, timestamp: { $gte: date } }),
            this.em.find(OFTRedemption, { redeemer: address, timestamp: { $gte: date } }),
            this.em.find(OFTRedemptionFailed, { redeemer: address, timestamp: { $gte: date } }),
            directMintingsPromise,
        ]);

        const smartCandidateTransactionIds = [
            ...new Set(
                directMintings.filter((candidate) => candidate.status === DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT).map((candidate) => candidate.txhash)
            ),
        ];
        const ordinaryCandidateTransactionIds = [
            ...new Set(directMintings.filter((candidate) => candidate.status === DirectMintingStatus.EXECUTED).map((candidate) => candidate.txhash)),
        ];
        const hasExecutedCandidates = smartCandidateTransactionIds.length > 0 || ordinaryCandidateTransactionIds.length > 0;
        const [smartExecutionEvents, ordinaryExecutionEvents, indexerStates] = await Promise.all([
            smartCandidateTransactionIds.length > 0
                ? this.em.find(
                      DirectMintingExecutedToSmartAccountEvent,
                      { transactionId: { $in: smartCandidateTransactionIds }, fasset: oftFasset },
                      { orderBy: { id: "ASC" } }
                  )
                : Promise.resolve([] as DirectMintingExecutedToSmartAccountEvent[]),
            ordinaryCandidateTransactionIds.length > 0
                ? this.em.find(
                      DirectMintingExecutedEvent,
                      { transactionId: { $in: ordinaryCandidateTransactionIds }, fasset: oftFasset },
                      { orderBy: { id: "ASC" } }
                  )
                : Promise.resolve([] as DirectMintingExecutedEvent[]),
            hasExecutedCandidates
                ? this.em.find(IndexerState, { name: { $in: [OFT_LAST_BLOCK_STATE, OFT_FIRST_TRUSTED_BLOCK_STATE] } })
                : Promise.resolve([] as IndexerState[]),
        ]);

        const smartExecutionByCandidate = new Map<string, DirectMintingExecutedToSmartAccountEvent>();
        for (const event of smartExecutionEvents) {
            const key = this.historyJoinKey(event.transactionId, event.fasset);
            if (!smartExecutionByCandidate.has(key)) smartExecutionByCandidate.set(key, event);
        }
        const ordinaryExecutionByCandidate = new Map<string, DirectMintingExecutedEvent>();
        for (const event of ordinaryExecutionEvents) {
            const key = this.historyJoinKey(event.transactionId, event.fasset);
            if (!ordinaryExecutionByCandidate.has(key)) ordinaryExecutionByCandidate.set(key, event);
        }

        const smartExecutionTxHashes = [
            ...new Set(
                [...smartExecutionByCandidate.values()]
                    .filter((event) => event.txhash != null && event.blockNumber != null)
                    .map((event) => event.txhash!.toLowerCase())
            ),
        ];
        const matchingOftSent =
            smartExecutionTxHashes.length > 0
                ? await this.em.find(
                      OFTSent,
                      {
                          fasset: oftFasset,
                          [expr<OFTSent>((alias) => `lower(${alias}.txhash)`)]: { $in: smartExecutionTxHashes },
                      },
                      { orderBy: { id: "ASC" } }
                  )
                : [];
        const oftSentByExecution = new Map<string, OFTSent>();
        for (const event of matchingOftSent) {
            const key = this.historyJoinKey(event.txhash, event.fasset);
            if (!oftSentByExecution.has(key)) oftSentByExecution.set(key, event);
        }

        const indexerStateByName = new Map(indexerStates.map((state) => [state.name, state]));
        const oftLastBlock = indexerStateByName.get(OFT_LAST_BLOCK_STATE);
        const firstTrustedBlock = indexerStateByName.get(OFT_FIRST_TRUSTED_BLOCK_STATE);
        const directMintBridgeHistory: OFTHistory[] = [];
        const selectedOftSentIds = new Set<number>();

        for (const candidate of directMintings) {
            let executionEvent: DirectMintExecutionEvent | undefined;
            let selectedOftSent: OFTSent | null = null;

            if (!PROVISIONAL_OFT_STATUSES.has(candidate.status)) {
                const isSmartAccountExecution = candidate.status === DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT;
                const isOrdinaryExecution = candidate.status === DirectMintingStatus.EXECUTED;
                if (!isSmartAccountExecution && !isOrdinaryExecution) continue;

                const candidateKey = this.historyJoinKey(candidate.txhash, candidate.fasset);
                executionEvent = isSmartAccountExecution ? smartExecutionByCandidate.get(candidateKey) : ordinaryExecutionByCandidate.get(candidateKey);
                const eventType = isSmartAccountExecution ? "DirectMintingExecutedToSmartAccount" : "DirectMintingExecuted";

                if (!executionEvent || executionEvent.txhash == null || executionEvent.blockNumber == null) {
                    this.alertMissingExecutionMetadata(candidate, eventType, executionEvent);
                } else {
                    if (isSmartAccountExecution) {
                        selectedOftSent = oftSentByExecution.get(this.historyJoinKey(executionEvent.txhash, candidate.fasset)) ?? null;
                    }

                    if (selectedOftSent) {
                        selectedOftSentIds.add(selectedOftSent.id);
                    } else if (!oftLastBlock || !firstTrustedBlock) {
                        this.alertUntrustedCoverage(candidate, "missing_indexer_state", executionEvent.blockNumber, oftLastBlock, firstTrustedBlock);
                    } else if (executionEvent.blockNumber < firstTrustedBlock.lastBlock) {
                        this.alertUntrustedCoverage(
                            candidate,
                            "execution_before_first_trusted_block",
                            executionEvent.blockNumber,
                            oftLastBlock,
                            firstTrustedBlock
                        );
                    } else if (oftLastBlock.lastBlock > executionEvent.blockNumber) {
                        continue;
                    }
                }
            }

            directMintBridgeHistory.push(this.buildDirectMintBridgeHistory(candidate, executionEvent, selectedOftSent));
        }

        const redeemHashes = [...new Set(oftRedemptions.map((redeem) => redeem.txhash))];
        const history: OFTHistory[] = [];
        for (const sentEvent of oftSent) {
            if (selectedOftSentIds.has(sentEvent.id)) continue;
            const progress: OFTHistory = {
                action: "SEND",
                timestamp: sentEvent.timestamp,
                amount: formatBigIntToStringForceDecimals(BigInt(sentEvent.amountSentLD), 2, 6),
                txhash: sentEvent.txhash,
                fasset: sentEvent.fasset,
                status: true,
                eid: sentEvent.dstEid,
                toHypercore: sentEvent.toHypercore,
            };
            history.push(progress);
        }
        history.push(...directMintBridgeHistory);
        for (const recEvent of oftReceived) {
            const progress: OFTHistory = {
                action: "RECEIVE",
                timestamp: recEvent.timestamp,
                amount: formatBigIntToStringForceDecimals(BigInt(recEvent.amountReceivedLD), 2, 6),
                txhash: recEvent.txhash,
                guid: recEvent.guid,
                fasset: recEvent.fasset,
                status: true,
                eid: recEvent.srcEid,
            };
            history.push(progress);
        }

        // Batch-fetch all data needed for redeem processing
        const allGuids = [...new Set(oftRedemptions.map((r) => r.guid))];
        const allRequestIds = oftRedemptions.map((r) => r.requestId);
        const allAgentVaults = [...new Set(oftRedemptions.map((r) => r.agentVault))];
        const [incompleteRedeems, amountIncompleteRedeems, oftReceivedByGuidList, defaultEventsList, allCollaterals, composerFeesList, pools] =
            await Promise.all([
                this.em.find(IncompleteRedemption, { txhash: { $in: redeemHashes } }),
                this.em.find(RedemptionAmountIncompleteEvent, { txhash: { $in: redeemHashes } }),
                allGuids.length > 0 ? this.em.find(OFTReceived, { guid: { $in: allGuids } }) : Promise.resolve([]),
                allRequestIds.length > 0 ? this.em.find(RedemptionDefaultEvent, { requestId: { $in: allRequestIds } }) : Promise.resolve([]),
                this.em.find(Collateral, {}),
                allGuids.length > 0 ? this.em.find(OFTComposerFeeCollected, { guid: { $in: allGuids } }) : Promise.resolve([]),
                allAgentVaults.length > 0 ? this.em.find(Pool, { vaultAddress: { $in: allAgentVaults } }) : Promise.resolve([]),
            ]);

        // Build lookup maps
        const redemptionsByTxhash = new Map<string, OFTRedemption[]>();
        for (const r of oftRedemptions) {
            const existing = redemptionsByTxhash.get(r.txhash) || [];
            existing.push(r);
            redemptionsByTxhash.set(r.txhash, existing);
        }
        const incompleteByTxhash = new Map(incompleteRedeems.map((r) => [r.txhash, r]));
        const amountIncompleteByTxhash = new Map(amountIncompleteRedeems.map((r) => [r.txhash, r]));
        const oftReceivedByGuid = new Map(oftReceivedByGuidList.map((r) => [r.guid, r]));
        const defaultsByRequestId = new Map(defaultEventsList.map((d) => [d.requestId, d]));
        const collateralsBySymbol = new Map(allCollaterals.map((c) => [c.tokenFtsoSymbol, c]));
        const poolsByVaultAddress = new Map(pools.map((pool) => [pool.vaultAddress, pool]));
        // Composer fee paid by the redeemer, keyed by redemption guid. Absent
        // entries default to 0n (composer omits the event when fee == 0).
        const composerFeeByGuid = new Map(composerFeesList.map((f) => [f.guid, BigInt(f.composerFee)]));

        for (const redeem of redeemHashes) {
            try {
                const tickets = redemptionsByTxhash.get(redeem) || [];
                const ticketValueUBA = tickets.reduce((sum, ticket) => sum + BigInt(ticket.valueUBA), 0n);
                // AssetManager request values are emitted after the system fee is removed,
                // so add every ticket's exact fee back when reconstructing the gross amount.
                const systemRedemptionFeeUBA = tickets.reduce((sum, ticket) => sum + BigInt(ticket.systemRedemptionFeeUBA ?? "0"), 0n);
                const incompleteData = incompleteByTxhash.get(redeem);
                const amountIncompleteData = amountIncompleteByTxhash.get(redeem);
                const incomplete = !!incompleteData || !!amountIncompleteData;
                const oftReceivedGuid = oftReceivedByGuid.get(tickets[0].guid);
                const eid = oftReceivedGuid ? oftReceivedGuid.srcEid : tickets[0].srcEid;
                // All tickets in this txhash share the same composer redemption (and guid),
                // so the composer fee lookup is done once and added to the gross redemption
                // amount displayed to the user.
                const composerFee = composerFeeByGuid.get(tickets[0].guid) ?? 0n;
                for (const ticket of tickets) {
                    const redemptionAmount = formatBigIntToStringForceDecimals(
                        ticketValueUBA + systemRedemptionFeeUBA + composerFee,
                        2,
                        ticket.fasset.includes("XRP") ? 6 : 8
                    );
                    let vaultCollateralRedeemed = "0";
                    let poolCollateralRedeemed = "0";
                    let collateralToken = "USDT0";
                    let amount = formatBigIntToDisplayDecimals(
                        BigInt(ticket.valueUBA) - BigInt(ticket.feeUBA),
                        ticket.fasset.includes("XRP") ? 2 : 8,
                        ticket.fasset.includes("XRP") ? 6 : 8
                    );
                    if (ticket.defaulted == true && ticket.processed == true) {
                        const defaultEvent = defaultsByRequestId.get(ticket.requestId);
                        amount = "0";
                        if (defaultEvent) {
                            const vaultCollateralToken = poolsByVaultAddress.get(defaultEvent.agentVault)?.vaultCollateralToken;
                            if (vaultCollateralToken) {
                                const collateral = collateralsBySymbol.get(vaultCollateralToken);
                                vaultCollateralRedeemed = formatBigIntToDisplayDecimals(
                                    BigInt(defaultEvent.redeemedVaultCollateralWei),
                                    3,
                                    collateral?.decimals ?? 18
                                );
                                poolCollateralRedeemed = formatBigIntToDisplayDecimals(BigInt(defaultEvent.redeemedPoolCollateralWei), 3, 18);
                                collateralToken = vaultCollateralToken == "USDT" ? "USDT0" : vaultCollateralToken;
                            }
                        }
                    }
                    const progress: OFTHistory = {
                        action: "REDEEM",
                        timestamp: ticket.timestamp,
                        amount: redemptionAmount,
                        eid: eid,
                        fasset: ticket.fasset,
                        status: ticket.processed,
                        defaulted: ticket.defaulted,
                        txhash: ticket.txhash,
                        guid: ticket.guid,
                        ticketID: ticket.requestId,
                        vaultToken: collateralToken,
                        vaultTokenValueRedeemed: vaultCollateralRedeemed,
                        poolTokenValueRedeemed: poolCollateralRedeemed,
                        underlyingPaid: amount,
                        incomplete: incomplete,
                        remainingLots: incompleteData?.remainingLots ?? null,
                        remainingAmountUBA: amountIncompleteData?.remainingAmountUBA ?? null,
                        redemptionBlocked: ticket.blocked,
                    };
                    history.push(progress);
                }
            } catch (error) {
                logger.error(`Error processing redemption in oft history`, error);
            }
        }
        // Add failed redemption entries to history
        for (const failedEvent of oftRedemptionsFailed) {
            const progress: OFTHistory = {
                action: "REDEEMFAIL",
                timestamp: failedEvent.timestamp,
                amount: formatBigIntToStringForceDecimals(BigInt(failedEvent.amountToRedeemAfterFee), 2, 6),
                txhash: failedEvent.txhash,
                guid: failedEvent.guid,
                fasset: failedEvent.fasset,
                status: true,
                eid: failedEvent.srcEid,
            };
            history.push(progress);
        }

        history.sort((a, b) => b.timestamp - a.timestamp);
        return history;
    }
}
