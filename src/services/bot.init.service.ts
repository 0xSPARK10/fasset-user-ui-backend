/* eslint-disable @typescript-eslint/no-explicit-any */
import { CollateralClass, InfoBotCommands, TokenPriceReader, UserBotCommands } from "@flarelabs/fasset-bots-core";
import { IRelayInstance } from "@flarelabs/fasset-bots-core/types";
import { MAX_BIPS, artifacts, formatFixed, toBN, toBNExp } from "@flarelabs/fasset-bots-core/utils";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { join } from "path";
import { Pool } from "../entities/Pool";
import * as cron from "node-cron";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { Liveness } from "../entities/AgentLiveness";
import { readFileSync } from "fs";
import { EMPTY_SUPPLY_BY_COLLATERAL, FILTER_AGENT, NETWORK_SYMBOLS, PROOF_OF_RESERVE } from "src/utils/constants";
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
    TopPoolData,
    ProofOfReserve,
} from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { Collateral } from "src/entities/Collaterals";
import { calculateOvercollateralizationPercentage, calculateUSDValue, getDefaultTimeData, sumUsdStrings, toBNDecimal } from "src/utils/utils";
import { ExternalApiService } from "./external.api.service";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { Secrets } from "@flarelabs/fasset-bots-core";
import { TimeDataService } from "./time.data.service";

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
    private isRunningTimeData: boolean = false;
    private costonBotPath: string;
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
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly timeDataService: TimeDataService
    ) {
        this.costonBotPath = this.configService.get<string>("BOT_CONFIG_PATH");
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
            const settings = await this.infoBotMap.get(fasset).context.assetManager.getSettings();
            this.assetManagerList.push({
                fasset: fasset,
                assetManager: this.infoBotMap.get(fasset).context.assetManager.address,
                decimals: Number(settings.assetDecimals),
            });
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
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.getTimeData();
        cron.schedule("*/30 * * * *", async () => {
            if (!this.isRunningTimeData) {
                this.isRunningTimeData = true;
                try {
                    await this.getTimeData();
                } catch (error) {
                    logger.error(`'Error running getTimeData:`, error);
                } finally {
                    this.isRunningTimeData = false;
                }
            }
        });
        cron.schedule("*/1 * * * *", async () => {
            if (!this.isRunning) {
                this.isRunning = true;
                try {
                    await this.getPools();
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

    //Get time data for landing page
    async getTimeData(): Promise<void> {
        try {
            await this.timeDataService.updateTimeData(this.topPools, this.fassetList, this.envType);
        } catch (error) {
            logger.error(`'Error running update time data:`, error);
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
        const poolRewardsPaid = (await this.externalApiService.getTotalPoolFees()) as CurrencyMap;
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
        const topPools = await this.externalApiService.getBestPerformingPools(4, "500000000000000000000000");
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
                mintingCap: "0",
                mintingCapUSD: "0",
            };
            const mintingCap = toBN(settings.mintingCapAMG).mul(toBN(settings.assetMintingGranularityUBA));
            const priceReader = await TokenPriceReader.create(settings);

            //TODO Add native token symbol to .env
            const cflrPrice = await priceReader.getPrice(infoBot.context.nativeChainInfo.tokenSymbol, false, settings.maxTrustedPriceAgeSeconds);
            const priceUSD = cflrPrice.price.mul(toBNExp(1, 18));
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
                    const poolcr = Number(info.poolCollateralRatioBIPS) / MAX_BIPS;
                    const vaultcr = Number(info.vaultCollateralRatioBIPS) / MAX_BIPS;
                    const poolExitCR = Number(info.poolExitCollateralRatioBIPS) / MAX_BIPS;
                    const feeShare = Number(info.poolFeeShareBIPS) / MAX_BIPS;
                    const mintFee = Number(info.feeBIPS) / MAX_BIPS;
                    const mintingPoolCR = Number(info.mintingPoolCollateralRatioBIPS) / MAX_BIPS;
                    const mintingVaultCR = Number(info.mintingVaultCollateralRatioBIPS) / MAX_BIPS;
                    let existingPrice = prices.find((p) => p.symbol === vaultCollateralType.tokenFtsoSymbol);
                    if (!existingPrice) {
                        const priceVault = await priceReader.getPrice(vaultCollateralType.tokenFtsoSymbol, false, settings.maxTrustedPriceAgeSeconds);
                        const priceVaultUSD = priceVault.price.mul(toBNExp(1, 18));
                        existingPrice = {
                            symbol: vaultCollateralType.tokenFtsoSymbol,
                            price: priceVaultUSD,
                            decimals: Number(priceVault.decimals),
                        };
                        prices.push(existingPrice);
                    }
                    const totalPoolCollateral = formatFixed(toBN(info.totalPoolCollateralNATWei), 18, { decimals: 3, groupDigits: true, groupSeparator: "," });
                    tvlpoolsnat = sumUsdStrings(tvlpoolsnat, totalPoolCollateral);
                    const vaultCollateral = formatFixed(toBN(info.totalVaultCollateralWei), Number(vaultCollateralType.decimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const poolOnlyCollateralUSD = calculateUSDValue(toBN(info.totalPoolCollateralNATWei), priceUSD, 18 + Number(cflrPrice.decimals), 18, 3);
                    const vaultOnlyCollateralUSD = calculateUSDValue(
                        toBN(info.totalVaultCollateralWei),
                        existingPrice.price,
                        Number(vaultCollateralType.decimals) + existingPrice.decimals,
                        18,
                        3
                    );
                    const totalCollateralUSD = sumUsdStrings(poolOnlyCollateralUSD, vaultOnlyCollateralUSD);
                    totalCollateral = sumUsdStrings(totalCollateral, totalCollateralUSD);
                    currentTVL = sumUsdStrings(currentTVL, poolOnlyCollateralUSD);
                    const poolNatBalance = toBN(await pool.totalCollateral());
                    const totalSupply = toBN(await poolToken.totalSupply());
                    const agentPoolCollateral =
                        totalSupply.toString() === "0"
                            ? toBN(0)
                            : toBN(await poolToken.balanceOf(agent))
                                  .mul(poolNatBalance)
                                  .div(totalSupply);
                    const agentPoolCollateralUSDFormatted = calculateUSDValue(toBN(agentPoolCollateral), priceUSD, 18 + Number(cflrPrice.decimals), 18, 3);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, agentPoolCollateralUSDFormatted);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, vaultOnlyCollateralUSD);
                    //Check if in liq
                    if (Number(info.status) == 2 || Number(info.status) == 3) {
                        agentsLiq++;
                    }
                    //infoBot.context.
                    //TODO change so price calculation works
                    const remainingAssets = Number(info.freeCollateralLots) * lotSize;
                    let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                    if (!existingPriceAsset) {
                        const priceAsset = await priceReader.getPrice(this.fassetSymbol.get(fasset), false, settings.maxTrustedPriceAgeSeconds);
                        existingPriceAsset = {
                            symbol: this.fassetSymbol.get(fasset),
                            price: priceAsset.price,
                            decimals: Number(priceAsset.decimals),
                        };
                        prices.push(existingPriceAsset);
                    }
                    const remainingUSDFormatted = calculateUSDValue(
                        toBN(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals))),
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
                    const mintedUSDFormatted = calculateUSDValue(
                        toBN(info.mintedUBA),
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
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

                    let existingPrice = prices.find((p) => p.symbol === vaultCollateralType.tokenFtsoSymbol);

                    if (!existingPrice) {
                        const priceVault = await priceReader.getPrice(vaultCollateralType.tokenFtsoSymbol, false, settings.maxTrustedPriceAgeSeconds);
                        const priceVaultUSD = priceVault.price.mul(toBNExp(1, 18));
                        existingPrice = {
                            symbol: vaultCollateralType.tokenFtsoSymbol,
                            price: priceVaultUSD,
                            decimals: Number(priceVault.decimals),
                        };
                        prices.push(existingPrice);
                    }
                    const poolOnlyCollateralUSD = calculateUSDValue(toBN(info.totalPoolCollateralNATWei), priceUSD, 18 + Number(cflrPrice.decimals), 18, 3);
                    const vaultOnlyCollateralUSD = calculateUSDValue(
                        toBN(info.totalVaultCollateralWei),
                        existingPrice.price,
                        Number(vaultCollateralType.decimals) + existingPrice.decimals,
                        18,
                        3
                    );
                    const totalCollateralUSD = sumUsdStrings(poolOnlyCollateralUSD, vaultOnlyCollateralUSD);
                    totalCollateral = sumUsdStrings(totalCollateral, totalCollateralUSD);
                    tvlpoolsnat = sumUsdStrings(tvlpoolsnat, totalPoolCollateral);
                    currentTVL = sumUsdStrings(currentTVL, poolOnlyCollateralUSD);
                    const poolToken = await IERC20.at(await pool.poolToken());
                    const poolNatBalance = toBN(await pool.totalCollateral());
                    const totalSupply = toBN(await poolToken.totalSupply());
                    const agentPoolCollateral =
                        totalSupply.toString() === "0"
                            ? toBN(0)
                            : toBN(await poolToken.balanceOf(agent.vaultAddress))
                                  .mul(poolNatBalance)
                                  .div(totalSupply);
                    const agentPoolCollateralUSDFormatted = calculateUSDValue(toBN(agentPoolCollateral), priceUSD, 18 + Number(cflrPrice.decimals), 18, 3);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, agentPoolCollateralUSDFormatted);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, vaultOnlyCollateralUSD);
                    //Check liq
                    if (Number(info.status) == 2 || Number(info.status) == 3) {
                        agentsLiq++;
                    }
                    const remainingAssets = Number(info.freeCollateralLots) * lotSize;
                    let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                    if (!existingPriceAsset) {
                        const priceAsset = await priceReader.getPrice(this.fassetSymbol.get(fasset), false, settings.maxTrustedPriceAgeSeconds);
                        existingPriceAsset = {
                            symbol: this.fassetSymbol.get(fasset),
                            price: priceAsset.price,
                            decimals: Number(priceAsset.decimals),
                        };
                        prices.push(existingPriceAsset);
                    }
                    const remainingUSDFormatted = calculateUSDValue(
                        toBN(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals))),
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
                    const mintedUSDFormatted = calculateUSDValue(
                        toBN(info.mintedUBA),
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
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
                const availableToMintUSDFormatted = calculateUSDValue(
                    Number(availableLotsCap) == 0 ? toBN(0) : toBN(Math.min(availableToMintUBA.toNumber(), freeLotsUBA.toNumber())),
                    existingPriceAsset.price,
                    existingPriceAsset.decimals,
                    Number(settings.assetDecimals),
                    3
                );
                supplyFa.availableToMintUSD = availableToMintUSDFormatted;
                supplyFa.allLots = mintedLots.toNumber() + Number(availableLotsCap);
                const mintingCapUSD = toBN(mintingCap)
                    .mul(existingPriceAsset.price)
                    .div(toBNExp(1, Number(existingPriceAsset.decimals)));
                supplyFa.mintingCapUSD = formatFixed(mintingCapUSD, Number(settings.assetDecimals), {
                    decimals: 3,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                supplyFa.mintingCap = formatFixed(toBN(mintingCap), Number(settings.assetDecimals), {
                    decimals: fasset.includes("XRP") ? 3 : 6,
                    groupDigits: true,
                    groupSeparator: ",",
                });
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
            const rewardsAsset = formatFixed(toBN(rewards?.value ?? "0"), Number(settings.assetDecimals), {
                decimals: fasset.includes("XRP") ? 3 : 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            const rewardsAssetUSDFormatted = calculateUSDValue(
                toBN(rewards?.value ?? "0"),
                existingPriceAsset.price,
                existingPriceAsset.decimals,
                Number(settings.assetDecimals),
                3
            );
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
                const cvTotalUSDFormatted = calculateUSDValue(
                    toBN(cvTotal),
                    existingPriceAsset.price,
                    existingPriceAsset.decimals,
                    Number(settings.assetDecimals),
                    2
                );
                this.coreVaultSupply = formatFixed(cvTotal, 6, { decimals: 2, groupDigits: true, groupSeparator: "," });
                this.coreVaultSupplyUSD = cvTotalUSDFormatted;
                const now = Math.floor(Date.now() / 1000);
                const proofOfReserveNow = await this.externalApiService.getCVratio("timestamps=" + now);
                let porRatioNow = proofOfReserveNow["FXRP"][0].value;
                if (!proofOfReserveNow["FXRP"] || porRatioNow < 1) {
                    porRatioNow = 1.003;
                }
                const porRatioBN = toBNDecimal(porRatioNow, 10);
                const totalReserve = faSupply.mul(porRatioBN).div(toBN("10000000000"));
                const reserveUSDFormatted = calculateUSDValue(
                    totalReserve,
                    existingPriceAsset.price,
                    existingPriceAsset.decimals,
                    Number(settings.assetDecimals),
                    2
                );
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
                // Special check if indexer returns filtered agent or if we already processed 3 top pools.
                if (agent.vaultAddress.toLowerCase() === FILTER_AGENT || bestPools.length == 3) {
                    continue;
                }
                const claimedUSDFormatted = calculateUSDValue(
                    toBN(tp.claimed),
                    existingPriceAsset.price,
                    existingPriceAsset.decimals,
                    Number(settings.assetDecimals),
                    3
                );
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
        if (!data) {
            return getDefaultTimeData(this.fassetList[0]);
        }
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
