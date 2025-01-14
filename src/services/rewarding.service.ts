import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ethers, FetchRequest } from "ethers";
import { join } from "path";
import https from "https";
import { readFileSync } from "fs";
import { BotService } from "./bot.init.service";
import { toBN, toBNExp } from "node_modules/@flarelabs/fasset-bots-core/dist/src/utils/helpers";
import { formatFixed } from "node_modules/@flarelabs/fasset-bots-core/dist/src/utils/formatting";
import { HttpService } from "@nestjs/axios";
import { logger } from "src/logger/winston.logger";
import axios from "axios";
import * as cron from "node-cron";
import { Rewards } from "src/interfaces/structure";

const REWARDS = 37142;

@Injectable()
export class RewardsService {
    private provider: ethers.JsonRpcProvider;
    private contract: ethers.Contract;
    private projectId: number;
    private dalUrls: string[];
    private flrPrice: number;
    private flrDecimals: number;
    private rewardsAPI: string;
    private rewardsKey: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly botService: BotService,
        private readonly httpService: HttpService
    ) {
        const rpcUrl = this.configService.get<string>("FLR_RPC");
        const apiKey = this.configService.get<string>("FLR_RPC_API_KEY");
        this.rewardsAPI = this.configService.get<string>("REWARDS_API");
        this.rewardsKey = this.configService.get<string>("REWARDS_API_KEY");
        const connection = new FetchRequest(rpcUrl);
        if (apiKey !== undefined) {
            connection.setHeader("x-api-key", apiKey);
            connection.setHeader("x-apikey", apiKey);
        }
        this.provider = new ethers.JsonRpcProvider(connection);
        const abiPath = join(__dirname, "../../", "src/utils/rflrContract.json");
        const contractAbi = JSON.parse(readFileSync(abiPath, "utf8"));
        //RFLR contract address
        const contractAddress = "0x26d460c3Cf931Fb2014FA436a49e3Af08619810e";
        this.contract = new ethers.Contract(contractAddress, contractAbi, this.provider);
        this.projectId = 4;

        const pathForConfig = process.env.APP_TYPE == "dev" ? "coston-bot.json" : "songbird-bot.json";
        const filePathConfig = join(__dirname, "../..", "src", pathForConfig);
        const configFile = readFileSync(filePathConfig, "utf-8");
        const configContent = JSON.parse(configFile);
        this.dalUrls = configContent.dataAccessLayerUrls;
    }

    onApplicationBootstrap() {
        cron.schedule("*/2 * * * *", async () => {
            try {
                console.log("Updating price");
                const ids = await this.getFeedIdForFlare();
                await this.getFlarePrice(ids);
                console.log("Updated price");
            } catch (error) {
                logger.error(`'Error running getTimeData:`, error);
            }
        });
    }

    async onModuleDestroy() {
        cron.stop();
    }

    async getRewardsForUser(address: string): Promise<any> {
        const claimed = await this.getClaimedRewards(address);
        const claimable = await this.getClaimableRewards(address);
        const rewardsUsd = await this.getRewardsAPI(address);
        const percentage = (rewardsUsd / REWARDS) * 100;
        return {
            claimedRflr: claimed.rflr,
            claimedUsd: claimed.usd,
            claimableRflr: claimable.rflr,
            claimableUsd: claimable.usd,
            points: "0",
            share: percentage.toFixed(4),
            shareUsd: rewardsUsd.toFixed(2),
        };
    }

    async getClaimedRewards(address: string): Promise<Rewards> {
        const months = await this.getProjectInfo();
        let rewardsClaimed = toBN(0);
        for (let i = 0; i < months.length; i++) {
            let rewardsClaimedForMonth = BigInt(0);
            try {
                const rewards = await this.contract.getOwnerRewardsInfo(this.projectId, Number(months[i]), address);
                rewardsClaimedForMonth = rewards[1];
            } catch (error) {
                logger.error("Error fetching owner rewards info", error);
            }
            rewardsClaimed = rewardsClaimed.add(toBN(BigInt(rewardsClaimedForMonth).toString()));
        }
        const price = await this.getFlrPrice();
        const claimedUsd = toBN(rewardsClaimed).mul(toBN(price.price)).div(toBNExp(1, price.decimals));
        const claimedRflr = formatFixed(toBN(rewardsClaimed), 18, {
            decimals: 6,
            groupDigits: true,
            groupSeparator: ",",
        });
        const usdFormatted = formatFixed(toBN(claimedUsd), 18, {
            decimals: 6,
            groupDigits: true,
            groupSeparator: ",",
        });
        return { usd: usdFormatted, rflr: claimedRflr };
    }

    async getFlrPrice(): Promise<any> {
        if (!this.flrPrice) {
            const ids = await this.getFeedIdForFlare();
            await this.getFlarePrice(ids);
        }
        return { price: this.flrPrice, decimals: this.flrDecimals };
    }

    async getFeedIdForFlare(): Promise<any> {
        const agent = new https.Agent({ rejectUnauthorized: false });
        const s = this.botService.getSecrets();

        const axiosInstance = axios.create({
            httpsAgent: agent, // Use the Agent in the Axios instance configuration,
            headers: {
                "x-apikey": s.data.apiKey.data_access_layer[0],
                "x-api-key": s.data.apiKey.data_access_layer[0],
            },
        });
        try {
            const response = await axiosInstance.get(`${this.dalUrls[0]}/api/v0/ftso/anchor-feed-names`);
            const flrFeed = response.data.find((item) => item.feed_name === "FLR/USD");
            return flrFeed.feed_id;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching flare feed id:", error);
            throw error;
        }
    }

    async getFlarePrice(feedid: string): Promise<any> {
        const agent = new https.Agent({ rejectUnauthorized: false });
        const s = this.botService.getSecrets();

        const axiosInstance = axios.create({
            httpsAgent: agent, // Use the Agent in the Axios instance configuration,
            headers: {
                "x-apikey": s.data.apiKey.data_access_layer[0],
                "x-api-key": s.data.apiKey.data_access_layer[0],
            },
        });
        const requestBody = {
            feed_ids: [feedid],
        };
        try {
            const response = await axiosInstance.post(`${this.dalUrls[0]}/api/v0/ftso/anchor-feeds-with-proof`, requestBody);
            this.flrPrice = response.data[0].body.value;
            this.flrDecimals = response.data[0].body.decimals;
            return response;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching flare price for feed:", error);
            throw error;
        }
    }

    async getProjectInfo(): Promise<any> {
        //Todo change to prid for fassets
        try {
            const info = await this.contract.getProjectInfo(this.projectId);
            const months = info[9];
            return months;
        } catch (error) {
            logger.error("Error fetching project info", error);
            return [0];
        }
    }

    async getClaimableRewards(address: string): Promise<Rewards> {
        //const address = "0xDAF667A846eBE962D2F7eCD459B3be157eBf52BB";
        try {
            const r = await this.contract.getClaimableRewards(this.projectId, address);
            const claimable = toBN(BigInt(r).toString());
            const price = await this.getFlrPrice();
            const claimableUsd = toBN(claimable).mul(toBN(price.price)).div(toBNExp(1, price.decimals));
            const usdFormatted = formatFixed(toBN(claimableUsd), 18, {
                decimals: 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            const claimableRflr = formatFixed(toBN(claimable), 18, {
                decimals: 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            return { usd: usdFormatted, rflr: claimableRflr };
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
            return { usd: "0", rflr: "0" };
        }
    }

    async getRewardsAPI(address: string): Promise<any> {
        const agent = new https.Agent({ rejectUnauthorized: false });

        const axiosInstance = axios.create({
            httpsAgent: agent, // Use the Agent in the Axios instance configuration,
        });
        try {
            const response = await axiosInstance.get(`${this.rewardsAPI}/reward_amount/` + address);
            if (response.status == 500) {
                return 0;
            }
            return response.data.reward_amount;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
            // Handle errors
            //logger.error("Error fetching rewards api:", error);
            return 0;
        }
    }
}
