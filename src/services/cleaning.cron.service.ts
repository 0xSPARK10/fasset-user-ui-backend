import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Minting } from "../entities/Minting";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { Redemption } from "../entities/Redemption";
import { FullRedemption } from "src/entities/RedemptionWhole";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { GuidRedemption } from "src/entities/OFTRedemptionGUID";
import { logger } from "src/logger/winston.logger";
import { OFTReceived } from "src/entities/OFTReceived";
import { OFTSent } from "src/entities/OFTSent";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { OFTRedemption } from "src/entities/OFTRedemption";
import { DirectMinting } from "src/entities/DirectMinting";
import { DirectMintingExecutedEvent } from "src/entities/DirectMintingExecutedEvent";
import { DirectMintingExecutedToSmartAccountEvent } from "src/entities/DirectMintingExecutedToSmartAccountEvent";
import { DirectMintingPaymentTooSmallForFeeEvent } from "src/entities/DirectMintingPaymentTooSmallForFeeEvent";
import { DirectMintingDelayedEvent } from "src/entities/DirectMintingDelayedEvent";
import { LargeDirectMintingDelayedEvent } from "src/entities/LargeDirectMintingDelayedEvent";
import { RedemptionWithTagRequestedEvent } from "src/entities/RedemptionWithTagRequestedEvent";
import { RedemptionAmountIncompleteEvent } from "src/entities/RedemptionAmountIncompleteEvent";

@Injectable()
export class CleaningService {
    private readonly em: EntityManager;
    constructor(private readonly orm: MikroORM) {
        this.em = this.orm.em.fork();
    }

    // This function checks for unprocessed mintings and redemptions that are older than 8 days and deletes them as they cannot be processed anymore
    // as proofs are not available anymores
    @Cron("0 0 * * *")
    async deleteOldMintingsREdemptions(): Promise<void> {
        try {
            const now = new Date();
            const timestamp = now.getTime();
            const weekTimeStamp = new Date(timestamp - 7 * 24 * 60 * 60 * 1000).getTime();
            //Get and remove potential expired mintings
            await this.em.nativeDelete(Minting, {
                timestamp: { $lt: weekTimeStamp },
            });
            // Get and remove potential unprocessed redemptions
            await this.em.nativeDelete(Redemption, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Get and remove full redemptions
            await this.em.nativeDelete(FullRedemption, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Get and remove redemption defaults
            await this.em.nativeDelete(RedemptionDefault, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Get and remove incomplete redemptions
            await this.em.nativeDelete(IncompleteRedemption, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Get and remove incomplete redemptions
            await this.em.nativeDelete(GuidRedemption, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Get and remove incomplete redemptions
            await this.em.nativeDelete(OFTReceived, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Get and remove incomplete redemptions
            await this.em.nativeDelete(OFTSent, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Get and remove incomplete redemptions
            await this.em.nativeDelete(CollateralReservationEvent, {
                timestamp: { $lt: weekTimeStamp },
            });
            // Get and remove incomplete redemptions
            await this.em.nativeDelete(OFTRedemption, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Clean up direct minting entities
            await this.em.nativeDelete(DirectMinting, {
                timestamp: { $lt: weekTimeStamp },
            });
            await this.em.nativeDelete(DirectMintingExecutedEvent, {
                timestamp: { $lt: weekTimeStamp },
            });
            await this.em.nativeDelete(DirectMintingExecutedToSmartAccountEvent, {
                timestamp: { $lt: weekTimeStamp },
            });
            await this.em.nativeDelete(DirectMintingPaymentTooSmallForFeeEvent, {
                timestamp: { $lt: weekTimeStamp },
            });
            await this.em.nativeDelete(DirectMintingDelayedEvent, {
                timestamp: { $lt: weekTimeStamp },
            });
            await this.em.nativeDelete(LargeDirectMintingDelayedEvent, {
                timestamp: { $lt: weekTimeStamp },
            });

            // Clean up redemption with tag entities
            await this.em.nativeDelete(RedemptionWithTagRequestedEvent, {
                timestamp: { $lt: weekTimeStamp },
            });
            await this.em.nativeDelete(RedemptionAmountIncompleteEvent, {
                timestamp: { $lt: weekTimeStamp },
            });
        } catch (error) {
            logger.error("Error cleanup events", error);
        }
    }

    // This function checks for unprocessed mintings and redemptions that are older than 1 day and deletes them as they cannot be processed anymore
    // as proofs are not available anymore
    @Cron("0 * * * *")
    async deleteExpiredUnprocessedMintingsREdemptions(): Promise<void> {
        const now = new Date();
        const timestamp = now.getTime();
        const dayTimeStamp = new Date(timestamp - 24 * 60 * 60 * 1000).getTime();
        //Get and remove potential expired mintings
        await this.em.nativeDelete(Minting, {
            timestamp: { $lt: dayTimeStamp },
            processed: false,
        });

        /*if (mintings.length > 0) {
            await this.em.removeAndFlush(mintings);
        }*/
    }
}
