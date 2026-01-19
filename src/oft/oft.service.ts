import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/core";
import { GuidRedemption } from "src/entities/OFTRedemptionGUID";
import { OFTHistory, RedemptionOFT } from "src/interfaces/requestResponse";
import { OFTSent } from "src/entities/OFTSent";
import { OFTReceived } from "src/entities/OFTReceived";
import { formatBNToStringForceDecimals } from "src/utils/utils";
import { toBN } from "@flarelabs/fasset-bots-core/utils";
/*import { Redemption } from "src/entities/Redemption";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { Collateral } from "src/entities/Collaterals";
import { logger } from "src/logger/winston.logger";*/

@Injectable()
export class OFTService {
    constructor(private readonly em: EntityManager) {}

    async getRedemptionTxhash(guid: string): Promise<RedemptionOFT> {
        const guidRed = await this.em.findOne(GuidRedemption, {
            guid: guid,
        });
        if (!guidRed) {
            return { txhash: "NotFound" };
        }
        return { txhash: guidRed.txhash };
    }

    //HYPE main eid 30367 , testnet eid: 40362

    async getOFTHistory(address: string): Promise<OFTHistory[]> {
        const now = new Date();
        // TODO if cleanup then no need to filter by date
        const date = new Date(now.getTime() - 7 * 23 * 60 * 60 * 1000).getTime();
        const oftSent = await this.em.find(OFTSent, { fromAddress: address, timestamp: { $gte: date } });
        const oftReceived = await this.em.find(OFTReceived, { toAddress: address, timestamp: { $gte: date } });
        //const redTriggered = await this.em.find(GuidRedemption, { userAddress: address, timestamp: { $gte: date } });
        //const redeemHashes = [...new Set(redTriggered.map((redeem) => redeem.txhash))];
        const history: OFTHistory[] = [];
        for (const sentEvent of oftSent) {
            const progress: OFTHistory = {
                action: "SEND",
                timestamp: sentEvent.timestamp,
                amount: formatBNToStringForceDecimals(toBN(sentEvent.amountSentLD), 2, 6),
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
                amount: formatBNToStringForceDecimals(toBN(recEvent.amountReceivedLD), 2, 6),
                txhash: recEvent.txhash,
                fasset: recEvent.fasset,
                status: true,
                eid: recEvent.srcEid,
            };
            history.push(progress);
        }
        /*const incompleteRedeems = await this.em.find(IncompleteRedemption, {
            redeemer: address,
        });
        for (const redeem of redeemHashes) {
            try {
                const redeemTickets = await this.em.find(Redemption, {
                    txhash: redeem,
                });
                const redeems = await this.em.find(RedemptionRequested, {
                    txhash: redeem,
                    timestamp: { $gte: date },
                });
                const filteredRedeems = redeems.filter((red) => red.txhash === redeem);
                const ticketValueUBA = filteredRedeems.reduce((sum, ticket) => sum.add(toBN(ticket.valueUBA)), toBN(0));
                //Check if redemption was incomplete
                const incompleteData = incompleteRedeems.find((red) => red.txhash === redeem);
                let incomplete = false;
                if (incompleteData) {
                    incomplete = true;
                }
                const redTriggeredEvent = redTriggered.filter((red) => red.txhash === redeem);
                const oftReceivedGuid = await this.em.findOne(OFTReceived, { guid: redTriggeredEvent[0].guid });
                const eid = oftReceivedGuid ? oftReceivedGuid.srcEid : redeemTickets[0].fasset.includes("Test") ? 30367 : 40362;
                for (const ticket of redeemTickets) {
                    const redemptionAmount = formatBNToDisplayDecimals(
                        ticketValueUBA,
                        ticket.fasset.includes("XRP") ? 2 : 8,
                        ticket.fasset.includes("XRP") ? 6 : 8
                    );
                    let vaultCollateralRedeemed = "0";
                    let poolCollateralRedeemed = "0";
                    let collateralToken = "USDT0";
                    let amount = formatBNToDisplayDecimals(
                        toBN(ticket.amountUBA),
                        ticket.fasset.includes("XRP") ? 2 : 8,
                        ticket.fasset.includes("XRP") ? 6 : 8
                    );
                    if (ticket.defaulted == true && ticket.processed == true) {
                        const defaultEvent = await this.em.findOne(RedemptionDefault, {
                            requestId: ticket.requestId,
                        });
                        amount = "0";
                        if (defaultEvent) {
                            const collateral = await this.em.find(Collateral, {
                                tokenFtsoSymbol: defaultEvent.collateralToken,
                            });
                            vaultCollateralRedeemed = formatBNToDisplayDecimals(toBN(defaultEvent.redeemedVaultCollateralWei), 3, collateral[0].decimals);
                            poolCollateralRedeemed = formatBNToDisplayDecimals(toBN(defaultEvent.redeemedPoolCollateralWei), 3, 18);
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
                        redemptionBlocked: ticket.blocked,
                    };
                    history.push(progress);
                }
            } catch (error) {
                logger.error(`Error processing redemption in oft history`, error);
            }
        }*/
        history.sort((a, b) => b.timestamp - a.timestamp);
        return history;
    }
}
