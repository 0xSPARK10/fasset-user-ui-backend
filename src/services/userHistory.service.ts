/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { Progress } from "../interfaces/requestResponse";
import { toBN } from "@flarelabs/fasset-bots-core/utils";
import { BotService } from "./bot.init.service";
import { EntityManager } from "@mikro-orm/core";
import { Minting } from "../entities/Minting";
import { Redemption } from "../entities/Redemption";
import { formatBNToDisplayDecimals } from "src/utils/utils";
import { logger } from "src/logger/winston.logger";
import { Collateral } from "src/entities/Collaterals";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { MintingDefaultEvent } from "src/entities/MintingDefaultEvent";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { UserService } from "./user.service";

@Injectable()
export class HistoryService {
    constructor(
        private readonly botService: BotService,
        private readonly em: EntityManager,
        private readonly userService: UserService
    ) {}
    async getProgress(userAddress: string): Promise<Progress[]> {
        const now = new Date();
        const date = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).getTime();
        const nowDateDay = new Date(now.getTime() - 24 * 60 * 60 * 1000).getTime();
        const nowTimestamp = now.getTime();
        const mints = await this.em.find(Minting, { userAddress: userAddress, timestamp: { $gte: date } });
        /*const redeems = await this.em.find(FullRedemption, {
                userAddress: userAddress.toLocaleLowerCase(),
            });*/
        const incompleteRedeems = await this.em.find(IncompleteRedemption, {
            redeemer: userAddress,
        });
        //const redeemTickets = await this.em.find(Redemption, { userAddress: userAddress.toLocaleLowerCase() })
        const userProgress: Progress[] = [];
        for (const mint of mints) {
            if (Number(mint.timestamp) < date) {
                continue;
            }
            const defaultEvent = await this.em.findOne(MintingDefaultEvent, {
                collateralReservationId: mint.collateralReservationId,
            });
            if (mint.txhash == null && Number(mint.timestamp) < nowDateDay && !defaultEvent) {
                continue;
            }
            const progress = {
                action: "MINT",
                timestamp: Number(mint.timestamp),
                amount: mint.amount,
                fasset: mint.fasset,
                status: mint.processed,
                txhash: mint.txhash == null ? "Not found" : mint.txhash,
                defaulted: defaultEvent ? true : false,
            };
            userProgress.push(progress);
        }
        const redeems = await this.em.find(RedemptionRequested, {
            redeemer: userAddress,
            timestamp: { $gte: date },
        });
        const redeemHashes = [...new Set(redeems.map((redeem) => redeem.txhash))];
        for (const redeem of redeemHashes) {
            // All tickets need to be processed for a redemption to have status true to be regarded as completed
            const redeemTickets = await this.em.find(Redemption, {
                txhash: redeem,
            });
            const filteredRedeems = redeems.filter((red) => red.txhash === redeem);
            const ticketValueUBA = filteredRedeems.reduce((sum, ticket) => sum.add(toBN(ticket.valueUBA)), toBN(0));
            //Check if redemption was incomplete
            const incompleteData = incompleteRedeems.find((red) => red.txhash === redeem);
            let incomplete = false;
            if (incompleteData) {
                incomplete = true;
            }
            //Preparation for each default ticket
            for (const ticket of redeemTickets) {
                const redemptionAmount = formatBNToDisplayDecimals(
                    ticketValueUBA,
                    ticket.fasset.includes("XRP") ? 2 : 8,
                    Number(this.botService.getFassetDecimals(ticket.fasset))
                );
                if (ticket.defaulted == true && ticket.processed == true) {
                    const defaultEvent = await this.em.find(RedemptionDefault, {
                        requestId: ticket.requestId,
                    });
                    let redDefEvent: RedemptionDefault;
                    if (defaultEvent.length == 0) {
                        try {
                            redDefEvent = await this.userService.getAndSaveRedemptionDefaultEvent(ticket, nowTimestamp);
                        } catch (error) {
                            logger.error("Error in progress: ", error);
                            continue;
                        }
                    } else {
                        redDefEvent = defaultEvent[0];
                    }
                    //const amount = formatBNToDisplayDecimals(toBN(ticket.amountUBA), redeem.fasset == "FTestXRP" ? 2 : 8, redeem.fasset == "FTestXRP" ? 6 : 8);
                    const collateral = await this.em.find(Collateral, {
                        tokenFtsoSymbol: redDefEvent.collateralToken,
                    });
                    const vaultCollateralRedeemed = formatBNToDisplayDecimals(
                        toBN(redDefEvent.redeemedVaultCollateralWei),
                        redDefEvent.collateralToken.includes("ETH") ? 6 : 3,
                        collateral[0].decimals
                    );
                    const poolCollateralRedeemed = formatBNToDisplayDecimals(toBN(redDefEvent.redeemedPoolCollateralWei), 3, 18);
                    const progress = {
                        action: "REDEEM",
                        timestamp: Number(ticket.timestamp),
                        amount: redemptionAmount,
                        fasset: ticket.fasset,
                        status: ticket.processed,
                        defaulted: ticket.defaulted,
                        txhash: ticket.txhash,
                        ticketID: ticket.requestId,
                        vaultToken: redDefEvent.collateralToken,
                        vaultTokenValueRedeemed: vaultCollateralRedeemed,
                        poolTokenValueRedeemed: poolCollateralRedeemed,
                        underlyingPaid: "0",
                        incomplete: incomplete,
                        remainingLots: incompleteData?.remainingLots ?? null,
                        rejected: ticket.rejected,
                        takenOver: ticket.takenOver,
                        rejectionDefaulted: ticket.rejectionDefault,
                    };
                    userProgress.push(progress);
                } else {
                    const amount = formatBNToDisplayDecimals(
                        toBN(ticket.amountUBA),
                        ticket.fasset.includes("XRP") ? 2 : 8,
                        ticket.fasset.includes("XRP") ? 6 : 8
                    );

                    const progress = {
                        action: "REDEEM",
                        timestamp: Number(ticket.timestamp),
                        amount: redemptionAmount,
                        fasset: ticket.fasset,
                        status: ticket.processed,
                        defaulted: ticket.defaulted,
                        txhash: ticket.txhash,
                        ticketID: ticket.requestId,
                        underlyingPaid: amount,
                        incomplete: incomplete,
                        remainingLots: incompleteData?.remainingLots ?? null,
                        rejected: ticket.rejected,
                        takenOver: ticket.takenOver,
                        rejectionDefaulted: ticket.rejectionDefault,
                    };
                    userProgress.push(progress);
                }
            }
        }
        userProgress.sort((a, b) => b.timestamp - a.timestamp);
        return userProgress;
    }
}
