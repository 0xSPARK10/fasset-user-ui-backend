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
import { BlockNumber, Log } from "web3-core";
import { Liveness } from "../entities/AgentLiveness";
import { readFileSync } from "fs";
import { EMPTY_SUPPLY_BY_COLLATERAL, NETWORK_SYMBOLS, PROOF_OF_RESERVE } from "src/utils/constants";
import {
    CurrencyMap,
    EcosystemData,
    AssetManagerFasset,
    FassetDecimals,
    PoolRewards,
    Price,
    SupplyFasset,
    SupplyTotalCollateral,
    TimeData,
    TopPool,
    TopPoolData,
    TimeDataCV,
    ProofOfReserve,
} from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { AxiosRequestConfig } from "axios";
import { Collateral } from "src/entities/Collaterals";
import { calculateOvercollateralizationPercentage, formatBNToDisplayDecimals, sumUsdStrings } from "src/utils/utils";
import { ExternalApiService } from "./external.api.service";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { Secrets } from "@flarelabs/fasset-bots-core";
import { EvmEvent } from "@flarelabs/fasset-bots-core";
import { Web3ContractEventDecoder } from "@flarelabs/fasset-bots-core";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { IndexerState } from "src/entities/IndexerState";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { Redemption } from "src/entities/Redemption";
import { Minting } from "src/entities/Minting";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { MintingDefaultEvent } from "src/entities/MintingDefaultEvent";
import {
    calculateFassetSupplyDiff,
    calculateInflowsOutflowsDiff,
    calculatePoolCollateralDiff,
    calculatePoolRewardsDiff,
    formatTimeSeries,
    formatTimeSeriesPercentage,
    formatTimeSpanRatio,
    formatTimespanToTimeseries,
    generateTimestamps,
    isEmptyObject,
} from "src/utils/dashboard.utils";

const IRelay = artifacts.require("IRelay");
const IERC20 = artifacts.require("IERC20Metadata");
const CollateralPool = artifacts.require("CollateralPool");

