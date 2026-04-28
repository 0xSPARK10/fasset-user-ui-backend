import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/core";
import { OFTRedemption } from "src/entities/OFTRedemption";
import { OFTRedemptionFailed } from "src/entities/OFTRedemptionFailed";
import { ComposerFeeResponse, OFTHistory, RedeemerAccountResponse, RedemptionFeesResponse, RedemptionOFT } from "src/interfaces/requestResponse";
import { OFTSent } from "src/entities/OFTSent";
import { OFTReceived } from "src/entities/OFTReceived";
import { formatBigIntToDisplayDecimals, formatBigIntToStringForceDecimals } from "src/utils/utils";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { RedemptionAmountIncompleteEvent } from "src/entities/RedemptionAmountIncompleteEvent";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { Collateral } from "src/entities/Collaterals";
import { logger } from "src/logger/winston.logger";
import { OFTEventReaderService } from "./oft.event.reader.service";

@Injectable()
export class OFTService {
    constructor(
        private readonly em: EntityManager,
        private readonly oftEventReaderService: OFTEventReaderService
    ) {}

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

    async getOFTHistory(address: string): Promise<OFTHistory[]> {
        const now = new Date();
        const date = new Date(now.getTime() - 7 * 23 * 60 * 60 * 1000).getTime();
        const [oftSent, oftReceived, oftRedemptions, oftRedemptionsFailed] = await Promise.all([
            this.em.find(OFTSent, { fromAddress: address, timestamp: { $gte: date } }),
            this.em.find(OFTReceived, { toAddress: address, timestamp: { $gte: date } }),
            this.em.find(OFTRedemption, { redeemer: address, timestamp: { $gte: date } }),
            this.em.find(OFTRedemptionFailed, { redeemer: address, timestamp: { $gte: date } }),
        ]);
        const redeemHashes = [...new Set(oftRedemptions.map((redeem) => redeem.txhash))];
        const history: OFTHistory[] = [];
        for (const sentEvent of oftSent) {
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
        for (const recEvent of oftReceived) {
            const progress: OFTHistory = {
                action: "RECEIVE",
                timestamp: recEvent.timestamp,
                amount: formatBigIntToStringForceDecimals(BigInt(recEvent.amountReceivedLD), 2, 6),
                txhash: recEvent.txhash,
                fasset: recEvent.fasset,
                status: true,
                eid: recEvent.srcEid,
            };
            history.push(progress);
        }

        // Batch-fetch all data needed for redeem processing
        const allGuids = [...new Set(oftRedemptions.map((r) => r.guid))];
        const allRequestIds = oftRedemptions.map((r) => r.requestId);
        const [incompleteRedeems, amountIncompleteRedeems, oftReceivedByGuidList, defaultEventsList, allCollaterals] = await Promise.all([
            this.em.find(IncompleteRedemption, { txhash: { $in: redeemHashes } }),
            this.em.find(RedemptionAmountIncompleteEvent, { txhash: { $in: redeemHashes } }),
            allGuids.length > 0 ? this.em.find(OFTReceived, { guid: { $in: allGuids } }) : Promise.resolve([]),
            allRequestIds.length > 0 ? this.em.find(RedemptionDefault, { requestId: { $in: allRequestIds } }) : Promise.resolve([]),
            this.em.find(Collateral, {}),
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

        for (const redeem of redeemHashes) {
            try {
                const tickets = redemptionsByTxhash.get(redeem) || [];
                const ticketValueUBA = tickets.reduce((sum, ticket) => sum + BigInt(ticket.valueUBA), 0n);
                const incompleteData = incompleteByTxhash.get(redeem);
                const amountIncompleteData = amountIncompleteByTxhash.get(redeem);
                const incomplete = !!incompleteData || !!amountIncompleteData;
                const oftReceivedGuid = oftReceivedByGuid.get(tickets[0].guid);
                const eid = oftReceivedGuid ? oftReceivedGuid.srcEid : tickets[0].srcEid;
                for (const ticket of tickets) {
                    const redemptionAmount = formatBigIntToDisplayDecimals(
                        ticketValueUBA,
                        ticket.fasset.includes("XRP") ? 2 : 8,
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
                            const collateral = collateralsBySymbol.get(defaultEvent.collateralToken);
                            vaultCollateralRedeemed = formatBigIntToDisplayDecimals(
                                BigInt(defaultEvent.redeemedVaultCollateralWei),
                                3,
                                collateral?.decimals ?? 18
                            );
                            poolCollateralRedeemed = formatBigIntToDisplayDecimals(BigInt(defaultEvent.redeemedPoolCollateralWei), 3, 18);
                            collateralToken = defaultEvent.collateralToken == "USDT" ? "USDT0" : defaultEvent.collateralToken;
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
