/* eslint-disable @typescript-eslint/no-explicit-any */
import { CollateralClass, InfoBotCommands, TokenPriceReader, UserBotCommands } from "@flarelabs/fasset-bots-core";
import { IRelayInstance, Truffle } from "@flarelabs/fasset-bots-core/types";
import { MAX_BIPS, artifacts, formatFixed, toBN, toBNExp, web3 } from "@flarelabs/fasset-bots-core/utils";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { join } from "path";
import { Pool } from "../entities/Pool";
import * as cron from "node-cron";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { lastValueFrom } from "rxjs";
import { BlockNumber, Log } from "web3-core";
import { Liveness } from "../entities/AgentLiveness";
import { readFileSync } from "fs";
import { NETWORK_SYMBOLS } from "src/utils/constants";
import {
    CurrencyMap,
    EcosystemData,
    AssetManagerFasset,
    FassetDecimals,
    FassetSupplyDiff,
    FassetTimeSupply,
    PoolCollateralDiff,
    PoolRewards,
    Price,
    SupplyFasset,
    SupplyTotalCollateral,
    TimeData,
    TimeSeries,
    TimeSeriesIndexer,
    TopPool,
    TopPoolData,
} from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { AxiosRequestConfig } from "axios";
import { Collateral } from "src/entities/Collaterals";
import { calculateOvercollateralizationPercentage, sumUsdStrings } from "src/utils/utils";
import { ExternalApiService } from "./external.api.service";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { RedemptionRejected } from "src/entities/RedemptionRejected";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { RedemptionTakenOver } from "src/entities/RedemptionTakenOver";
import { CrRejectedCancelledEvent } from "src/entities/CollateralReservationRejected";
//import { IdentityVerificationEvent } from "src/entities/IdentityVerification";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { HandshakeEvent } from "src/entities/Handshake";
import { Secrets } from "node_modules/@flarelabs/fasset-bots-core/dist/src/config/secrets";
import { EvmEvent } from "node_modules/@flarelabs/fasset-bots-core/dist/src/utils/events/common";
import { Web3ContractEventDecoder } from "node_modules/@flarelabs/fasset-bots-core/dist/src/utils/events/Web3ContractEventDecoder";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";

const IRelay = artifacts.require("IRelay");
const IERC20 = artifacts.require("IERC20Metadata");
const CollateralPool = artifacts.require("CollateralPool");

@Injectable()
export class BotService implements OnModuleInit {
    private botMap: Map<string, UserBotCommands> = new Map();
    private infoBotMap: Map<string, InfoBotCommands> = new Map();
    private relay: IRelayInstance;
    private isRunning: boolean = false;
    private apiUrl: string;
    private costonBotPath: string;
    private username: string;
    private password: string;
    private lastEventBlockMap: Map<string, number> = new Map();
    private lastEventBlock: number;
    private fassetSymbol: Map<string, string> = new Map();
    private secrets: Secrets;
    em: EntityManager;
    fassetList: string[] = [];
    ecosystemTVL: string;
    ecosystemTransactions: string = "0";
    assetManagerList: AssetManagerFasset[] = [];
    assetManagerAddressList: string[] = [];
    agentPingResponseTopic: string;
    collateralReservedTopic: string;
    redemptionRequestRejectedTopic: string;
    redemptionRequestTakenOverTopic: string;
    redemptionRequestedTopic: string;
    //Needed events for cr rejected and redemption request updated/deleted
    collateralReservationRejectedTopic: string;
    collateralReservationCancelledTopic: string;
    eventTopics: string[] = [];
    //identityVerificationTopic: string;
    fassetDecimals: FassetDecimals[] = [];
    agentsInLiquidation: number = 0;
    fassetCirculatingSupply: SupplyFasset[] = [];
    collateralCirculatingSupply: SupplyTotalCollateral[] = [];
    mintedAll: string = "0";
    numAgents: number = 0;
    numberOfLiquidations: number = 0;
    rewardsAvailableUSD: string = "0";
    overCollaterized: string = "0";
    collateralTokenList: string[] = [];
    totalCollateral: string = "0";
    tvlPools: string = "0";
    tvlPoolsNat: string = "0";
    numMints: number = 0;
    totalPoolRewardsPaidUSD: string = "0";
    poolRewards: PoolRewards[] = [];
    holders: number = 0;
    topPools: TopPoolData[] = [];
    envType: string;
    agentPoolCollateral: string = "0";

    constructor(
        private readonly orm: MikroORM,
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
        private readonly externalApiService: ExternalApiService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache
    ) {
        this.apiUrl = this.configService.get<string>("API_URL");
        this.costonBotPath = this.configService.get<string>("BOT_CONFIG_PATH");
        this.username = this.configService.get<string>("USER_API");
        this.password = this.configService.get<string>("PASS_API");
        this.envType = this.configService.get<string>("APP_TYPE");
    }

    async onModuleInit() {
        logger.info(`Initializing BotService ...`);
        this.em = this.orm.em.fork();
        let pathForConfig = this.costonBotPath;
        if (!pathForConfig) {
            pathForConfig = this.envType == "dev" ? "coston-bot.json" : "songbird-bot.json";
        }
        // Initialize the variable here
        const filePathSecrets = join(__dirname, "../..", "src", "secrets.json");
        const filePathConfig = join(__dirname, "../..", "src", pathForConfig);
        const userDataDirPath = join(__dirname, "../..", "src", "userDataDir");
        // Change config file based on env.
        this.eventTopics = [
            web3.utils.keccak256("AgentPingResponse(address,address,uint256,string)"),
            web3.utils.keccak256("CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)"),
            web3.utils.keccak256("RedemptionRequestRejected(address,address,uint64,string,uint256)"),
            web3.utils.keccak256("RedemptionRequestTakenOver(address,address,uint64,uint256,address,uint64)"),
            web3.utils.keccak256("RedemptionRequested(address,address,uint256,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256)"),
            web3.utils.keccak256("CollateralReservationRejected(address,address,uint256)"),
            web3.utils.keccak256("CollateralReservationCancelled(address,address,uint256)"),
            web3.utils.keccak256("HandshakeRequired(address,address,uint256,string[],uint256,uint256)"),
            web3.utils.keccak256("RedemptionDefault(address,address,uint64,uint256,uint256,uint256)"),
        ];
        //this.identityVerificationTopic = web3.utils.keccak256("IdentityVerificationRequired(address,addres,uint256,uint256,uint256)");

        const configFileContent = readFileSync(filePathConfig, "utf-8");
        const config = JSON.parse(configFileContent);
        const fassets = Object.keys(config.fAssets);
        // eslint-disable-next-line @typescript-eslint/await-thenable
        this.secrets = await Secrets.load(filePathSecrets);
        this.ecosystemTVL = "0";

        for (const fasset of fassets) {
            logger.info(`Initializing BotService for fasset ${fasset}`);
            this.fassetList.push(fasset);
            this.botMap.set(fasset, await UserBotCommands.create(filePathSecrets, filePathConfig, fasset, userDataDirPath));
            this.infoBotMap.set(fasset, await InfoBotCommands.create(this.secrets, filePathConfig, fasset));
            this.lastEventBlockMap.set(fasset, (await web3.eth.getBlockNumber()) - this.infoBotMap.get(fasset).context.nativeChainInfo.finalizationBlocks);
            this.assetManagerList.push({ fasset: fasset, assetManager: this.infoBotMap.get(fasset).context.assetManager.address });
            this.lastEventBlock = (await web3.eth.getBlockNumber()) - 4;
            this.assetManagerAddressList.push(this.infoBotMap.get(fasset).context.assetManager.address);
            this.fassetDecimals.push({ fasset: fasset, decimals: (await this.infoBotMap.get(fasset).context.fAsset.decimals()).toNumber() });
            this.fassetSymbol.set(fasset, await this.infoBotMap.get(fasset).context.fAsset.assetSymbol());
            const collateralTypes = await this.infoBotMap.get(fasset).context.assetManager.getCollateralTypes();
            for (const c of collateralTypes) {
                if (Number(c.collateralClass) != CollateralClass.VAULT) {
                    continue;
                }
                if (Number(c.validUntil) != 0 && Number(c.validUntil) * 1000 < Date.now()) {
                    continue;
                }
                if (!this.collateralTokenList.includes(c.tokenFtsoSymbol)) {
                    this.collateralTokenList.push(c.tokenFtsoSymbol);
                }
            }
        }
        const contractPath = config.contractsJsonFile;
        const filePathContracts = join(__dirname, "../..", "src", contractPath);
        const data = JSON.parse(readFileSync(filePathContracts, "utf-8"));
        // Find the object with name "Relay"
        const relay = data.find((entry) => entry.name === "Relay");
        this.relay = await IRelay.at(relay.address);
        //this.lastEventBlock = 17581700;
        await this.getPools();
        await this.getTimeData();
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        setImmediate(async () => {
            await this.readEvents();
        });
        cron.schedule("*/30 * * * *", async () => {
            try {
                await this.getTimeData();
            } catch (error) {
                logger.error(`'Error running getTimeData:`, error);
            }
        });
        cron.schedule("*/1 * * * *", async () => {
            if (!this.isRunning) {
                this.isRunning = true;
                try {
                    await this.getPools();
                    //await this.readEvents();
                } catch (error) {
                    logger.error(`'Error running getPools:`, error);
                } finally {
                    this.isRunning = false;
                }
            }
        });
    }

