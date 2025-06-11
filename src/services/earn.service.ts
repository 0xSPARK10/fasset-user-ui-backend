import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { logger } from "src/logger/winston.logger";
import * as cron from "node-cron";
import axios from "axios";

export type EcosystemApp = {
    type: string;
    pairs: string[];
    coin_type: string;
    url: string;
};

@Injectable()
export class EarnService {
    private ecosystemList: Record<string, EcosystemApp>;
    private jsonUrl: string;
    private network: string;

    constructor(private readonly configService: ConfigService) {
        this.network = this.configService.get<string>("NETWORK", "coston");
        this.jsonUrl = this.configService.get<string>("EARN_JSON_URL", "");
    }

    async onModuleInit() {
        await this.fetchEcosystemData();
    }

    onApplicationBootstrap() {
        cron.schedule("*/5 * * * *", async () => {
            try {
                //console.log("Updating list");
                await this.fetchEcosystemData();
            } catch (error) {
                logger.error(`'Error running get update earn list:`, error);
            }
        });
    }

    async onModuleDestroy() {
        cron.stop();
    }

    private async fetchEcosystemData() {
        if (this.jsonUrl == "" || (this.network != "coston2" && this.network != "flare")) {
            this.ecosystemList = {};
            return;
        }
        try {
            const response = await axios.get(this.jsonUrl);
            const data = response.data;

            if (!data || typeof data !== "object") {
                throw new Error("Invalid ecosystem data format");
            }

            for (const [key, value] of Object.entries(data)) {
                if (typeof value !== "object" || typeof value["type"] !== "string" || !Array.isArray(value["pairs"])) {
                    throw new Error(`Invalid format for app: ${key}`);
                }
            }

            this.ecosystemList = data;
        } catch (error) {
            logger.error(`Failed to fetch ecosystem data: ${error.message}`);
        }
    }

    getEcosystemList(): Record<string, EcosystemApp> {
        return this.ecosystemList;
    }
}
