import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Minting } from "../entities/Minting";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { Redemption } from "../entities/Redemption";
import { FullRedemption } from "src/entities/RedemptionWhole";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";

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
        const now = new Date();
        const timestamp = now.getTime();
        const weekTimeStamp = new Date(timestamp - 7 * 24 * 60 * 60 * 1000).getTime();
        //Get and remove potential expired mintings
        await this.em.nativeDelete(Minting, {
            validUntil: { $lt: timestamp },
        });

        /*if (mintings.length > 0) {
            await this.em.removeAndFlush(mintings);
        }*/
        // Get and remove potential unprocessed redemptions
        await this.em.nativeDelete(Redemption, {
            validUntil: { $lt: timestamp },
        });
        /*if (redemptions.length > 0) {
            await this.em.removeAndFlush(redemptions);
        }*/

        // Get and remove full redemptions
        await this.em.nativeDelete(FullRedemption, {
            timestamp: { $lt: weekTimeStamp },
        });
        /*if (fullRedemption.length > 0) {
            await this.em.removeAndFlush(fullRedemption);
        }*/

        // Get and remove redemption defaults
        await this.em.nativeDelete(RedemptionDefault, {
            timestamp: { $lt: weekTimeStamp },
        });
        /*if (defaultedRedemptions.length > 0) {
            await this.em.removeAndFlush(defaultedRedemptions);
        }*/

        // Get and remove incomplete redemptions
        await this.em.nativeDelete(IncompleteRedemption, {
            timestamp: { $lt: weekTimeStamp },
        });
        /*if (incompleteRedemption.length > 0) {
            await this.em.removeAndFlush(incompleteRedemption);
        }*/
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
