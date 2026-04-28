/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { MintingTransaction, Progress } from "../interfaces/requestResponse";
import { BotService } from "./bot.init.service";
import { EntityManager } from "@mikro-orm/core";
import { Minting } from "../entities/Minting";
import { Redemption } from "../entities/Redemption";
import { calculateExpirationMinutes, formatBigIntToDisplayDecimals } from "src/utils/utils";
import { logger } from "src/logger/winston.logger";
import { Collateral } from "src/entities/Collaterals";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { MintingDefaultEvent } from "src/entities/MintingDefaultEvent";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { UserService } from "./user.service";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { Pool } from "src/entities/Pool";
import { DirectMinting } from "src/entities/DirectMinting";
import { RedemptionWithTagRequestedEvent } from "src/entities/RedemptionWithTagRequestedEvent";
import { RedemptionAmountIncompleteEvent } from "src/entities/RedemptionAmountIncompleteEvent";

@Injectable()
export class HistoryService {
    constructor(
        private readonly botService: BotService,
        private readonly em: EntityManager,
        private readonly userService: UserService
    ) {}
    /**
     * Returns all minting and redemption progress for a user from the past 7 days.
     * Optionally includes direct minting progress when an xrpAddress is provided.
     */
    async getProgress(userAddress: string, xrpAddress?: string): Promise<Progress[]> {
        const now = new Date();
        const date = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).getTime();
        const nowDateDay = new Date(now.getTime() - 24 * 60 * 60 * 1000).getTime();
        const nowTimestamp = now.getTime();
        const mints = await this.em.find(Minting, { userAddress: userAddress, timestamp: { $gte: date } });
        /*const redeems = await this.em.find(FullRedemption, {
                userAddress: userAddress.toLowerCase(),
            });*/
        const incompleteRedeems = await this.em.find(IncompleteRedemption, {
            redeemer: userAddress,
        });
        //const redeemTickets = await this.em.find(Redemption, { userAddress: userAddress.toLowerCase() })
        const userProgress: Progress[] = [];
        for (const mint of mints) {
            if (!this.botService.fassetList.includes(mint.fasset)) {
                continue;
            }
            if (Number(mint.timestamp) < date) {
                continue;
            }
            const defaultEvent = await this.em.findOne(MintingDefaultEvent, {
                collateralReservationId: mint.collateralReservationId,
            });
            if (mint.txhash == null && Number(mint.timestamp) < nowDateDay && !defaultEvent) {
                continue;
            }
            let missingUnderlying = false;
            let underlyingTransactionData: MintingTransaction | null = null;
            const isDefaulted = defaultEvent ? true : false;
            const crData = await this.em.findOne(CollateralReservationEvent, {
                paymentReference: mint.paymentReference,
            });
            if (mint.txhash == null) {
                missingUnderlying = true;
                if (!crData || isDefaulted) {
                    missingUnderlying = false;
                } else {
                    const agentName = await this.em.findOne(Pool, {
                        vaultAddress: mint.vaultAddress,
                    });
                    underlyingTransactionData = {
                        paymentReference: crData.paymentReference,
                        destinationAddress: crData.paymentAddress,
                        amount: (BigInt(crData.valueUBA) + BigInt(crData.feeUBA)).toString(),
                        agentName: agentName ? agentName.agentName : "FlareAgent",
                        lastUnderlyingBlock: crData.lastUnderlyingBlock,
                        expirationMinutes: calculateExpirationMinutes(crData.lastUnderlyingTimestamp),
                    };
                }
            }
            const progress = {
                action: "MINT",
                timestamp: Number(mint.timestamp),
                amount: mint.amount,
                fasset: mint.fasset,
                status: mint.processed,
                txhash: crData ? crData.txhash : "Collateral reservation txhash not found.",
                defaulted: isDefaulted,
                missingUnderlying: missingUnderlying,
                underlyingTransactionData: underlyingTransactionData,
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
            const ticketValueUBA = filteredRedeems.reduce((sum, ticket) => sum + BigInt(ticket.valueUBA), 0n);
            //Check if redemption was incomplete
            const incompleteData = incompleteRedeems.find((red) => red.txhash === redeem);
            let incomplete = false;
            if (incompleteData) {
                incomplete = true;
            }
            //Preparation for each default ticket
            for (const ticket of redeemTickets) {
                if (!this.botService.fassetList.includes(ticket.fasset)) {
                    continue;
                }
                const redemptionAmount = formatBigIntToDisplayDecimals(
                    ticketValueUBA,
                    ticket.fasset.includes("XRP") ? 2 : 8,
                    Number(this.botService.getFassetDecimals(ticket.fasset))
                );
                if (ticket.defaulted == true && ticket.processed == true) {
                    // Query the raw chain event directly by requestId instead of the cached RedemptionDefault
                    const defEvent = await this.em.findOne(RedemptionDefaultEvent, {
                        requestId: ticket.requestId,
                    });
                    if (!defEvent) {
                        logger.error(`RedemptionDefaultEvent not found for requestId ${ticket.requestId}`);
                        continue;
                    }
                    // Look up vault collateral token from the agent's Pool
                    const agent = await this.em.find(Pool, { vaultAddress: defEvent.agentVault });
                    const collateralToken = agent[0]?.vaultCollateralToken;
                    if (!collateralToken) {
                        logger.error(`Pool or collateralToken not found for agentVault ${defEvent.agentVault}`);
                        continue;
                    }
                    const collateral = await this.em.find(Collateral, {
                        tokenFtsoSymbol: collateralToken,
                    });
                    const vaultCollateralRedeemed = formatBigIntToDisplayDecimals(
                        BigInt(defEvent.redeemedVaultCollateralWei),
                        collateralToken?.includes("ETH") ? 6 : 3,
                        collateral[0].decimals
                    );
                    const poolCollateralRedeemed = formatBigIntToDisplayDecimals(BigInt(defEvent.redeemedPoolCollateralWei), 3, 18);
                    const progress = {
                        action: "REDEEM",
                        timestamp: Number(ticket.timestamp),
                        amount: redemptionAmount,
                        fasset: ticket.fasset,
                        status: ticket.processed,
                        defaulted: ticket.defaulted,
                        txhash: ticket.txhash,
                        ticketID: ticket.requestId,
                        vaultToken: collateralToken == "USDT" ? "USDT0" : collateralToken,
                        vaultTokenValueRedeemed: vaultCollateralRedeemed,
                        poolTokenValueRedeemed: poolCollateralRedeemed,
                        underlyingPaid: "0",
                        incomplete: incomplete,
                        remainingLots: incompleteData?.remainingLots ?? null,
                        redemptionBlocked: ticket.blocked,
                    };
                    userProgress.push(progress);
                } else {
                    const amount = formatBigIntToDisplayDecimals(
                        BigInt(ticket.amountUBA),
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
                        redemptionBlocked: ticket.blocked,
                    };
                    userProgress.push(progress);
                }
            }
        }
        // --- Direct Minting progress (by XRP address) ---
        if (xrpAddress) {
            const directMintings = await this.em.find(DirectMinting, {
                userAddress: xrpAddress,
                timestamp: { $gte: date },
            });
            for (const dm of directMintings) {
                if (!this.botService.fassetList.includes(dm.fasset)) continue;
                const decimals = dm.fasset.includes("XRP") ? 6 : 8;
                const displayDecimals = dm.fasset.includes("XRP") ? 2 : 8;
                // Use the exact on-chain minted amount when available (executed mintings).
                // For in-progress mintings, estimate by subtracting pre-calculated fees.
                let netAmount: bigint;
                if (dm.mintedAmountUBA != null) {
                    netAmount = BigInt(dm.mintedAmountUBA);
                } else {
                    const grossAmount = BigInt(dm.amount);
                    const fees = BigInt(dm.mintingFeeUBA) + BigInt(dm.executorFeeUBA);
                    netAmount = grossAmount >= fees ? grossAmount - fees : 0n;
                }
                const amount = formatBigIntToDisplayDecimals(netAmount, displayDecimals, decimals);
                const progress: Progress = {
                    action: "MINT",
                    timestamp: Number(dm.timestamp),
                    amount,
                    fasset: dm.fasset,
                    status: dm.processed,
                    defaulted: false,
                    directMinting: true,
                    directMintingStatus: dm.status,
                    // Include delayTimestamp so the FE can show when a delayed minting becomes executable
                    delayTimestamp: dm.delayTimestamp ?? null,
                    // Convert normalized 0x-prefixed lowercase hash back to XRP format (no prefix, uppercase)
                    txhash: dm.txhash.startsWith("0x") ? dm.txhash.slice(2).toUpperCase() : dm.txhash.toUpperCase(),
                    // EVM transaction hash from the resolving event (null until processed)
                    evm_txhash: dm.evm_txhash ?? null,
                };
                userProgress.push(progress);
            }
        }

        // --- Redemption with tag progress ---
        const tagRedemptions = await this.em.find(RedemptionWithTagRequestedEvent, {
            redeemer: userAddress,
            timestamp: { $gte: date },
        });
        for (const tagRedeem of tagRedemptions) {
            if (!this.botService.fassetList.includes(tagRedeem.fasset)) continue;
            const decimals = tagRedeem.fasset.includes("XRP") ? 6 : 8;
            const displayDecimals = tagRedeem.fasset.includes("XRP") ? 2 : 8;
            const amount = formatBigIntToDisplayDecimals(BigInt(tagRedeem.valueUBA), displayDecimals, decimals);
            const underlyingPaid = formatBigIntToDisplayDecimals(BigInt(tagRedeem.valueUBA) - BigInt(tagRedeem.feeUBA), displayDecimals, decimals);
            // Check for amount-based incomplete event
            const amountIncomplete = await this.em.findOne(RedemptionAmountIncompleteEvent, {
                txhash: tagRedeem.txhash,
            });
            const progress: Progress = {
                action: "REDEEM",
                timestamp: Number(tagRedeem.timestamp),
                amount,
                fasset: tagRedeem.fasset,
                status: tagRedeem.processed,
                defaulted: tagRedeem.status === "DEFAULTED",
                redeemWithTag: true,
                redeemStatus: tagRedeem.status,
                destinationTag: tagRedeem.destinationTag,
                ticketID: tagRedeem.requestId,
                remainingAmount: amountIncomplete?.remainingAmountUBA ?? undefined,
                txhash: tagRedeem.txhash,
                underlyingPaid: underlyingPaid,
            };
            userProgress.push(progress);
        }

        // --- RedemptionAmountIncomplete for regular redemptions ---
        const amountIncompleteEvents = await this.em.find(RedemptionAmountIncompleteEvent, {
            redeemer: userAddress,
            timestamp: { $gte: date },
        });
        // Annotate existing REDEEM progress items with remainingAmount and set incomplete flag
        for (const evt of amountIncompleteEvents) {
            const existing = userProgress.find((p) => p.action === "REDEEM" && p.txhash === evt.txhash && !p.redeemWithTag);
            if (existing) {
                existing.remainingAmount = evt.remainingAmountUBA;
                existing.incomplete = true;
            }
        }

        userProgress.sort((a, b) => b.timestamp - a.timestamp);
        return userProgress;
    }
}