    async onModuleDestroy() {
        cron.stop();
    }

    private getAuthHeaders(): AxiosRequestConfig["headers"] {
        return {
            Authorization: "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64"),
            "Content-Type": "application/json",
        };
    }

    async calculateFassetSupplyDiff(supply: any): Promise<FassetSupplyDiff[]> {
        //TODO fix test, production
        const diffs: FassetSupplyDiff[] = [];
        for (const f of this.fassetList) {
            const netw = NETWORK_SYMBOLS.find((item) => (this.envType == "dev" ? item.test : item.real) === f);
            if (supply[netw.real]) {
                const data = supply[netw.real];
                const diff = Number(data[1].value) - Number(data[0].value);
                const percentage = Number(data[0].value) == 0 ? 100 : (diff / Number(data[0].value)) * 100;
                const n = this.envType == "dev" ? netw.test : netw.real;
                diffs.push({ fasset: n, diff: Math.abs(percentage).toFixed(1), isPositive: diff >= 0 });
            } else {
                diffs.push({ fasset: f, diff: "100.0", isPositive: true });
            }
        }
        return diffs;
    }

    private isEmptyObject(obj: unknown): boolean {
        return typeof obj === "object" && obj !== null && Object.keys(obj).length === 0;
    }

    async calculatePoolRewardsDiff(rewards: any): Promise<PoolCollateralDiff> {
        //TODO fix test, production
        const diff = Number(rewards[1].value) - Number(rewards[0].value);
        const percentage = Number(rewards[0].value) == 0 ? 100 : (diff / Number(rewards[0].value)) * 100;
        return { diff: Math.abs(percentage).toFixed(2), isPositive: diff >= 0 };
    }

    async calculatePoolCollateralDiff(rewards: FassetTimeSupply[]): Promise<PoolCollateralDiff> {
        //TODO fix test, production
        const diff = Number(rewards[1].value) / 10 ** 18 - Number(rewards[0].value) / 10 ** 18;
        const percentage = Number(rewards[0].value) == 0 ? 100 : (diff / (Number(rewards[0].value) / 10 ** 18)) * 100;
        return { diff: Math.abs(percentage).toFixed(2), isPositive: diff >= 0 };
    }

    async formatTimeSeries(data: TimeSeriesIndexer[]): Promise<TimeSeries[]> {
        const timeSeries: TimeSeries[] = [];
        for (let i = 0; i < data.length; i++) {
            const valueUSD = formatFixed(toBN(data[i].value), 8, {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            });
            timeSeries.push({ timestamp: Math.floor(data[i].end), value: valueUSD });
        }
        return timeSeries;
    }

    //Get time data for landing page
    async getTimeData(): Promise<void> {
        //Loop for hour, week, month, year
        logger.info("Updating time data");
        let diffs = [];
        for (let i = 0; i <= 5; i++) {
            let timeScopeAPI;
            let timeScopeTime;
            let n;
            const topPoolsData: TopPool[] = [];
            switch (i) {
                case 0:
                    timeScopeAPI = "day";
                    timeScopeTime = 24 * 60 * 60;
                    n = 6;
                    break;
                case 1:
                    timeScopeAPI = "week";
                    timeScopeTime = 7 * 24 * 60 * 60;
                    n = 6;
                    break;
                case 2:
                    timeScopeAPI = "month";
                    timeScopeTime = 30 * 24 * 60 * 60;
                    n = 12;
                    break;
                case 3:
                    timeScopeAPI = "year";
                    timeScopeTime = 365 * 24 * 60 * 60;
                    n = 12;
                    break;
                case 4:
                    timeScopeAPI = "yearToDate";
                    const now = new Date();
                    const startOfYear = new Date(now.getFullYear(), 0, 1);
                    timeScopeTime = Math.floor((Date.now() - startOfYear.getTime()) / 1000);
                    n = 12;
                    break;
                case 5:
                    timeScopeAPI = "allTime";
                    timeScopeTime = 5 * 365 * 24 * 60 * 60;
                    n = 12;
                    break;
                default:
                    continue;
            }
            let lookback = timeScopeAPI;
            if (lookback != "year" && lookback != "month" && lookback != "week" && lookback != "day") {
                lookback = "year";
            }
            const now = Math.floor(Date.now() / 1000);
            const dayTimestamp = Math.floor(now) - timeScopeTime;
            for (const p of this.topPools) {
                const netw = NETWORK_SYMBOLS.find((item) => (this.envType == "dev" ? item.test : item.real) === p.fasset);
                const collectedPoolFees = await this.externalApiService.getCollectedPoolFeesDiff(dayTimestamp.toString(), now.toString(), p.poolAddress);
                const collateralPoolDiff = await this.externalApiService.getPoolCollateralDiff(dayTimestamp.toString(), now.toString(), p.poolAddress);
                const diffTvl = await this.calculatePoolCollateralDiff(collateralPoolDiff);
                let diffRewards;
                if (Object.keys(collectedPoolFees).length === 0) {
                    diffRewards = await this.calculatePoolRewardsDiff([
                        { timestamp: 123, value: "0" },
                        { timestamp: 1234, value: "0" },
                    ]);
                } else {
                    if (Object.keys(collectedPoolFees).length === 1) {
                        diffRewards = await this.calculatePoolRewardsDiff([{ timestamp: 123, value: "0" }, collectedPoolFees[netw.real][0]]);
                    } else {
                        diffRewards = await this.calculatePoolRewardsDiff(collectedPoolFees[netw.real]);
                    }
                }
                topPoolsData.push({
                    name: p.name,
                    vaultAddress: p.vaultAddress,
                    poolAddress: p.poolAddress,
                    fasset: p.fasset,
                    collateralSymbol: p.collateralSymbol,
                    tvl: p.tvl,
                    rewardsPaid: p.rewardsPaid,
                    url: p.url,
                    tvlDiff: diffTvl.diff,
                    tvlDiffPositive: diffTvl.isPositive,
                    rewardsDiff: diffRewards.diff,
                    rewardsDiffPositive: diffRewards.isPositive,
                });
            }
            const supply = await this.externalApiService.getFassetSupplyDiff(dayTimestamp.toString(), now.toString());
            if (this.isEmptyObject(supply)) {
                for (const f of this.fassetList) {
                    diffs.push({ fasset: f, diff: "0.0", isPositive: true });
                }
            } else {
                diffs = await this.calculateFassetSupplyDiff(supply);
            }
            let pointMint = await this.externalApiService.getMintTimeseries(now, n, dayTimestamp);
            if (this.isEmptyObject(pointMint) || pointMint == 0 || pointMint.length == 0) {
                pointMint = [];
                pointMint.push({
                    index: 0,
                    start: dayTimestamp,
                    end: now,
                    value: "0",
                });
            }
            let pointRedeem = await this.externalApiService.getRedeemTimeseries(now, n, dayTimestamp);
            if (this.isEmptyObject(pointRedeem) || pointRedeem == 0 || pointRedeem.length == 0) {
                pointRedeem = [];
                pointRedeem.push({
                    index: 0,
                    start: dayTimestamp,
                    end: now,
                    value: "0",
                });
            }
            const graphMints = await this.formatTimeSeries(pointMint);
            const graphRedeems = await this.formatTimeSeries(pointRedeem);
            const totalCollateralDifference = await this.externalApiService.getTotalPoolCollateralDiff(dayTimestamp.toString(), now.toString());
            const totalCollateralDiff = await this.calculatePoolCollateralDiff(totalCollateralDifference);
            const timeData: TimeData = {
                supplyDiff: diffs,
                mintGraph: graphMints,
                redeemGraph: graphRedeems,
                bestPools: topPoolsData,
                totalCollateralDiff: totalCollateralDiff.diff,
                isPositiveCollateralDiff: totalCollateralDiff.isPositive,
            };
            await this.cacheManager.set(timeScopeAPI + "Data", timeData, 0);
        }
        logger.info("Finished updating time data");
    }

    /*
    TODO: V2 changes:
    Read collateral reservation events, the Identity reservation events will get parsed from cr transaction.
    When you get collateral reservation event that corresponds to indetity reservation event, back can return data to front to
    proceed to underlying payment for the specific minting. 
    Identity verification - CR event can be the same entity with null values for data which is not present in identity verification event.
    TODO: Add reader for events collateral reservation cancelled/rejected when they will be implemented
    TODO: update contract artifacts when new code is available for identity verification and trailing fees.
    TODO: add removing old cr events and identity verification events
    Add reader for redemption rejected and redemption taken over. When a redemption is taken over a new id is assigned to it -> change in db ticket id.
    If rejection.timestamp + settings.takeOverRedemptionRequestWindowSeconds have passed without a takeover, executor calls rejectedRedemptionPaymentDefault(redemption requestid)
    Needed events: collateral reservation rejected/cancelled, redemption request updated(if takeover was not whole)

    Redemption flow:
    User redeems, for each ticket add info if the agent requires handshake and if it was rejected. Then read for events that redemption request id was rejected and flag if it was,
    then add new created tickets that are present in redemption request taken over events (you get old ticket-new ticket). Also need events for if the 
    old request id was just updated or destroyed so old requests can get deleted. Runner service should now also check if rejected tickets were not taken over in 
    (request.rejectionTimestamp + settings.takeOverRedemptionRequestWindowSeconds) 
    and call rejectedRedemptionPaymentDefault.

    Mint flow:

    */
    async readEvents(): Promise<void> {
        const blockReadOffset = 30;
        const bot = this.getInfoBot(this.fassetList[0]);
        while (true) {
            try {
                const timestamp = Date.now();
                const lastBlock = (await web3.eth.getBlockNumber()) - 4;
                const lastEventBlock = this.lastEventBlock || lastBlock;
                if (lastEventBlock >= lastBlock) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    continue;
                }
                //logger.info(`Reading events for from: ${lastEventBlock} to ${lastBlock.toString()}`);
                for (let lastBlockRead = lastEventBlock; lastBlockRead <= lastBlock; lastBlockRead += blockReadOffset) {
                    const allEvents = await this.readEventsFrom(
                        bot.context.assetManager,
                        lastBlockRead,
                        Math.min(lastBlockRead + blockReadOffset - 1, lastBlock)
                    );
                    for (const e of allEvents) {
                        const event = e as any;
                        const am = this.assetManagerList.find((am) => am.assetManager === event.address);
                        if (!am) {
                            continue;
                        }
                        if (event.event === "AgentPingResponse") {
                            const vaultAddress = event.args.agentVault;
                            const agent = await this.em.findOne(Liveness, {
                                vaultAddress: vaultAddress,
                            });
                            if (agent == null) {
                                const agentLiveness = new Liveness(vaultAddress, am.fasset, timestamp, timestamp, false);
                                await this.em.persistAndFlush(agentLiveness);
                                continue;
                            }
                            agent.lastTimestamp = timestamp;
                            await this.em.persistAndFlush(agent);
                        } else {
                            if (event.event === "CollateralReserved") {
                                const crEvent = new CollateralReservationEvent(
                                    event.args.collateralReservationId,
                                    event.args.agentVault,
                                    event.args.minter,
                                    event.args.valueUBA,
                                    event.args.feeUBA,
                                    event.args.firstUnderlyingBlock,
                                    event.args.lastUnderlyingBlock,
                                    event.args.lastUnderlyingTimestamp,
                                    event.args.paymentAddress,
                                    event.args.paymentReference,
                                    event.args.executor,
                                    event.args.executorFeeNatWei,
                                    timestamp
                                );
                                await this.em.persistAndFlush(crEvent);
                            } else {
                                if (event.event === "RedemptionRequestRejected") {
                                    const redemptionRejectedEvent = new RedemptionRejected(
                                        event.args.agentVault,
                                        event.args.redeemer,
                                        event.args.requestId,
                                        event.args.paymentAddress,
                                        event.args.valueUBA,
                                        timestamp
                                    );
                                    await this.em.persistAndFlush(redemptionRejectedEvent);
                                } else {
                                    if (event.event === "RedemptionRequested") {
                                        const redemptionRequestedEvent = new RedemptionRequested(
                                            event.args.agentVault,
                                            event.args.redeemer,
                                            event.args.requestId,
                                            event.args.paymentAddress,
                                            event.args.valueUBA,
                                            event.args.feeUBA,
                                            event.args.firstUnderlyingBlock,
                                            event.args.lastUnderlyingBlock,
                                            event.args.lastUnderlyingTimestamp,
                                            event.args.paymentReference,
                                            timestamp
                                        );
                                        await this.em.persistAndFlush(redemptionRequestedEvent);
                                    } else {
                                        if (event.event === "RedemptionRequestTakenOver") {
                                            const redemptionTakenOverEvent = new RedemptionTakenOver(
                                                event.args.agentVault,
                                                event.args.redeemer,
                                                event.args.requestId,
                                                event.args.valueTakenOverUBA,
                                                event.args.newAgentVault,
                                                event.args.newRequestId,
                                                timestamp
                                            );
                                            await this.em.persistAndFlush(redemptionTakenOverEvent);
                                        } else {
                                            if (event.event === "CollateralReservationRejected") {
                                                const crRejected = new CrRejectedCancelledEvent(
                                                    event.args.collateralReservationId,
                                                    event.args.agentVault,
                                                    event.args.minter,
                                                    true,
                                                    false,
                                                    timestamp
                                                );
                                                await this.em.persistAndFlush(crRejected);
                                            } else {
                                                if (event.event == "CollateralReservationCancelled") {
                                                    const crCancelled = new CrRejectedCancelledEvent(
                                                        event.args.collateralReservationId,
                                                        event.args.agentVault,
                                                        event.args.minter,
                                                        false,
                                                        true,
                                                        timestamp
                                                    );
                                                    await this.em.persistAndFlush(crCancelled);
                                                } else {
                                                    if (event.event == "HandshakeRequired") {
                                                        const handshakeEvent = new HandshakeEvent(
                                                            event.args.collateralReservationId,
                                                            event.args.agentVault,
                                                            event.args.minter,
                                                            event.args.valueUBA,
                                                            event.args.feeUBA,
                                                            JSON.stringify(event.args.minterUnderlyingAddresses),
                                                            timestamp
                                                        );
                                                        await this.em.persistAndFlush(handshakeEvent);
                                                    } else {
                                                        if (event.event == "RedemptionDefault") {
                                                            const redemptionDefaultEvent = new RedemptionDefaultEvent(
                                                                event.args.agentVault,
                                                                event.args.redeemer,
                                                                event.args.requestId,
                                                                event.args.redemptionAmountUBA,
                                                                event.args.redeemedVaultCollateralWei,
                                                                event.args.redeemedPoolCollateralWei,
                                                                timestamp
                                                            );
                                                            await this.em.persistAndFlush(redemptionDefaultEvent);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                //this.lastEventBlockMap.set(fasset, lastBlock);
                this.lastEventBlock = lastBlock + 1;
                //logger.info(`Finish reading events.`);
            } catch (error) {
                logger.error(`'Error in event reader:`, error);
            }
        }
    }

    async getPastLogsFromAssetManagers(fromBlock: BlockNumber, toBlock: BlockNumber, topics: string[]): Promise<Log[]> {
        const logs = await web3.eth.getPastLogs({
            address: this.assetManagerAddressList,
            fromBlock: fromBlock,
            toBlock: toBlock,
            topics: [topics],
        });
        return logs;
    }

    //this.redemptionRequestRejectedTopic = web3.utils.keccak256("RedemptionRequestRejected(address,address,uint64)");
    //this.redemptionRequestTakenOverTopic = web3.utils.keccak256("RedemptionRequestTakenOver(address,address,uint64,uint256,address,uint64)");
    //this.redemptionRequestedTopic
    async readEventsFrom(contract: Truffle.ContractInstance, fromBlock: BlockNumber, toBlock: BlockNumber): Promise<EvmEvent[]> {
        const eventDecoder = new Web3ContractEventDecoder({ contract });
        /*const [
            agentPingResponseLogs,
            collateralReservationLogs,
            redemptionRequestRejected,
            redemptionRequestTakenOver,
            redemptionRequested,
            crRejected,
            crCancelled,
        ] = await Promise.all([
            this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.agentPingResponseTopic),
            this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.collateralReservedTopic),
            this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.redemptionRequestRejectedTopic),
            this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.redemptionRequestTakenOverTopic),
            this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.redemptionRequestedTopic),
            this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.collateralReservationRejectedTopic),
        ]);*/
        const allLogs = await this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.eventTopics);
        return eventDecoder.decodeEvents(allLogs);
    }

    async getMints(vaultAddress: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/agent-minting-executed-count?agent=" + vaultAddress, { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in minting executed count`, error);
            return 0;
        }
    }

    async getRedemptionSuccessRate(vaultAddress: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/agent-redemption-success-rate?agent=" + vaultAddress, { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in redemption success rate`, error);
            return 0;
        }
    }

    async getLiquidationCount(vaultAddress: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/agent-performed-liquidation-count?agent=" + vaultAddress, { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in get liquidation count`, error);
            return 0;
        }
    }

    async getPools(): Promise<void> {
        logger.info(`Updating pools`);
        let currentTVL = "0";
        let mintedAll = "0";
        const supplyFasset: SupplyFasset[] = [];
        const supplyCollateral: SupplyTotalCollateral[] = [];
        let agentsLiq = 0;
        let numLiq = 0;
        let rewardsAvailableUSD = "0";
        let totalCollateral = "0";
        let tvlpoolsnat = "0";
        let numMints = 0;
        let agentPoolCollateralOnly = "0";
        const poolRewardsPaid = (await this.externalApiService.getTotalClaimedPoolFees()) as CurrencyMap;
        const poolPaid: PoolRewards[] = [];
        let totalPoolPaidUSD = "0";
        const holdersFasset = await this.externalApiService.getHolderCount();
        let holders = 0;
        for (const h in holdersFasset) {
            if (holdersFasset.hasOwnProperty(h)) {
                holders = holders + holdersFasset[h].amount;
            }
        }
        this.holders = holders;

        //Get top pools with min 500k sgb in nat wei pool collateral
        const topPools = await this.externalApiService.getBestPerformingPools(3, "500000000000000000000000");
        const bestPools: TopPoolData[] = [];
        //let overCollaterazied = "0";
        for (const [fasset, infoBot] of this.infoBotMap.entries()) {
            let mintedUBA = toBN(0);
            //TODO: make it in parallel (when mysql db)
            const start = Date.now();
            const [agents, settings, collaterals] = await Promise.all([
                infoBot.getAllAgents(),
                infoBot.context.assetManager.getSettings(),
                infoBot.context.assetManager.getCollateralTypes(),
            ]);
            //console.log(collaterals);
            logger.info(`Updating ${agents.length} pools for fasset ${fasset} ...`);
            let mintedReservedUBA = toBN(0);

            const lotSizeUBA = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
            const lotSize = (await infoBot.getLotSize()) / 10 ** Number(settings.assetDecimals);
            const supplyFa: SupplyFasset = {
                fasset: fasset,
                supply: "0",
                minted: "0",
                availableToMintUSD: "0",
                availableToMintLots: 0,
                allLots: 0,
                mintedPercentage: "0",
            };
            const mintingCap = toBN(settings.mintingCapAMG).mul(toBN(settings.assetMintingGranularityUBA));
            const priceReader = await TokenPriceReader.create(settings);

            //TODO Add native token symbol to .env
            const cflrPrice = await priceReader.getPrice(infoBot.context.nativeChainInfo.tokenSymbol, false, settings.maxTrustedPriceAgeSeconds);
            const priceUSD = cflrPrice.price.mul(toBNExp(1, 18));
            let feesAvailable = toBN(0);
            const prices: Price[] = [
                {
                    symbol: infoBot.context.nativeChainInfo.tokenSymbol,
                    price: priceUSD,
                    decimals: Number(cflrPrice.decimals),
                },
            ];

            const newAgentAddresses = new Set(agents.map((agent) => agent));

            const existingAgents = await this.em.find(Pool, { fasset });
            const agentsLiveness = await this.em.find(Liveness, { fasset });

            const existingCollaterals = await this.em.find(Collateral, { fasset });
            const existingCollateralAddresses = new Set(existingCollaterals.map((collateral) => collateral.token));
            const newCollateralAddresses = new Set(collaterals.map((collateral) => collateral.token));
            const newCollaterals = collaterals.filter((collateral) => !existingCollateralAddresses.has(collateral.token));
            const collateralsToUpdate = existingCollaterals.filter((collateral) => newCollateralAddresses.has(collateral.token));
            for (let i = 0; i < newCollaterals.length; i++) {
                const collateral = newCollaterals[i];
                const newCollateral = new Collateral(
                    fasset,
                    collateral.token,
                    Number(collateral.decimals),
                    Number(collateral.validUntil),
                    collateral.assetFtsoSymbol,
                    collateral.tokenFtsoSymbol,
                    Number(collateral.minCollateralRatioBIPS) / MAX_BIPS,
                    Number(collateral.ccbMinCollateralRatioBIPS) / MAX_BIPS,
                    Number(collateral.safetyMinCollateralRatioBIPS) / MAX_BIPS
                );
                await this.em.persistAndFlush(newCollateral);
            }
            for (let i = 0; i < collateralsToUpdate.length; i++) {
                const collateral = collateralsToUpdate[i];
                const updatedCollateral = collaterals.find((c) => c.token === collateral.token);
                collateral.assetFtsoSymbol = updatedCollateral.assetFtsoSymbol;
                collateral.ccbMinCollateralRatioBIPS = Number(updatedCollateral.ccbMinCollateralRatioBIPS) / MAX_BIPS;
                collateral.validUntil = Number(updatedCollateral.validUntil);
                collateral.minCollateralRatioBIPS = Number(updatedCollateral.minCollateralRatioBIPS) / MAX_BIPS;
                collateral.safetyMinCollateralRatioBIPS = Number(updatedCollateral.safetyMinCollateralRatioBIPS) / MAX_BIPS;
                collateral.tokenFtsoSymbol = updatedCollateral.tokenFtsoSymbol;
                await this.em.persistAndFlush(collateral);
            }

            const existingAgentAddresses = new Set(existingAgents.map((agent) => agent.vaultAddress));

            const newAgents = agents.filter((agent) => !existingAgentAddresses.has(agent));
            const agentsToDelete = existingAgents.filter((agent) => !newAgentAddresses.has(agent.vaultAddress));
            const agentsLivenessToDelete = agentsLiveness.filter((agent) => !newAgentAddresses.has(agent.vaultAddress));
            const agentsToUpdate = existingAgents.filter((agent) => newAgentAddresses.has(agent.vaultAddress));

            // prefetch agentinfo
            const newAgentInfoPromises = newAgents.map((agent) => infoBot.context.assetManager.getAgentInfo(agent));
            const newAgentInfos = await Promise.all(newAgentInfoPromises);
            // map
            const newAgentInfoMap = new Map(newAgents.map((agent, index) => [agent, newAgentInfos[index]]));
            // prefetch additional agent data
            const newAgentAdditionalInfoPromises = newAgents.map((agent) => {
                const info = newAgentInfoMap.get(agent);
                return Promise.all([
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentName(info.ownerManagementAddress),
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentIconUrl(info.ownerManagementAddress),
                    CollateralPool.at(info.collateralPool),
                    this.getMints(agent).catch((error) => {
                        logger.error(`Error in getMints`, error);
                        return 0;
                    }),
                    this.getLiquidationCount(agent).catch((error) => {
                        logger.error(`Error in getLiquidationCount`, error);
                        return 0;
                    }),
                    this.getRedemptionSuccessRate(agent).catch((error) => {
                        logger.error(`Error in getRedemptionSuccessRate`, error);
                        return 0;
                    }),
                    infoBot.context.assetManager.getCollateralType(CollateralClass.VAULT, info.vaultCollateralToken),
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentDescription(info.ownerManagementAddress),
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentTermsOfUseUrl(info.ownerManagementAddress),
                ]);
            });
            const newAgentAdditionalInfos = await Promise.all(newAgentAdditionalInfoPromises);
            for (let i = 0; i < newAgents.length; i++) {
                try {
                    const agent = newAgents[i];
                    const info = newAgentInfoMap.get(agent);
                    const [agentName, url, pool, mintCount, numLiquidations, redeemRate, vaultCollateralType, description, infoUrl] =
                        newAgentAdditionalInfos[i];

                    const poolToken = await IERC20.at(await pool.poolToken());

                    const rewardsAvailable = await pool.totalFAssetFees();
                    feesAvailable = feesAvailable.add(rewardsAvailable);

                    const poolcr = Number(info.poolCollateralRatioBIPS) / MAX_BIPS;
                    const vaultcr = Number(info.vaultCollateralRatioBIPS) / MAX_BIPS;
                    const poolExitCR = Number(info.poolExitCollateralRatioBIPS) / MAX_BIPS;
                    const poolTopupCR = Number(info.poolTopupCollateralRatioBIPS) / MAX_BIPS;
                    const feeShare = Number(info.poolFeeShareBIPS) / MAX_BIPS;
                    const mintFee = Number(info.feeBIPS) / MAX_BIPS;
                    const mintingPoolCR = Number(info.mintingPoolCollateralRatioBIPS) / MAX_BIPS;
                    const mintingVaultCR = Number(info.mintingVaultCollateralRatioBIPS) / MAX_BIPS;

                    const existingPrice = prices.find((p) => p.symbol === vaultCollateralType.tokenFtsoSymbol);
                    let totalVaultCollateralUSD = toBN(0);
                    let totalPoolCollateralUSD = toBN(0);
                    if (existingPrice) {
                        totalVaultCollateralUSD = toBN(info.totalVaultCollateralWei)
                            .mul(existingPrice.price)
                            .div(toBNExp(1, Number(vaultCollateralType.decimals) + existingPrice.decimals));
                        totalPoolCollateralUSD = toBN(info.totalPoolCollateralNATWei)
                            .mul(priceUSD)
                            .div(toBNExp(1, 18 + Number(cflrPrice.decimals)));
                    } else {
                        const priceVault = await priceReader.getPrice(vaultCollateralType.tokenFtsoSymbol, false, settings.maxTrustedPriceAgeSeconds);
                        const priceVaultUSD = priceVault.price.mul(toBNExp(1, 18));
                        totalVaultCollateralUSD = toBN(info.totalVaultCollateralWei)
                            .mul(priceVaultUSD)
                            .div(toBNExp(1, Number(vaultCollateralType.decimals) + Number(priceVault.decimals)));
                        totalPoolCollateralUSD = toBN(info.totalPoolCollateralNATWei)
                            .mul(priceUSD)
                            .div(toBNExp(1, 18 + Number(cflrPrice.decimals)));
                        prices.push({
                            symbol: vaultCollateralType.tokenFtsoSymbol,
                            price: priceVaultUSD,
                            decimals: Number(priceVault.decimals),
                        });
                    }
                    const totalPoolCollateral = formatFixed(toBN(info.totalPoolCollateralNATWei), 18, { decimals: 3, groupDigits: true, groupSeparator: "," });
                    tvlpoolsnat = sumUsdStrings(tvlpoolsnat, totalPoolCollateral);
                    const vaultCollateral = formatFixed(toBN(info.totalVaultCollateralWei), Number(vaultCollateralType.decimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const poolOnlyCollateralUSD = formatFixed(totalPoolCollateralUSD, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const vaultOnlyCollateralUSD = formatFixed(totalVaultCollateralUSD, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const totalCollateralUSD = formatFixed(totalVaultCollateralUSD.add(totalPoolCollateralUSD), 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    totalCollateral = sumUsdStrings(totalCollateral, totalCollateralUSD);
                    currentTVL = sumUsdStrings(
                        currentTVL,
                        formatFixed(totalPoolCollateralUSD, 18, {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        })
                    );
                    const poolNatBalance = toBN(await pool.totalCollateral());
                    const totalSupply = toBN(await poolToken.totalSupply());
                    const agentPoolCollateral =
                        totalSupply.toString() === "0"
                            ? toBN(0)
                            : toBN(await poolToken.balanceOf(agent))
                                  .mul(poolNatBalance)
                                  .div(totalSupply);
                    const agentPoolCollateralUSD = toBN(agentPoolCollateral)
                        .mul(priceUSD)
                        .div(toBNExp(1, 18 + Number(cflrPrice.decimals)));
                    const agentPoolCollateralUSDFormatted = formatFixed(agentPoolCollateralUSD, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, agentPoolCollateralUSDFormatted);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, vaultOnlyCollateralUSD);
                    //Check if in liq
                    if (Number(info.status) == 2 || Number(info.status) == 3) {
                        agentsLiq++;
                    }
                    //infoBot.context.
                    //TODO change so price calculation works
                    let mintedUSD;
                    let remainingUSD;
                    let remainingUSDFormatted;
                    const remainingAssets = Number(info.freeCollateralLots) * lotSize;
                    const existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                    if (existingPriceAsset) {
                        mintedUSD = toBN(info.mintedUBA).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
                        remainingUSD = toBN(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals)))
                            .mul(existingPriceAsset.price)
                            .div(toBNExp(1, Number(settings.assetDecimals)));
                        remainingUSDFormatted = formatFixed(remainingUSD, existingPriceAsset.decimals, {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        });
                    } else {
                        const priceAsset = await priceReader.getPrice(this.fassetSymbol.get(fasset), false, settings.maxTrustedPriceAgeSeconds);
                        prices.push({
                            symbol: this.fassetSymbol.get(fasset),
                            price: priceAsset.price,
                            decimals: Number(priceAsset.decimals),
                        });
                        mintedUSD = toBN(info.mintedUBA)
                            .mul(priceAsset.price)
                            .div(toBNExp(1, Number(priceAsset.decimals)));
                        remainingUSD = toBN(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals)))
                            .mul(priceAsset.price)
                            .div(toBNExp(1, Number(settings.assetDecimals)));
                        remainingUSDFormatted = formatFixed(remainingUSD, Number(priceAsset.decimals), {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        });
                    }
                    const mintedUSDFormatted = formatFixed(mintedUSD, Number(settings.assetDecimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    mintedAll = sumUsdStrings(mintedAll, mintedUSDFormatted);
                    const mintedReservedLots = toBN(info.mintedUBA).add(toBN(info.reservedUBA)).div(lotSizeUBA);
                    const mintedAssets = formatFixed(toBN(info.mintedUBA), Number(settings.assetDecimals), {
                        decimals: fasset.includes("XRP") ? 3 : 8,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    mintedReservedUBA = mintedReservedUBA.add(toBN(info.mintedUBA)).add(toBN(info.reservedUBA));
                    mintedUBA = mintedUBA.add(toBN(info.mintedUBA));
                    supplyFa.minted = sumUsdStrings(supplyFa.minted, mintedUSDFormatted);
                    let allLots = mintedReservedLots.toNumber();
                    if (mintingCap.toString() === "0") {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                            supplyFa.availableToMintUSD = sumUsdStrings(supplyFa.availableToMintUSD, remainingUSDFormatted);
                        }
                        allLots = allLots + Number(info.freeCollateralLots);
                        supplyFa.allLots = supplyFa.allLots + allLots;
                    } else {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                        }
                        supplyFa.allLots = supplyFa.allLots + allLots;
                    }
                    const totalPortfolioValueUSD = sumUsdStrings(totalCollateralUSD, mintedUSDFormatted);
                    const limitUSD = sumUsdStrings(mintedUSDFormatted, remainingUSDFormatted);

                    //Track total collateral for native token and vault collateral
                    const existingCollateralNative = supplyCollateral.find((asset) => asset.symbol === infoBot.context.nativeChainInfo.tokenSymbol);
                    if (existingCollateralNative) {
                        existingCollateralNative.supply = sumUsdStrings(existingCollateralNative.supply, totalPoolCollateral);
                        existingCollateralNative.supplyUSD = sumUsdStrings(existingCollateralNative.supplyUSD, poolOnlyCollateralUSD);
                    } else {
                        supplyCollateral.push({
                            symbol: infoBot.context.nativeChainInfo.tokenSymbol,
                            supply: totalPoolCollateral,
                            supplyUSD: poolOnlyCollateralUSD,
                        });
                    }
                    const existingCollateralVault = supplyCollateral.find((asset) => asset.symbol === vaultCollateralType.tokenFtsoSymbol);
                    if (existingCollateralVault) {
                        existingCollateralVault.supply = sumUsdStrings(existingCollateralVault.supply, vaultCollateral);
                        existingCollateralVault.supplyUSD = sumUsdStrings(existingCollateralVault.supplyUSD, vaultOnlyCollateralUSD);
                    } else {
                        supplyCollateral.push({ symbol: vaultCollateralType.tokenFtsoSymbol, supply: vaultCollateral, supplyUSD: vaultOnlyCollateralUSD });
                    }

                    /*const priceUnderlyingAsset = await priceReader.getPrice(asset, false, settings.maxTrustedPriceAgeSeconds);
                    const priceMul = price.price.mul(toBNExp(1, 18));
                    const mintedUBA = info.mintedUBA;
                    const remainingUSD = info.freeCollateralLots.muln(formattedLotSize)*/
                    numLiq = numLiq + Number(numLiquidations);
                    numMints = numMints + Number(mintCount);
                    const agentAllLots = mintingCap.toString() === "0" ? allLots : allLots + Number(info.freeCollateralLots);
                    const agentPool = new Pool(
                        agent,
                        fasset,
                        info.collateralPool,
                        poolToken.address,
                        agentName,
                        this.botMap.get(fasset).fAssetSymbol,
                        poolcr,
                        vaultcr,
                        poolExitCR,
                        totalPoolCollateral,
                        feeShare,
                        Number(info.status),
                        info.freeCollateralLots.toString(),
                        mintFee,
                        mintCount,
                        redeemRate,
                        numLiquidations,
                        url,
                        totalCollateralUSD,
                        vaultCollateral,
                        vaultCollateralType.tokenFtsoSymbol,
                        Number(vaultCollateralType.decimals),
                        info.publiclyAvailable,
                        poolTopupCR,
                        mintingPoolCR,
                        mintingVaultCR,
                        info.vaultCollateralToken,
                        Number(info.handshakeType),
                        description,
                        mintedAssets,
                        mintedUSDFormatted,
                        agentAllLots,
                        poolOnlyCollateralUSD,
                        vaultOnlyCollateralUSD,
                        remainingAssets.toString(),
                        remainingUSDFormatted,
                        totalPortfolioValueUSD,
                        limitUSD,
                        infoUrl,
                        info.underlyingAddressString
                    );
                    const agentLiveness = new Liveness(agent, fasset, 0, 0, info.publiclyAvailable);
                    await this.em.persistAndFlush(agentPool);
                    await this.em.persistAndFlush(agentLiveness);
                } catch (error) {
                    logger.error(`Error in getPools(add new):`, error);
                }
            }

            for (const agent of agentsToDelete) {
                try {
                    await this.em.removeAndFlush(agent);
                } catch (error) {
                    logger.error(`Error in getPools (agentsToDelete):`, error);
                }
            }
            for (const agent of agentsLivenessToDelete) {
                try {
                    await this.em.removeAndFlush(agent);
                } catch (error) {
                    logger.error(`Error in getPools (agentsLivenessToDelete):`, error);
                }
            }

            // prefetch
            const agentsToUpdateInfoPromises = agentsToUpdate.map((agent) => infoBot.context.assetManager.getAgentInfo(agent.vaultAddress));
            const agentsToUpdateInfos = await Promise.all(agentsToUpdateInfoPromises);
            // map
            const agentsToUpdateInfoMap = new Map(agentsToUpdate.map((agent, index) => [agent, agentsToUpdateInfos[index]]));

            // prefetch additional agent data
            const agentsToUpdateAdditionalInfoPromises = agentsToUpdate.map((agent) => {
                const info = agentsToUpdateInfoMap.get(agent);
                return Promise.all([
                    this.getMints(agent.vaultAddress).catch((error) => {
                        logger.error(`Error in getMints`, error);
                        return 0;
                    }),
                    this.getLiquidationCount(agent.vaultAddress).catch((error) => {
                        logger.error(`Error in getLiquidationCount`, error);
                        return 0;
                    }),
                    this.getRedemptionSuccessRate(agent.vaultAddress).catch((error) => {
                        logger.error(`Error in getRedemptionSuccessRate`, error);
                        return 0;
                    }),
                    infoBot.context.assetManager.getCollateralType(CollateralClass.VAULT, info.vaultCollateralToken),
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentName(info.ownerManagementAddress),
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentIconUrl(info.ownerManagementAddress),
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentTermsOfUseUrl(info.ownerManagementAddress),
                    this.botMap.get(fasset).context.agentOwnerRegistry.getAgentDescription(info.ownerManagementAddress),
                ]);
            });
            const agentsToUpdateAdditionalInfos = await Promise.all(agentsToUpdateAdditionalInfoPromises);

            for (let i = 0; i < agentsToUpdate.length; i++) {
                const agent = agentsToUpdate[i];
                const updatedAgent = agents.find((a) => a === agent.vaultAddress);
                if (!updatedAgent) continue;
                try {
                    const info = agentsToUpdateInfoMap.get(agent);
                    const [mintCount, numLiquidations, redeemRate, vaultCollateralType, name, urlIcon, tos, desc] = agentsToUpdateAdditionalInfos[i];
                    agent.description = desc;
                    /*if (agent.description == null) {
                        const description = await this.botMap.get(fasset).context.agentOwnerRegistry.getAgentDescription(info.ownerManagementAddress);
                        agent.description = description;
                    }*/
                    const pool = await CollateralPool.at(agent.poolAddress);
                    const rewardsAvailable = await pool.totalFAssetFees();
                    feesAvailable = feesAvailable.add(rewardsAvailable);
                    const poolcr = Number(info.poolCollateralRatioBIPS) / MAX_BIPS;
                    const vaultcr = Number(info.vaultCollateralRatioBIPS) / MAX_BIPS;
                    const poolExitCR = Number(info.poolExitCollateralRatioBIPS) / MAX_BIPS;
                    const totalPoolCollateral = formatFixed(toBN(info.totalPoolCollateralNATWei), 18, { decimals: 3, groupDigits: true, groupSeparator: "," });
                    const vaultCollateral = formatFixed(toBN(info.totalVaultCollateralWei), agent.vaultCollateralTokenDecimals, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const mintingPoolCR = Number(info.mintingPoolCollateralRatioBIPS) / MAX_BIPS;
                    const mintingVaultCR = Number(info.mintingVaultCollateralRatioBIPS) / MAX_BIPS;

                    const existingPrice = prices.find((p) => p.symbol === vaultCollateralType.tokenFtsoSymbol);
                    let totalVaultCollateralUSD = toBN(0);
                    let totalPoolCollateralUSD = toBN(0);

                    if (existingPrice) {
                        totalVaultCollateralUSD = toBN(info.totalVaultCollateralWei)
                            .mul(existingPrice.price)
                            .div(toBNExp(1, Number(vaultCollateralType.decimals) + existingPrice.decimals));
                        totalPoolCollateralUSD = toBN(info.totalPoolCollateralNATWei)
                            .mul(priceUSD)
                            .div(toBNExp(1, 18 + Number(cflrPrice.decimals)));
                    } else {
                        const priceVault = await priceReader.getPrice(vaultCollateralType.tokenFtsoSymbol, false, settings.maxTrustedPriceAgeSeconds);
                        const priceVaultUSD = priceVault.price.mul(toBNExp(1, 18));
                        totalVaultCollateralUSD = toBN(info.totalVaultCollateralWei)
                            .mul(priceVaultUSD)
                            .div(toBNExp(1, Number(vaultCollateralType.decimals) + Number(priceVault.decimals)));
                        totalPoolCollateralUSD = toBN(info.totalPoolCollateralNATWei)
                            .mul(priceUSD)
                            .div(toBNExp(1, 18 + Number(cflrPrice.decimals)));
                        prices.push({
                            symbol: vaultCollateralType.tokenFtsoSymbol,
                            price: priceVaultUSD,
                            decimals: Number(priceVault.decimals),
                        });
                    }
                    const poolOnlyCollateralUSD = formatFixed(totalPoolCollateralUSD, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const vaultOnlyCollateralUSD = formatFixed(totalVaultCollateralUSD, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const totalCollateralUSD = formatFixed(totalVaultCollateralUSD.add(totalPoolCollateralUSD), 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    totalCollateral = sumUsdStrings(totalCollateral, totalCollateralUSD);
                    tvlpoolsnat = sumUsdStrings(tvlpoolsnat, totalPoolCollateral);
                    currentTVL = sumUsdStrings(
                        currentTVL,
                        formatFixed(totalPoolCollateralUSD, 18, {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        })
                    );
                    const poolToken = await IERC20.at(await pool.poolToken());
                    const poolNatBalance = toBN(await pool.totalCollateral());
                    const totalSupply = toBN(await poolToken.totalSupply());
                    const agentPoolCollateral =
                        totalSupply.toString() === "0"
                            ? toBN(0)
                            : toBN(await poolToken.balanceOf(agent.vaultAddress))
                                  .mul(poolNatBalance)
                                  .div(totalSupply);
                    const agentPoolCollateralUSD = toBN(agentPoolCollateral)
                        .mul(priceUSD)
                        .div(toBNExp(1, 18 + Number(cflrPrice.decimals)));
                    const agentPoolCollateralUSDFormatted = formatFixed(agentPoolCollateralUSD, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, agentPoolCollateralUSDFormatted);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, vaultOnlyCollateralUSD);
                    //Check liq
                    if (Number(info.status) == 2 || Number(info.status) == 3) {
                        agentsLiq++;
                    }
                    //infoBot.context.
                    //TODO change so price calculation works
                    let mintedUSD;
                    let remainingUSD;
                    let remainingUSDFormatted;
                    const remainingAssets = Number(info.freeCollateralLots) * lotSize;
                    const existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                    if (existingPriceAsset) {
                        mintedUSD = toBN(info.mintedUBA).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
                        remainingUSD = toBN(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals)))
                            .mul(existingPriceAsset.price)
                            .div(toBNExp(1, Number(settings.assetDecimals)));
                        remainingUSDFormatted = formatFixed(remainingUSD, existingPriceAsset.decimals, {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        });
                    } else {
                        const priceAsset = await priceReader.getPrice(this.fassetSymbol.get(fasset), false, settings.maxTrustedPriceAgeSeconds);
                        prices.push({
                            symbol: this.fassetSymbol.get(fasset),
                            price: priceAsset.price,
                            decimals: Number(priceAsset.decimals),
                        });
                        mintedUSD = toBN(info.mintedUBA)
                            .mul(priceAsset.price)
                            .div(toBNExp(1, Number(priceAsset.decimals)));
                        remainingUSD = toBN(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals)))
                            .mul(priceAsset.price)
                            .div(toBNExp(1, Number(settings.assetDecimals)));
                        remainingUSDFormatted = formatFixed(remainingUSD, Number(priceAsset.decimals), {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        });
                    }
                    const mintedUSDFormatted = formatFixed(mintedUSD, Number(settings.assetDecimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    mintedAll = sumUsdStrings(mintedAll, mintedUSDFormatted);
                    const mintedReservedLots = toBN(info.mintedUBA).add(toBN(info.reservedUBA)).div(lotSizeUBA);
                    const mintedAssets = formatFixed(toBN(info.mintedUBA), Number(settings.assetDecimals), {
                        decimals: fasset.includes("XRP") ? 3 : 8,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    //supplyFa.supply = sumUsdStrings(supplyFa.supply, mintedAssets);
                    mintedReservedUBA = mintedReservedUBA.add(toBN(info.mintedUBA)).add(toBN(info.reservedUBA));
                    mintedUBA = mintedUBA.add(toBN(info.mintedUBA));
                    supplyFa.minted = sumUsdStrings(supplyFa.minted, mintedUSDFormatted);
                    let allLots = mintedReservedLots.toNumber();
                    if (mintingCap.toString() === "0") {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                            supplyFa.availableToMintUSD = sumUsdStrings(supplyFa.availableToMintUSD, remainingUSDFormatted);
                        }
                        allLots = allLots + Number(info.freeCollateralLots);
                        supplyFa.allLots = supplyFa.allLots + allLots;
                    } else {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                        }
                        supplyFa.allLots = supplyFa.allLots + allLots;
                    }
                    const totalPortfolioValueUSD = sumUsdStrings(totalCollateralUSD, mintedUSDFormatted);
                    const limitUSD = sumUsdStrings(mintedUSDFormatted, remainingUSDFormatted);
                    const poolTopupCR = Number(info.poolTopupCollateralRatioBIPS) / MAX_BIPS;

                    //Track total collateral for native token and vault collateral
                    const existingCollateralNative = supplyCollateral.find((asset) => asset.symbol === infoBot.context.nativeChainInfo.tokenSymbol);
                    if (existingCollateralNative) {
                        existingCollateralNative.supply = sumUsdStrings(existingCollateralNative.supply, totalPoolCollateral);
                        existingCollateralNative.supplyUSD = sumUsdStrings(existingCollateralNative.supplyUSD, poolOnlyCollateralUSD);
                    } else {
                        supplyCollateral.push({
                            symbol: infoBot.context.nativeChainInfo.tokenSymbol,
                            supply: totalPoolCollateral,
                            supplyUSD: poolOnlyCollateralUSD,
                        });
                    }
                    const existingCollateralVault = supplyCollateral.find((asset) => asset.symbol === vaultCollateralType.tokenFtsoSymbol);
                    if (existingCollateralVault) {
                        existingCollateralVault.supply = sumUsdStrings(existingCollateralVault.supply, vaultCollateral);
                        existingCollateralVault.supplyUSD = sumUsdStrings(existingCollateralVault.supplyUSD, vaultOnlyCollateralUSD);
                    } else {
                        supplyCollateral.push({ symbol: vaultCollateralType.tokenFtsoSymbol, supply: vaultCollateral, supplyUSD: vaultOnlyCollateralUSD });
                    }
                    const agentAllLots = mintingCap.toString() === "0" ? allLots : allLots + Number(info.freeCollateralLots);
                    agent.poolCR = poolcr;
                    agent.agentName = name;
                    agent.url = urlIcon;
                    agent.infoUrl = tos;
                    agent.vaultCR = vaultcr;
                    agent.poolExitCR = poolExitCR;
                    agent.totalPoolCollateral = totalPoolCollateral;
                    agent.freeLots = info.freeCollateralLots.toString();
                    agent.mintFee = Number(info.feeBIPS) / MAX_BIPS;
                    agent.mintNumber = mintCount !== 0 ? mintCount : agent.mintNumber;
                    agent.numLiquidations = numLiquidations !== 0 ? numLiquidations : agent.numLiquidations;
                    agent.redeemSuccessRate = redeemRate !== 0 ? redeemRate : agent.redeemSuccessRate;
                    agent.feeShare = Number(info.poolFeeShareBIPS) / MAX_BIPS;
                    agent.status = Number(info.status);
                    agent.poolNatUsd = totalCollateralUSD;
                    agent.vaultCollateral = vaultCollateral;
                    agent.publiclyAvailable = info.publiclyAvailable;
                    agent.poolTopupCR = poolTopupCR;
                    agent.mintingVaultCR = mintingVaultCR;
                    agent.mintingPoolCR = mintingPoolCR;
                    agent.vaultToken = info.vaultCollateralToken;
                    agent.handshakeType = Number(info.handshakeType);
                    agent.mintedUSD = mintedUSDFormatted;
                    agent.allLots = agentAllLots;
                    agent.poolOnlyCollateralUSD = poolOnlyCollateralUSD;
                    agent.vaultOnlyCollateralUSD = vaultOnlyCollateralUSD;
                    agent.mintedUBA = mintedAssets;
                    agent.remainingUBA = remainingAssets.toString();
                    agent.remainingUSD = remainingUSDFormatted;
                    agent.totalPortfolioValueUSD = totalPortfolioValueUSD;
                    agent.limitUSD = limitUSD;

                    numLiq = numLiq + Number(agent.numLiquidations);
                    numMints = numMints + Number(mintCount);

                    await this.em.persistAndFlush(agent);
                    const agents = await this.em.find(Liveness, { vaultAddress: agent.vaultAddress }, { orderBy: { lastPinged: "asc" } });
                    if (agents.length == 0) {
                        continue;
                    }
                    const agentLiveness = agents[0];
                    agentLiveness.publiclyAvailable = info.publiclyAvailable;
                    await this.em.persistAndFlush(agentLiveness);
                } catch (error) {
                    logger.error(`Error in getPools (update):`, error);
                }
            }
            if (mintingCap.toString() != "0") {
                const availableToMintUBA = mintingCap.sub(mintedReservedUBA);
                const freeLotsUBA = toBN(supplyFa.availableToMintLots).mul(lotSizeUBA);
                const availableLotsCap = Math.min(availableToMintUBA.div(lotSizeUBA).toNumber(), supplyFa.availableToMintLots);
                supplyFa.availableToMintLots = Number(availableLotsCap);
                const existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                const availableToMintUSD = toBN(Math.min(availableToMintUBA.toNumber(), freeLotsUBA.toNumber()))
                    .mul(existingPriceAsset.price)
                    .div(toBNExp(1, Number(existingPriceAsset.decimals)));
                const availableToMintUSDFormatted = formatFixed(availableToMintUSD, Number(settings.assetDecimals), {
                    decimals: 3,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                supplyFa.availableToMintUSD = availableToMintUSDFormatted;
                supplyFa.allLots = supplyFa.allLots + Number(availableLotsCap);
            }
            if ((await this.em.count(Pool, { fasset })) == 0) {
                //calculate price of fees
                rewardsAvailableUSD = sumUsdStrings(rewardsAvailableUSD, "0");
                logger.info(`Pools for fasset ${fasset} updated in: ${(Date.now() - start) / 1000}`);
                supplyFa.supply = formatFixed(toBN(mintedUBA), Number(settings.assetDecimals), {
                    decimals: fasset.includes("XRP") ? 3 : 6,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                if (supplyFa.allLots == 0) {
                    supplyFa.mintedPercentage = "0.00";
                } else {
                    supplyFa.mintedPercentage = ((supplyFa.availableToMintLots / supplyFa.allLots) * 100).toFixed(2);
                }
                supplyFasset.push(supplyFa);
                poolPaid.push({ fasset: fasset, rewards: "0", rewardsUSD: "0" });
                totalPoolPaidUSD = sumUsdStrings(totalPoolPaidUSD, "0");
                continue;
            }
            //calculate price of fees
            const existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
            const feesAvailableUSD = toBN(feesAvailable).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
            const feesAvailableUSDFormatted = formatFixed(feesAvailableUSD, Number(settings.assetDecimals), {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            });
            rewardsAvailableUSD = sumUsdStrings(rewardsAvailableUSD, feesAvailableUSDFormatted);
            logger.info(`Pools for fasset ${fasset} updated in: ${(Date.now() - start) / 1000}`);
            supplyFa.supply = formatFixed(toBN(mintedUBA), Number(settings.assetDecimals), {
                decimals: fasset.includes("XRP") ? 3 : 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            if (supplyFa.allLots == 0) {
                supplyFa.mintedPercentage = "0.00";
            } else {
                supplyFa.mintedPercentage = ((supplyFa.availableToMintLots / supplyFa.allLots) * 100).toFixed(2);
            }
            supplyFasset.push(supplyFa);
            const fa = NETWORK_SYMBOLS.find((fa) => (this.envType == "dev" ? fa.test : fa.real) === fasset);
            const rewards = poolRewardsPaid[fa.real];
            const rewardsAsset = formatFixed(toBN(rewards?.value ?? "0").add(toBN(feesAvailable)), Number(settings.assetDecimals), {
                decimals: fasset.includes("XRP") ? 3 : 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            const rewardsAssetUSD = toBN(rewards?.value ?? "0")
                .mul(existingPriceAsset.price)
                .div(toBNExp(1, existingPriceAsset.decimals));
            const rewardsAssetUSDFormatted = formatFixed(rewardsAssetUSD, Number(settings.assetDecimals), {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            });
            poolPaid.push({ fasset: fasset, rewards: rewardsAsset, rewardsUSD: rewardsAssetUSDFormatted });
            totalPoolPaidUSD = sumUsdStrings(totalPoolPaidUSD, rewardsAssetUSDFormatted);

            //Process top pools for this fasset
            //TODO change for real and production use
            const faNetw = NETWORK_SYMBOLS.find((n) => (this.envType == "dev" ? n.test : n.real) == fasset);
            if (!topPools[faNetw.real]) {
                continue;
            }
            for (const tp of topPools[faNetw.real]) {
                const agent = await this.em.findOne(Pool, { poolAddress: tp.pool });
                if (!agent) {
                    continue;
                }
                const claimedUSD = toBN(tp.claimed).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
                const claimedUSDFormatted = formatFixed(claimedUSD, Number(settings.assetDecimals), {
                    decimals: 3,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                bestPools.push({
                    name: agent.agentName,
                    vaultAddress: agent.vaultAddress,
                    poolAddress: agent.poolAddress,
                    fasset: fasset,
                    collateralSymbol: agent.vaultCollateralToken,
                    tvl: agent.poolOnlyCollateralUSD,
                    rewardsPaid: claimedUSDFormatted,
                    url: agent.url,
                });
            }
        }
        const numOfLiq = await this.externalApiService.getTotalLiquidationCount();
        if (Number(numOfLiq) != 0 || Number(this.numberOfLiquidations) == 0) {
            this.numberOfLiquidations = numOfLiq;
        }
        const numOfMints = Number(await this.externalApiService.getTotalMintCount());
        if (Number(numOfMints) != 0 || Number(this.numMints) == 0) {
            this.numMints = numOfMints;
        }
        this.ecosystemTVL = currentTVL;
        this.mintedAll = mintedAll;
        this.fassetCirculatingSupply = supplyFasset;
        this.agentsInLiquidation = agentsLiq;
        this.numAgents = await this.em.count(Pool);
        //this.numberOfLiquidations = numLiq;
        this.rewardsAvailableUSD = rewardsAvailableUSD;
        this.overCollaterized = calculateOvercollateralizationPercentage(totalCollateral, this.mintedAll);
        this.collateralCirculatingSupply = supplyCollateral;
        this.totalCollateral = totalCollateral;
        this.tvlPoolsNat = tvlpoolsnat;
        //this.numMints = numMints;
        this.totalPoolRewardsPaidUSD = sumUsdStrings(totalPoolPaidUSD, rewardsAvailableUSD);
        this.poolRewards = poolPaid;
        this.topPools = bestPools;
        this.agentPoolCollateral = agentPoolCollateralOnly;
        const numTransactions = await this.externalApiService.getPoolTransactionCount();
        if (Number(numTransactions) != 0 || Number(this.ecosystemTransactions) == 0) {
            this.ecosystemTransactions = numTransactions;
        }
        logger.info(`Finish updating pools`);
    }

    getUserBot(fasset: string): UserBotCommands {
        return this.botMap.get(fasset);
    }

    getUserBotMap(): Map<string, UserBotCommands> {
        return this.botMap;
    }

    getInfoBot(fasset: string): InfoBotCommands {
        return this.infoBotMap.get(fasset);
    }

    getRelay(): IRelayInstance {
        return this.relay;
    }

    getEcosystemInfo(): EcosystemData {
        return {
            tvl: this.ecosystemTVL,
            tvlPoolsNat: this.tvlPoolsNat,
            numTransactions: this.ecosystemTransactions,
            numAgents: this.numAgents,
            agentsInLiquidation: this.agentsInLiquidation,
            supplyByFasset: this.fassetCirculatingSupply,
            totalMinted: this.mintedAll,
            numLiquidations: this.numberOfLiquidations,
            rewardsAvailableUSD: this.rewardsAvailableUSD,
            overCollaterazied: this.overCollaterized,
            supplyByCollateral: this.collateralCirculatingSupply,
            totalCollateral: this.totalCollateral,
            numMints: this.numMints,
            totalPoolRewardsPaidUSD: this.totalPoolRewardsPaidUSD,
            poolRewards: this.poolRewards,
            numHolders: this.holders,
            agentCollateral: this.agentPoolCollateral,
        };
    }

    getFassetDecimals(fasset: string): number {
        return this.fassetDecimals.find((f) => f.fasset === fasset).decimals;
    }

    getAssetSymbol(fasset: string): string {
        return this.fassetSymbol.get(fasset);
    }

    getCollateralList(): string[] {
        return this.collateralTokenList;
    }

    async getTimeSeries(time: string): Promise<any> {
        const data: TimeData = await this.cacheManager.get(time + "Data");
        return data;
    }

    getSecrets(): Secrets {
        return this.secrets;
    }
}
