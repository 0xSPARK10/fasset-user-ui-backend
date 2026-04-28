import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ethers, FetchRequest } from "ethers";
import { join } from "path";
import https from "https";
import { readFileSync } from "fs";
import { FassetConfigService } from "./fasset.config.service";
import { formatFixedBigInt, bigintPow10 } from "src/utils/utils";
import { HttpService } from "@nestjs/axios";
import { logger } from "src/logger/winston.logger";
import axios from "axios";
import * as cron from "node-cron";
import { Rewards } from "src/interfaces/structure";

@Injectable()
export class RewardsService {
    private provider: ethers.JsonRpcProvider;
    private contract: ethers.Contract;
    private projectId: number;
    private dalUrls: string[];
    private dalApiKey: string;
    private flrPrice: number;
    private flrDecimals: number;
    private rewardsAPI: string;
    private rewardsKey: string;
    private network: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly httpService: HttpService,
        private readonly fassetConfigService: FassetConfigService
    ) {
        const rpcUrl = this.configService.get<string>("FLR_RPC");
        const apiKey = this.configService.get<string>("FLR_RPC_API_KEY");
        this.rewardsAPI = this.configService.get<string>("REWARDS_API");
        this.rewardsKey = this.configService.get<string>("REWARDS_API_KEY");
        this.network = this.configService.get<string>("NETWORK", "coston-bot.json");
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

        // Get DAL URLs from FassetConfigService instead of reading bot config file again
        this.dalUrls = this.fassetConfigService.getDataAccessLayerUrls();
        // Get DAL API key from env var instead of secrets.json
        this.dalApiKey = (this.configService.get<string>("DAL_API_KEYS") || "")
            .split(",")
            .map((k) => k.trim())[0] || "";
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
        const rewardTickets = await this.getRewardsAPI(address);
        const percentage = rewardTickets.total_tickets != 0 ? (rewardTickets.address_tickets / rewardTickets.total_tickets) * 100 : 0;
        const prevRewards = await this.getPrevRewardsUser(address);
        const place = prevRewards.place == -1 ? 500 : prevRewards.place;
        return {
            claimedRflr: claimed.rflr,
            claimedUsd: claimed.usd,
            claimableRflr: claimable.rflr,
            claimableUsd: claimable.usd,
            points: "0",
            share: percentage.toFixed(4),
            numTickets: rewardTickets.address_tickets,
            prevBiweeklyPlace: place,
            prevBiweeklyRflr: prevRewards.rewardRFLR,
            prevBiweeklyRflrUSD: prevRewards.rewardUSD,
            participated: prevRewards.participated,
            rewardsDistributed: prevRewards.distributed,
        };
    }

    async getPrevRewardsUser(address: string): Promise<any> {
        const rewards = await this.getRewardsAmountAPI(address);
        const price = await this.getFlrPrice();
        const rewardBigInt = BigInt(rewards.reward.toLocaleString("fullwide", { useGrouping: false }));
        const rewardUSD = (rewardBigInt * BigInt(price.price)) / bigintPow10(price.decimals);
        const usdFormatted = formatFixedBigInt(rewardUSD, 18, {
            decimals: 6,
            groupDigits: true,
            groupSeparator: ",",
        });
        const rewardRFLR = formatFixedBigInt(rewardBigInt, 18, {
            decimals: 6,
            groupDigits: true,
            groupSeparator: ",",
        });
        const userParticipation = await this.getUserParticipated(address);
        const participated = rewards.place == -1 ? false || userParticipation.participated : true;
        return {
            place: rewards.place,
            rewardUSD: usdFormatted,
            rewardRFLR: rewardRFLR,
            participated: participated,
            distributed: userParticipation.distributed,
        };
    }

    async getUserParticipated(address: string): Promise<any> {
        const tcikets = await this.getRewardsTicketsHistory(address);
        if (tcikets.address_tickets == 0) {
            return { participated: false, distributed: true };
        } else {
            if (tcikets.address_tickets == -1) {
                return { participated: false, distributed: false };
            } else {
                return { participated: true, distributed: true };
            }
        }
    }

    async getClaimedRewards(address: string): Promise<Rewards> {
        const months = await this.getProjectInfo();
        let rewardsClaimed = 0n;
        for (let i = 0; i < months.length; i++) {
            let rewardsClaimedForMonth = 0n;
            try {
                const rewards = await this.contract.getOwnerRewardsInfo(this.projectId, Number(months[i]), address);
                rewardsClaimedForMonth = BigInt(rewards[1]);
            } catch (error) {
                logger.error("Error fetching owner rewards info", error);
            }
            rewardsClaimed += rewardsClaimedForMonth;
        }
        const price = await this.getFlrPrice();
        const claimedUsd = (rewardsClaimed * BigInt(price.price)) / bigintPow10(price.decimals);
        const claimedRflr = formatFixedBigInt(rewardsClaimed, 18, {
            decimals: 6,
            groupDigits: true,
            groupSeparator: ",",
        });
        const usdFormatted = formatFixedBigInt(claimedUsd, 18, {
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

        const axiosInstance = axios.create({
            httpsAgent: agent,
            headers: {
                "x-apikey": this.dalApiKey,
                "x-api-key": this.dalApiKey,
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

        const axiosInstance = axios.create({
            httpsAgent: agent,
            headers: {
                "x-apikey": this.dalApiKey,
                "x-api-key": this.dalApiKey,
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
            const claimable = BigInt(r);
            const price = await this.getFlrPrice();
            const claimableUsd = (claimable * BigInt(price.price)) / bigintPow10(price.decimals);
            const usdFormatted = formatFixedBigInt(claimableUsd, 18, {
                decimals: 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            const claimableRflr = formatFixedBigInt(claimable, 18, {
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
            const response = await axiosInstance.get(`${this.rewardsAPI}/reward_tickets/` + address);
            if (response.status == 500) {
                return { address_tickets: 0, total_tickets: 0 };
            }
            return response.data;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
            // Handle errors
            //logger.error("Error fetching rewards api:", error);
            return { address_tickets: 0, total_tickets: 0 };
        }
    }

    async getRewardsAmountAPI(address: string): Promise<any> {
        const agent = new https.Agent({ rejectUnauthorized: false });

        const axiosInstance = axios.create({
            httpsAgent: agent, // Use the Agent in the Axios instance configuration,
        });
        try {
            const response = await axiosInstance.get(`${this.rewardsAPI}/reward_amount/` + address);
            if (response.status == 500) {
                return { place: -1, reward: 0 };
            }
            return response.data;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
            // Handle errors
            //logger.error("Error fetching rewards api:", error);
            return { place: -1, reward: 0 };
        }
    }

    async getRewardsTicketsHistory(address: string): Promise<any> {
        const agent = new https.Agent({ rejectUnauthorized: false });

        const axiosInstance = axios.create({
            httpsAgent: agent, // Use the Agent in the Axios instance configuration,
        });
        try {
            const response = await axiosInstance.get(`${this.rewardsAPI}/reward_tickets_history/` + address);
            if (response.status == 500) {
                return { address_tickets: 0 };
            }
            return response.data;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (error) {
            // Handle errors
            //logger.error("Error fetching rewards api:", error);
            return { address_tickets: 0 };
        }
    }
}