@Injectable()
export class BotService implements OnModuleInit {
    private botMap: Map<string, UserBotCommands> = new Map();
    private infoBotMap: Map<string, InfoBotCommands> = new Map();
    private relay: IRelayInstance;
    private isRunning: boolean = false;
    private isRunningRedQueue: boolean = false;
    private apiUrl: string;
    private costonBotPath: string;
    private username: string;
    private password: string;
    private lastEventBlockMap: Map<string, number> = new Map();
    private lastEventBlock: number;
    private fassetSymbol: Map<string, string> = new Map();
    private secrets: Secrets;
    private executor: string;
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
    numRedeems: number = 0;
    totalPoolRewardsPaidUSD: string = "0";
    poolRewards: PoolRewards[] = [];
    holders: number = 0;
    topPools: TopPoolData[] = [];
    envType: string;
    network: string;
    agentPoolCollateral: string = "0";
    coreVaultSupply: string = "0";
    coreVaultSupplyUSD: string = "0";
    coreVaultInflows: string = "0";
    coreVaultInflowsUSD: string = "0";
    coreVaultOutflows: string = "0";
    coreVaultOutflowsUSD: string = "0";
    proofOfReserve: ProofOfReserve = PROOF_OF_RESERVE;

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
        this.network = this.configService.get<string>("NETWORK", "coston");
    }

    async onModuleInit() {
        logger.info(`Initializing BotService ...`);
        this.em = this.orm.em.fork();
        let pathForConfig = this.costonBotPath;
        if (!pathForConfig) {
            pathForConfig = this.network + "-bot.json";
        }
        // Initialize the variable here
        const filePathSecrets = join(__dirname, "../..", "src", "secrets.json");
        const filePathConfig = join(__dirname, "../..", "src", pathForConfig);
        const userDataDirPath = join(__dirname, "../..", "src", "userDataDir");
        // Change config file based on env.
        this.eventTopics = [
            web3.utils.keccak256("AgentPingResponse(address,address,uint256,string)"),
            web3.utils.keccak256("CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)"),
            web3.utils.keccak256("RedemptionRequested(address,address,uint256,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256)"),
            web3.utils.keccak256("RedemptionDefault(address,address,uint256,uint256,uint256,uint256)"),
            web3.utils.keccak256("RedemptionRequestIncomplete(address,uint256)"),
            web3.utils.keccak256("MintingPaymentDefault(address,address,uint256,uint256)"),
        ];

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
            this.executor = this.botMap.get(fasset).nativeAddress;
            this.lastEventBlockMap.set(fasset, (await web3.eth.getBlockNumber()) - this.infoBotMap.get(fasset).context.nativeChainInfo.finalizationBlocks);
            const settings = await this.infoBotMap.get(fasset).context.assetManager.getSettings();
            this.assetManagerList.push({
                fasset: fasset,
                assetManager: this.infoBotMap.get(fasset).context.assetManager.address,
                decimals: Number(settings.assetDecimals),
            });
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
            await this.updateRedemptionQueue(fasset);
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
        cron.schedule("*/1 * * * *", async () => {
            if (!this.isRunningRedQueue) {
                this.isRunningRedQueue = true;
                try {
                    await this.updateRedemptionQueue(this.envType == "dev" ? "FTestXRP" : "FXRP");
                } catch (error) {
                    logger.error(`'Error running updateRedemptionQueue:`, error);
                } finally {
                    this.isRunningRedQueue = false;
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
                    n = 10;
                    break;
                case 3:
                    timeScopeAPI = "year";
                    timeScopeTime = 365 * 24 * 60 * 60;
                    n = 10;
                    break;
                case 4:
                    timeScopeAPI = "yearToDate";
                    const now = new Date();
                    const startOfYear = new Date(now.getFullYear(), 0, 1);
                    timeScopeTime = Math.floor((Date.now() - startOfYear.getTime()) / 1000);
                    n = 10;
                    break;
                case 5:
                    timeScopeAPI = "allTime";
                    timeScopeTime = 5 * 365 * 24 * 60 * 60;
                    n = 10;
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
                const diffTvl = calculatePoolCollateralDiff(collateralPoolDiff);
                let diffRewards;
                if (Object.keys(collectedPoolFees).length === 0) {
                    diffRewards = calculatePoolRewardsDiff([
                        { timestamp: 123, value: "0" },
                        { timestamp: 1234, value: "0" },
                    ]);
                } else {
                    if (Object.keys(collectedPoolFees).length === 1) {
                        diffRewards = calculatePoolRewardsDiff([{ timestamp: 123, value: "0" }, collectedPoolFees[netw.real][0]]);
                    } else {
                        diffRewards = calculatePoolRewardsDiff(collectedPoolFees[netw.real]);
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
            if (isEmptyObject(supply)) {
                for (const f of this.fassetList) {
                    diffs.push({ fasset: f, diff: "0.0", isPositive: true });
                }
            } else {
                diffs = calculateFassetSupplyDiff(supply, this.fassetList, this.envType);
            }
            let pointMint = await this.externalApiService.getMintTimeseries(now, n, dayTimestamp);
            if (isEmptyObject(pointMint) || pointMint == 0 || pointMint.length == 0) {
                pointMint = [];
                pointMint.push({
                    index: 0,
                    start: dayTimestamp,
                    end: now,
                    value: "0",
                });
            }
            let pointRedeem = await this.externalApiService.getRedeemTimeseries(now, n, dayTimestamp);
            if (isEmptyObject(pointRedeem) || pointRedeem == 0 || pointRedeem.length == 0) {
                pointRedeem = [];
                pointRedeem.push({
                    index: 0,
                    start: dayTimestamp,
                    end: now,
                    value: "0",
                });
            }
            const graphMints = formatTimeSeries(pointMint);
            const graphRedeems = formatTimeSeries(pointRedeem);
            const totalCollateralDifference = await this.externalApiService.getTotalPoolCollateralDiff(dayTimestamp.toString(), now.toString());
            const totalCollateralDiff = calculatePoolCollateralDiff(totalCollateralDifference);
            // TODO actual calculation from indexer
            let pointInflows = await this.externalApiService.getCVInflowTimeseries(now, n, dayTimestamp);
            if (isEmptyObject(pointInflows) || pointInflows == 0 || pointInflows.length == 0) {
                pointInflows = [];
                pointInflows.push({
                    index: 0,
                    start: dayTimestamp,
                    end: now,
                    value: "0",
                });
            }
            let pointOutflows = await this.externalApiService.getCVOutflowTimeSeries(now, n, dayTimestamp);
            if (isEmptyObject(pointOutflows) || pointOutflows == 0 || pointOutflows.length == 0) {
                pointOutflows = [];
                pointOutflows.push({
                    index: 0,
                    start: dayTimestamp,
                    end: now,
                    value: "0",
                });
            }
            const graphInflows = formatTimeSeries(pointInflows);
            const graphOutflows = formatTimeSeries(pointOutflows);
            const indexerTimestamps = [];
            for (const g of graphInflows) {
                indexerTimestamps.push(g.timestamp.toString());
            }
            const cvTvlTimestamps = await this.externalApiService.getCVTotalBalanceTimestamps(indexerTimestamps);
            const graphTVL = formatTimespanToTimeseries(cvTvlTimestamps);
            const getInflowsDiff = await this.externalApiService.getCVInflowsDiff(dayTimestamp.toString(), now.toString());
            const getOutflowsDiff = await this.externalApiService.getCVOutflowsDiff(dayTimestamp.toString(), now.toString());
            const inflowsDiff = calculateInflowsOutflowsDiff(getInflowsDiff);
            const outflowsDiff = calculateInflowsOutflowsDiff(getOutflowsDiff);
            const getCVDiff = await this.externalApiService.getCVTotalDiff(dayTimestamp.toString(), now.toString());
            const cvDiff = calculatePoolCollateralDiff(getCVDiff);
            const timestampsRatio = generateTimestamps(dayTimestamp, now, n);
            let proofOfReserve = await this.externalApiService.getCVratio(timestampsRatio);
            let graphPR = formatTimeSpanRatio(proofOfReserve["FXRP"]);
            if (!proofOfReserve["FXRP"]) {
                proofOfReserve = [
                    {
                        index: "0",
                        start: dayTimestamp,
                        end: now - 10000,
                        value: "100.12",
                    },
                    {
                        index: "0",
                        start: dayTimestamp,
                        end: now,
                        value: "101.14",
                    },
                ];
                graphPR = formatTimeSeriesPercentage(proofOfReserve);
            }
            /*const proofOfReserve: TimeSeriesIndexer[] = [
                {
                    index: "0",
                    start: dayTimestamp,
                    end: now - 10000,
                    value: "100.12",
                },
                {
                    index: "0",
                    start: dayTimestamp,
                    end: now,
                    value: "101.14",
                },
            ];*/
            //const graphPR = await this.formatTimeSeriesPercentage(proofOfReserve);
            const coreVaultData: TimeDataCV = {
                supplyDiff: cvDiff.diff,
                isPositiveSupplyDiff: cvDiff.isPositive,
                inflowGraph: graphInflows,
                outflowGraph: graphOutflows,
                inflowDiff: inflowsDiff.diff,
                isPositiveInflowDiff: inflowsDiff.isPositive,
                outflowDiff: outflowsDiff.diff,
                isPositiveOutflowDiff: outflowsDiff.isPositive,
                tvlGraph: graphTVL,
            };
            const timeData: TimeData = {
                supplyDiff: diffs,
                mintGraph: graphMints,
                redeemGraph: graphRedeems,
                bestPools: topPoolsData,
                totalCollateralDiff: totalCollateralDiff.diff,
                isPositiveCollateralDiff: totalCollateralDiff.isPositive,
                coreVaultData: coreVaultData,
                proofOfReserve: graphPR,
            };
            await this.cacheManager.set(timeScopeAPI + "Data", timeData, 0);
        }
        logger.info("Finished updating time data");
    }

    async readEvents(): Promise<void> {
        const blockReadOffset = 30;
        const bot = this.getInfoBot(this.fassetList[0]);
        while (true) {
            try {
                const timestamp = Date.now();
                const lastBlock = (await web3.eth.getBlockNumber()) - 4;
                const lastBlockDB = await this.em.findOne(IndexerState, { name: "lastBlock" });
                let lastEventBlock: number;
                if (lastBlockDB) {
                    lastEventBlock = lastBlockDB.lastBlock;
                } else {
                    lastEventBlock = lastBlock;
                    const lbDB = new IndexerState("lastBlock", lastBlock);
                    await this.em.persistAndFlush(lbDB);
                }
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
                                if (event.args.executor != this.executor) {
                                    continue;
                                }
                                const count = await this.em.count(CollateralReservationEvent, {
                                    txhash: event.transactionHash,
                                    collateralReservationId: event.args.collateralReservationId,
                                });
                                if (count == 0) {
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
                                        timestamp,
                                        event.transactionHash
                                    );
                                    await this.em.persistAndFlush(crEvent);
                                }
                                const mint = await this.em.count(Minting, {
                                    txhash: event.transactionHash,
                                    collateralReservationId: event.args.collateralReservationId,
                                });
                                if (mint == 0) {
                                    const paymentAmount = toBN(event.args.valueUBA);
                                    const amount = formatBNToDisplayDecimals(toBN(paymentAmount), am.fasset.includes("XRP") ? 2 : 8, am.decimals);
                                    const time = new Date(timestamp + 7 * 24 * 60 * 60 * 1000);
                                    const validUntil = time.getTime();
                                    const tx = await this.em.findOne(UnderlyingPayment, {
                                        paymentReference: event.args.paymentReference,
                                    });
                                    const minting = new Minting(
                                        event.args.collateralReservationId,
                                        tx ? tx.underlyingHash : null,
                                        event.args.paymentAddress,
                                        event.args.minter,
                                        false,
                                        validUntil,
                                        false,
                                        am.fasset,
                                        event.args.minter,
                                        amount,
                                        timestamp,
                                        event.args.agentVault,
                                        event.args.paymentReference
                                    );
                                    await this.em.persistAndFlush(minting);
                                }
                            } else {
                                if (event.event === "RedemptionRequested") {
                                    if (event.args.executor != this.executor) {
                                        continue;
                                    }
                                    const count = await this.em.count(RedemptionRequested, {
                                        txhash: event.transactionHash,
                                        requestId: event.args.requestId,
                                    });
                                    if (count != 0) {
                                        continue;
                                    }
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
                                        timestamp,
                                        event.transactionHash,
                                        am.fasset
                                    );
                                    await this.em.persistAndFlush(redemptionRequestedEvent);
                                    const red = await this.em.count(Redemption, {
                                        txhash: event.transactionHash,
                                        requestId: event.args.requestId,
                                    });
                                    if (red == 0) {
                                        const amountUBA = toBN(event.args.valueUBA).sub(toBN(event.args.feeUBA));
                                        const time = new Date(timestamp + 7 * 24 * 60 * 60 * 1000);
                                        const validUntil = time.getTime();
                                        const redemption = new Redemption(
                                            event.transactionHash,
                                            false,
                                            event.args.paymentAddress,
                                            event.args.paymentReference,
                                            amountUBA.toString(),
                                            event.args.firstUnderlyingBlock,
                                            event.args.lastUnderlyingBlock,
                                            event.args.lastUnderlyingTimestamp,
                                            event.args.requestId,
                                            validUntil,
                                            am.fasset,
                                            timestamp
                                        );
                                        await this.em.persistAndFlush(redemption);
                                    }
                                } else {
                                    if (event.event == "RedemptionDefault") {
                                        const redemptionDefaultEvent = new RedemptionDefaultEvent(
                                            event.args.agentVault,
                                            event.args.redeemer,
                                            event.args.requestId,
                                            event.args.redemptionAmountUBA,
                                            event.args.redeemedVaultCollateralWei,
                                            event.args.redeemedPoolCollateralWei,
                                            timestamp,
                                            event.transactionHash
                                        );
                                        await this.em.persistAndFlush(redemptionDefaultEvent);
                                    } else {
                                        if (event.event == "RedemptionRequestIncomplete") {
                                            const redemptionIncompleteEvent = new IncompleteRedemption(
                                                event.transactionHash,
                                                event.args.redeemer,
                                                event.args.remainingLots,
                                                timestamp
                                            );
                                            await this.em.persistAndFlush(redemptionIncompleteEvent);
                                        } else {
                                            if (event.event == "MintingPaymentDefault") {
                                                const mintingDefault = new MintingDefaultEvent(
                                                    event.args.agentVault,
                                                    event.args.minter,
                                                    event.args.collateralReservationId,
                                                    event.args.reservedAmountUBA,
                                                    timestamp,
                                                    event.transactionHash
                                                );
                                                await this.em.persistAndFlush(mintingDefault);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                //this.lastEventBlockMap.set(fasset, lastBlock);
                //this.lastEventBlock = lastBlock + 1;
                if (!lastBlockDB) {
                    const lbDB = new IndexerState("lastBlock", lastBlock + 1);
                    await this.em.persistAndFlush(lbDB);
                } else {
                    lastBlockDB.lastBlock = lastBlock + 1;
                    await this.em.persistAndFlush(lastBlockDB);
                }
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

    async readEventsFrom(contract: Truffle.ContractInstance, fromBlock: BlockNumber, toBlock: BlockNumber): Promise<EvmEvent[]> {
        const eventDecoder = new Web3ContractEventDecoder({ contract });
        const allLogs = await this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.eventTopics);
        return eventDecoder.decodeEvents(allLogs);
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

        const redeemedLotsTotal = await this.externalApiService.getTotalRedeemedLots();
        let redeemedLots = 0;
        for (const l in redeemedLotsTotal) {
            if (redeemedLotsTotal.hasOwnProperty(l)) {
                redeemedLots = redeemedLots + redeemedLotsTotal[l].amount;
            }
        }
        this.numRedeems = redeemedLots;

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
                availableToMintAsset: "0",
                mintedLots: 0,
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
                    1,
                    Number(collateral.safetyMinCollateralRatioBIPS) / MAX_BIPS
                );
                await this.em.persistAndFlush(newCollateral);
            }
            for (let i = 0; i < collateralsToUpdate.length; i++) {
                const collateral = collateralsToUpdate[i];
                const updatedCollateral = collaterals.find((c) => c.token === collateral.token);
                collateral.assetFtsoSymbol = updatedCollateral.assetFtsoSymbol;
                collateral.ccbMinCollateralRatioBIPS = 1;
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
                    this.externalApiService.getMints(agent).catch((error) => {
                        logger.error(`Error in getMints`, error);
                        return 0;
                    }),
                    this.externalApiService.getLiquidationCount(agent).catch((error) => {
                        logger.error(`Error in getLiquidationCount`, error);
                        return 0;
                    }),
                    this.externalApiService.getRedemptionSuccessRate(agent).catch((error) => {
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
                    //supplyFa.minted = sumUsdStrings(supplyFa.minted, mintedUSDFormatted);
                    const allLots = mintedReservedLots.toNumber() + Number(info.freeCollateralLots);
                    if (mintingCap.toString() === "0") {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                            supplyFa.availableToMintUSD = sumUsdStrings(supplyFa.availableToMintUSD, remainingUSDFormatted);
                        }
                    } else {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                        }
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
                        mintingPoolCR,
                        mintingVaultCR,
                        info.vaultCollateralToken,
                        description,
                        mintedAssets,
                        mintedUSDFormatted,
                        allLots,
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
                    this.externalApiService.getMints(agent.vaultAddress).catch((error) => {
                        logger.error(`Error in getMints`, error);
                        return 0;
                    }),
                    this.externalApiService.getLiquidationCount(agent.vaultAddress).catch((error) => {
                        logger.error(`Error in getLiquidationCount`, error);
                        return 0;
                    }),
                    this.externalApiService.getRedemptionSuccessRate(agent.vaultAddress).catch((error) => {
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
                    //supplyFa.minted = sumUsdStrings(supplyFa.minted, mintedUSDFormatted);
                    const allLots = mintedReservedLots.toNumber() + Number(info.freeCollateralLots);
                    if (mintingCap.toString() === "0") {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                            supplyFa.availableToMintUSD = sumUsdStrings(supplyFa.availableToMintUSD, remainingUSDFormatted);
                        }
                    } else {
                        if ((Number(info.status) == 0 || Number(info.status) == 1) && info.publiclyAvailable == true) {
                            supplyFa.availableToMintLots = supplyFa.availableToMintLots + Number(info.freeCollateralLots);
                        }
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
                    agent.mintingVaultCR = mintingVaultCR;
                    agent.mintingPoolCR = mintingPoolCR;
                    agent.vaultToken = info.vaultCollateralToken;
                    agent.mintedUSD = mintedUSDFormatted;
                    agent.allLots = allLots;
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
            const faSupply = await this.botMap.get(fasset).context.fAsset.totalSupply();
            const mintedLots = toBN(faSupply).div(lotSizeUBA);
            supplyFa.mintedLots = toBN(mintedLots).toNumber();
            if (mintingCap.toString() != "0") {
                const availableToMintUBA = mintingCap.sub(toBN(faSupply));
                const freeLotsUBA = toBN(supplyFa.availableToMintLots).mul(lotSizeUBA);
                const availableLotsCap = Math.min(availableToMintUBA.div(lotSizeUBA).toNumber(), supplyFa.availableToMintLots);
                supplyFa.availableToMintLots = Number(availableLotsCap);
                let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                if (!existingPriceAsset) {
                    const priceAsset = await priceReader.getPrice(this.fassetSymbol.get(fasset), false, settings.maxTrustedPriceAgeSeconds);
                    prices.push({
                        symbol: this.fassetSymbol.get(fasset),
                        price: priceAsset.price,
                        decimals: Number(priceAsset.decimals),
                    });
                    existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                }
                const availableToMintUSD =
                    Number(availableLotsCap) == 0
                        ? toBN(0)
                        : toBN(Math.min(availableToMintUBA.toNumber(), freeLotsUBA.toNumber()))
                              .mul(existingPriceAsset.price)
                              .div(toBNExp(1, Number(existingPriceAsset.decimals)));
                const availableToMintUSDFormatted = formatFixed(availableToMintUSD, Number(settings.assetDecimals), {
                    decimals: 3,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                supplyFa.availableToMintUSD = availableToMintUSDFormatted;
                supplyFa.allLots = mintedLots.toNumber() + Number(availableLotsCap);
            } else {
                supplyFa.allLots = supplyFa.availableToMintLots + supplyFa.mintedLots;
            }
            let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
            if (!existingPriceAsset) {
                const priceAsset = await priceReader.getPrice(this.fassetSymbol.get(fasset), false, settings.maxTrustedPriceAgeSeconds);
                prices.push({
                    symbol: this.fassetSymbol.get(fasset),
                    price: priceAsset.price,
                    decimals: Number(priceAsset.decimals),
                });
                existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
            }
            const faSupplyUSD = toBN(faSupply).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
            supplyFa.minted = formatFixed(faSupplyUSD, Number(settings.assetDecimals), {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            });
            if ((await this.em.count(Pool, { fasset })) == 0) {
                //calculate price of fees
                rewardsAvailableUSD = sumUsdStrings(rewardsAvailableUSD, "0");
                logger.info(`Pools for fasset ${fasset} updated in: ${(Date.now() - start) / 1000}`);
                supplyFa.supply = formatFixed(toBN(faSupply), Number(settings.assetDecimals), {
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
            const feesAvailableUSD = toBN(feesAvailable).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
            const feesAvailableUSDFormatted = formatFixed(feesAvailableUSD, Number(settings.assetDecimals), {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            });
            rewardsAvailableUSD = sumUsdStrings(rewardsAvailableUSD, feesAvailableUSDFormatted);
            logger.info(`Pools for fasset ${fasset} updated in: ${(Date.now() - start) / 1000}`);
            supplyFa.supply = formatFixed(toBN(faSupply), Number(settings.assetDecimals), {
                decimals: fasset.includes("XRP") ? 3 : 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            if (supplyFa.allLots == 0) {
                supplyFa.mintedPercentage = "0.00";
                supplyFa.availableToMintAsset = "0";
            } else {
                if (await this.botMap.get(fasset).context.assetManager.mintingPaused()) {
                    supplyFa.mintedPercentage = ((supplyFa.availableToMintLots / supplyFa.allLots) * 100).toFixed(2);
                    supplyFa.availableToMintAsset = "0";
                    supplyFa.availableToMintLots = 0;
                    supplyFa.availableToMintUSD = "0";
                } else {
                    supplyFa.mintedPercentage = ((supplyFa.availableToMintLots / supplyFa.allLots) * 100).toFixed(2);
                    const availableToMintUBA = toBN(supplyFa.availableToMintLots).mul(toBN(lotSizeUBA));
                    supplyFa.availableToMintAsset = formatFixed(availableToMintUBA, Number(settings.assetDecimals), {
                        decimals: fasset.includes("XRP") ? 3 : 6,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                }
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

            //COre vault balance
            if (fasset.includes("XRP")) {
                const existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                const getCoreVaultInflows = await this.externalApiService.getCVInflows(start);
                const getCoreVaultOutflows = await this.externalApiService.getCVOutflows(start);
                const coreVaultInflows = getCoreVaultInflows["FXRP"][0].value;
                const coreVaultOutflows = getCoreVaultOutflows["FXRP"][0].value;
                const inflowsUSD = toBN(coreVaultInflows).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
                const outflowsUSD = toBN(coreVaultOutflows).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
                this.coreVaultInflows = formatFixed(toBN(coreVaultInflows), 6, {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                this.coreVaultInflowsUSD = formatFixed(inflowsUSD, Number(settings.assetDecimals), {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                this.coreVaultOutflows = formatFixed(toBN(coreVaultOutflows), 6, {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                this.coreVaultOutflowsUSD = formatFixed(outflowsUSD, Number(settings.assetDecimals), {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                const cvTotal = toBN(coreVaultInflows).sub(toBN(coreVaultOutflows));
                const cvTotalUSD = toBN(cvTotal).mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
                const cvTotalUSDFormatted = formatFixed(cvTotalUSD, Number(settings.assetDecimals), {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                this.coreVaultSupply = formatFixed(cvTotal, 6, { decimals: 2, groupDigits: true, groupSeparator: "," });
                this.coreVaultSupplyUSD = cvTotalUSDFormatted;
                // Proof of reserve calculation
                const cvAmount = await infoBot.context.assetManager.coreVaultAvailableAmount();
                const cvRequestedAmount = await infoBot.context.coreVaultManager.totalRequestAmountWithFee();
                const totalReserve = toBN((await this.externalApiService.getCVBacking())["FXRP"].value)
                    .add(toBN(cvAmount[1]))
                    .add(toBN(cvRequestedAmount));
                const reserveUSD = totalReserve.mul(existingPriceAsset.price).div(toBNExp(1, existingPriceAsset.decimals));
                const reserveUSDFormatted = formatFixed(reserveUSD, Number(settings.assetDecimals), {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                const ratio = faSupply.eqn(0) ? toBNExp(1, 10) : totalReserve.mul(toBNExp(1, 10)).div(faSupply).mul(toBN(100));
                let ratioCalc = Number(ratio.toString()) / 1e10;
                if (ratioCalc < 100) {
                    ratioCalc = 100;
                }

                const ratioFormatted = ratioCalc.toFixed(2);
                const proofOfReserve: ProofOfReserve = {
                    total: supplyFa.supply,
                    totalUSD: supplyFa.minted,
                    reserve: formatFixed(totalReserve, 6, { decimals: 2, groupDigits: true, groupSeparator: "," }),
                    reserveUSD: reserveUSDFormatted,
                    ratio: ratioFormatted,
                };
                this.proofOfReserve = proofOfReserve;
            }
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
        if (supplyCollateral.length == 0) {
            supplyCollateral.push(...EMPTY_SUPPLY_BY_COLLATERAL);
        }
        for (const c of supplyCollateral) {
            if (c.symbol == "USDT") {
                c.symbol = "USDT0";
            }
        }
        this.ecosystemTVL = currentTVL;
        this.mintedAll = mintedAll;
        this.fassetCirculatingSupply = supplyFasset;
        this.agentsInLiquidation = agentsLiq;
        this.numAgents = await this.em.count(Liveness, { fasset: this.envType == "dev" ? "FTestXRP" : "FXRP", publiclyAvailable: true });
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
        //TODO change core vault supply to actual core vault balance
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
            numRedeems: this.numRedeems,
            coreVaultSupply: this.coreVaultSupply,
            coreVaultSupplyUSD: this.coreVaultSupplyUSD,
            coreVaultInflows: this.coreVaultInflows,
            coreVaultInflowsUSD: this.coreVaultInflowsUSD,
            coreVaultOutflows: this.coreVaultOutflows,
            coreVaultOutflowsUSD: this.coreVaultOutflowsUSD,
            proofOfReserve: this.proofOfReserve,
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

    async updateRedemptionQueue(fasset: string): Promise<void> {
        const bot = this.getInfoBot(fasset);
        const settings = await bot.context.assetManager.getSettings();
        const maxTickets = Number(settings.maxRedeemedTickets);
        const lotSizeUBA = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
        let maxSingleRedemtionTotal = toBN(0);
        let maxShortTermRedemptionTotal = toBN(0);
        let redemptionQueue = await bot.context.assetManager.redemptionQueue(0, maxTickets);
        if (redemptionQueue[0].length == 0) {
            await this.cacheManager.set(fasset + "maxLotsSingleRedeem", 0, 0);
            await this.cacheManager.set(fasset + "maxLotsTotalRedeem", 0, 0);
            return;
        }
        maxSingleRedemtionTotal = redemptionQueue[0].reduce((acc, num) => acc.add(toBN(num.ticketValueUBA)), toBN(0));
        maxShortTermRedemptionTotal = maxSingleRedemtionTotal;
        while (toBN(redemptionQueue[1]).toString() != "0") {
            redemptionQueue = await bot.context.assetManager.redemptionQueue(toBN(redemptionQueue[1]).toString(), 20);
            maxShortTermRedemptionTotal = maxShortTermRedemptionTotal.add(redemptionQueue[0].reduce((acc, num) => acc.add(toBN(num.ticketValueUBA)), toBN(0)));
        }
        const maxSingleLotsToRedeem = maxSingleRedemtionTotal.div(toBN(lotSizeUBA));
        const maxShortTermLotsTotal = maxShortTermRedemptionTotal.div(toBN(lotSizeUBA));
        await this.cacheManager.set(fasset + "maxLotsSingleRedeem", maxSingleLotsToRedeem, 0);
        await this.cacheManager.set(fasset + "maxLotsTotalRedeem", maxShortTermLotsTotal, 0);
    }
}
