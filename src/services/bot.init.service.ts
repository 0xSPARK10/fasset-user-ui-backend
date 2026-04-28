/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { join } from "path";
import { Pool } from "../entities/Pool";
import * as cron from "node-cron";
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
    PriceBigInt,
    SupplyFasset,
    SupplyTotalCollateral,
    TimeData,
    TopPoolData,
    ProofOfReserve,
} from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { Collateral } from "src/entities/Collaterals";
import {
    calculateOvercollateralizationPercentage,
    calculateUSDValueBigInt,
    formatFixedBigInt,
    bigintPow10,
    getDefaultTimeData,
    sumUsdStrings,
    toBNDecimalBigInt,
} from "src/utils/utils";
import { ExternalApiService } from "./external.api.service";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { TimeDataService } from "./time.data.service";
import { ContractService } from "./contract.service";
import { FassetConfigService } from "./fasset.config.service";
import type { IIAssetManager, IFAsset, IPriceReader, ICollateralPool, IAgentOwnerRegistry } from "../typechain-ethers-v6";
import { IPriceReader__factory, ICollateralPool__factory, ICollateralPoolToken__factory, IAgentOwnerRegistry__factory } from "../typechain-ethers-v6";
import { EthersService } from "./ethers.service";

/** VAULT collateral class constant (matches CollateralClass.VAULT from fasset-bots-core) */
const COLLATERAL_CLASS_VAULT = 2;

/** 10_000 BIPS = 100 % */
const MAX_BIPS = 10_000;

@Injectable()
export class BotService implements OnModuleInit {
    /** Maps fasset name → IIAssetManager contract instance */
    private assetManagerMap: Map<string, IIAssetManager> = new Map();
    /** Maps fasset name → IFAsset contract instance */
    private fAssetMap: Map<string, IFAsset> = new Map();
    /** Maps fasset name → IAgentOwnerRegistry contract instance */
    private agentOwnerRegistryMap: Map<string, IAgentOwnerRegistry> = new Map();
    /** Maps fasset name → IPriceReader contract obtained from settings.priceReader */
    private priceReaderMap: Map<string, IPriceReader> = new Map();
    private isRunning: boolean = false;
    private isRunningRedQueue: boolean = false;
    private isRunningTimeData: boolean = false;
    private costonBotPath: string;
    private fassetSymbol: Map<string, string> = new Map();
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
        private readonly configService: ConfigService,
        private readonly externalApiService: ExternalApiService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly timeDataService: TimeDataService,
        private readonly contractService: ContractService,
        private readonly fassetConfigService: FassetConfigService,
        private readonly ethersService: EthersService
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
        const filePathConfig = join(__dirname, "../..", "src", pathForConfig);

        const configFileContent = readFileSync(filePathConfig, "utf-8");
        const config = JSON.parse(configFileContent);
        const fassets = Object.keys(config.fAssets);
        this.ecosystemTVL = "0";

        const provider = this.ethersService.getProvider();

        for (const fasset of fassets) {
            logger.info(`Initializing BotService for fasset ${fasset}`);
            this.fassetList.push(fasset);

            // Get AssetManager contract from ContractService
            const assetManager = this.contractService.get<IIAssetManager>(`AssetManager_${fasset}`);
            this.assetManagerMap.set(fasset, assetManager);

            // Get FAsset contract from ContractService (name matches fasset name directly in deployments)
            const fAsset = this.contractService.get<IFAsset>(fasset);
            this.fAssetMap.set(fasset, fAsset);
            const settings = await assetManager.getSettings();

            // Build the asset manager address
            const amAddress = typeof assetManager.target === "string" ? assetManager.target : await assetManager.getAddress();
            this.assetManagerList.push({
                fasset: fasset,
                assetManager: amAddress,
                decimals: Number(settings.assetDecimals),
            });
            this.assetManagerAddressList.push(amAddress);

            // Store fasset decimals from the fAsset contract
            const fAssetDecimals = await fAsset.decimals();
            this.fassetDecimals.push({ fasset: fasset, decimals: Number(fAssetDecimals) });

            // Store fasset symbol from the fAsset contract
            this.fassetSymbol.set(fasset, await fAsset.assetSymbol());

            // Create PriceReader from settings.priceReader address
            const priceReader = IPriceReader__factory.connect(settings.priceReader as string, provider);
            this.priceReaderMap.set(fasset, priceReader);

            // Create AgentOwnerRegistry from settings.agentOwnerRegistry address
            const agentOwnerRegistry = IAgentOwnerRegistry__factory.connect(settings.agentOwnerRegistry as string, provider);
            this.agentOwnerRegistryMap.set(fasset, agentOwnerRegistry);

            // Collect collateral token FTSO symbols
            const collateralTypes = await assetManager.getCollateralTypes();
            for (const c of collateralTypes) {
                if (Number(c.collateralClass) != COLLATERAL_CLASS_VAULT) {
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

    /**
     * Fetches all agent vault addresses from the asset manager using pagination.
     * Equivalent to the old InfoBotCommands.getAllAgents().
     */
    private async getAllAgentAddresses(assetManager: IIAssetManager, chunkSize = 10): Promise<string[]> {
        const result: string[] = [];
        let start = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const [list] = await assetManager.getAllAgents(start, start + chunkSize);
            result.splice(result.length, 0, ...list);
            if (list.length < chunkSize) break;
            start += list.length;
        }
        return result;
    }

    /**
     * Get a price from the PriceReader contract. Returns { price, decimals }.
     * The price is already in its native precision (not scaled by 1e18 like the old code does for USD).
     */
    private async getPrice(priceReader: IPriceReader, symbol: string): Promise<{ price: bigint; decimals: number }> {
        const [_price, , _priceDecimals] = await priceReader.getPrice(symbol);
        return { price: _price, decimals: Number(_priceDecimals) };
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

        const nativeSymbol = this.fassetConfigService.getNativeSymbol();
        const provider = this.ethersService.getProvider();

        for (const fasset of this.fassetList) {
            const assetManager = this.assetManagerMap.get(fasset);
            const fAssetContract = this.fAssetMap.get(fasset);
            const priceReader = this.priceReaderMap.get(fasset);
            const agentOwnerRegistry = this.agentOwnerRegistryMap.get(fasset);

            let mintedUBA = 0n;
            //TODO: make it in parallel (when mysql db)
            const start = Date.now();
            const [agents, settings, collaterals] = await Promise.all([
                this.getAllAgentAddresses(assetManager),
                assetManager.getSettings(),
                assetManager.getCollateralTypes(),
            ]);
            //console.log(collaterals);
            logger.info(`Updating ${agents.length} pools for fasset ${fasset} ...`);
            let mintedReservedUBA = 0n;

            const lotSizeUBA = settings.lotSizeAMG * settings.assetMintingGranularityUBA;
            const lotSize = Number(settings.lotSizeAMG * settings.assetMintingGranularityUBA) / 10 ** Number(settings.assetDecimals);
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
            const mintingCap = settings.mintingCapAMG * settings.assetMintingGranularityUBA;

            //TODO Add native token symbol to .env
            const cflrPriceData = await this.getPrice(priceReader, nativeSymbol);
            const priceUSD = cflrPriceData.price * bigintPow10(18);
            const prices: PriceBigInt[] = [
                {
                    symbol: nativeSymbol,
                    price: priceUSD,
                    decimals: cflrPriceData.decimals,
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
            const newAgentInfoPromises = newAgents.map((agent) => assetManager.getAgentInfo(agent));
            const newAgentInfos = await Promise.all(newAgentInfoPromises);
            // map
            const newAgentInfoMap = new Map(newAgents.map((agent, index) => [agent, newAgentInfos[index]]));
            // prefetch additional agent data
            const newAgentAdditionalInfoPromises = newAgents.map((agent) => {
                const info = newAgentInfoMap.get(agent);
                const poolContract = ICollateralPool__factory.connect(info.collateralPool as string, provider);
                return Promise.all([
                    agentOwnerRegistry.getAgentName(info.ownerManagementAddress),
                    agentOwnerRegistry.getAgentIconUrl(info.ownerManagementAddress),
                    poolContract,
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
                    assetManager.getCollateralType(COLLATERAL_CLASS_VAULT, info.vaultCollateralToken),
                    agentOwnerRegistry.getAgentDescription(info.ownerManagementAddress),
                    agentOwnerRegistry.getAgentTermsOfUseUrl(info.ownerManagementAddress),
                ]);
            });
            const newAgentAdditionalInfos = await Promise.all(newAgentAdditionalInfoPromises);
            for (let i = 0; i < newAgents.length; i++) {
                try {
                    const agent = newAgents[i];
                    const info = newAgentInfoMap.get(agent);
                    const [agentName, url, pool, mintCount, numLiquidations, redeemRate, vaultCollateralType, description, infoUrl] =
                        newAgentAdditionalInfos[i];

                    const poolTokenAddress = await (pool as ICollateralPool).poolToken();
                    const poolToken = ICollateralPoolToken__factory.connect(poolTokenAddress, provider);
                    const poolcr = Number(info.poolCollateralRatioBIPS) / MAX_BIPS;
                    const vaultcr = Number(info.vaultCollateralRatioBIPS) / MAX_BIPS;
                    const poolExitCR = Number(info.poolExitCollateralRatioBIPS) / MAX_BIPS;
                    const feeShare = Number(info.poolFeeShareBIPS) / MAX_BIPS;
                    const mintFee = Number(info.feeBIPS) / MAX_BIPS;
                    const mintingPoolCR = Number(info.mintingPoolCollateralRatioBIPS) / MAX_BIPS;
                    const mintingVaultCR = Number(info.mintingVaultCollateralRatioBIPS) / MAX_BIPS;
                    let existingPrice = prices.find((p) => p.symbol === vaultCollateralType.tokenFtsoSymbol);
                    if (!existingPrice) {
                        const priceVault = await this.getPrice(priceReader, vaultCollateralType.tokenFtsoSymbol);
                        const priceVaultUSD = priceVault.price * bigintPow10(18);
                        existingPrice = {
                            symbol: vaultCollateralType.tokenFtsoSymbol,
                            price: priceVaultUSD,
                            decimals: priceVault.decimals,
                        };
                        prices.push(existingPrice);
                    }
                    const totalPoolCollateral = formatFixedBigInt(info.totalPoolCollateralNATWei, 18, { decimals: 3, groupDigits: true, groupSeparator: "," });
                    tvlpoolsnat = sumUsdStrings(tvlpoolsnat, totalPoolCollateral);
                    const vaultCollateral = formatFixedBigInt(info.totalVaultCollateralWei, Number(vaultCollateralType.decimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const poolOnlyCollateralUSD = calculateUSDValueBigInt(info.totalPoolCollateralNATWei, priceUSD, 18 + cflrPriceData.decimals, 18, 3);
                    const vaultOnlyCollateralUSD = calculateUSDValueBigInt(
                        info.totalVaultCollateralWei,
                        existingPrice.price,
                        Number(vaultCollateralType.decimals) + existingPrice.decimals,
                        18,
                        3
                    );
                    const totalCollateralUSD = sumUsdStrings(poolOnlyCollateralUSD, vaultOnlyCollateralUSD);
                    totalCollateral = sumUsdStrings(totalCollateral, totalCollateralUSD);
                    currentTVL = sumUsdStrings(currentTVL, poolOnlyCollateralUSD);
                    const poolNatBalance = await (pool as ICollateralPool).totalCollateral();
                    const totalSupply = await poolToken.totalSupply();
                    const agentPoolCollateralVal = totalSupply === 0n ? 0n : ((await poolToken.balanceOf(agent)) * poolNatBalance) / totalSupply;
                    const agentPoolCollateralUSDFormatted = calculateUSDValueBigInt(agentPoolCollateralVal, priceUSD, 18 + cflrPriceData.decimals, 18, 3);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, agentPoolCollateralUSDFormatted);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, vaultOnlyCollateralUSD);
                    //Check if in liq
                    if (Number(info.status) == 2 || Number(info.status) == 3) {
                        agentsLiq++;
                    }
                    //TODO change so price calculation works
                    const remainingAssets = Number(info.freeCollateralLots) * lotSize;
                    let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                    if (!existingPriceAsset) {
                        const priceAsset = await this.getPrice(priceReader, this.fassetSymbol.get(fasset));
                        existingPriceAsset = {
                            symbol: this.fassetSymbol.get(fasset),
                            price: priceAsset.price,
                            decimals: priceAsset.decimals,
                        };
                        prices.push(existingPriceAsset);
                    }
                    const remainingUSDFormatted = calculateUSDValueBigInt(
                        BigInt(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals))),
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
                    const mintedUSDFormatted = calculateUSDValueBigInt(
                        info.mintedUBA,
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
                    mintedAll = sumUsdStrings(mintedAll, mintedUSDFormatted);
                    const mintedReservedLots = (info.mintedUBA + info.reservedUBA) / lotSizeUBA;
                    const mintedAssets = formatFixedBigInt(info.mintedUBA, Number(settings.assetDecimals), {
                        decimals: fasset.includes("XRP") ? 3 : 8,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    mintedReservedUBA = mintedReservedUBA + info.mintedUBA + info.reservedUBA;
                    mintedUBA = mintedUBA + info.mintedUBA;
                    //supplyFa.minted = sumUsdStrings(supplyFa.minted, mintedUSDFormatted);
                    const allLots = Number(mintedReservedLots) + Number(info.freeCollateralLots);
                    if (mintingCap === 0n) {
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
                    const existingCollateralNative = supplyCollateral.find((asset) => asset.symbol === nativeSymbol);
                    if (existingCollateralNative) {
                        existingCollateralNative.supply = sumUsdStrings(existingCollateralNative.supply, totalPoolCollateral);
                        existingCollateralNative.supplyUSD = sumUsdStrings(existingCollateralNative.supplyUSD, poolOnlyCollateralUSD);
                    } else {
                        supplyCollateral.push({
                            symbol: nativeSymbol,
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
                        info.collateralPool as string,
                        poolTokenAddress,
                        agentName,
                        fasset,
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
                        info.vaultCollateralToken as string,
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
            const agentsToUpdateInfoPromises = agentsToUpdate.map((agent) => assetManager.getAgentInfo(agent.vaultAddress));
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
                    assetManager.getCollateralType(COLLATERAL_CLASS_VAULT, info.vaultCollateralToken),
                    agentOwnerRegistry.getAgentName(info.ownerManagementAddress),
                    agentOwnerRegistry.getAgentIconUrl(info.ownerManagementAddress),
                    agentOwnerRegistry.getAgentTermsOfUseUrl(info.ownerManagementAddress),
                    agentOwnerRegistry.getAgentDescription(info.ownerManagementAddress),
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
                    const pool = ICollateralPool__factory.connect(agent.poolAddress, provider);
                    const poolcr = Number(info.poolCollateralRatioBIPS) / MAX_BIPS;
                    const vaultcr = Number(info.vaultCollateralRatioBIPS) / MAX_BIPS;
                    const poolExitCR = Number(info.poolExitCollateralRatioBIPS) / MAX_BIPS;
                    const totalPoolCollateral = formatFixedBigInt(info.totalPoolCollateralNATWei, 18, { decimals: 3, groupDigits: true, groupSeparator: "," });
                    const vaultCollateral = formatFixedBigInt(info.totalVaultCollateralWei, agent.vaultCollateralTokenDecimals, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const mintingPoolCR = Number(info.mintingPoolCollateralRatioBIPS) / MAX_BIPS;
                    const mintingVaultCR = Number(info.mintingVaultCollateralRatioBIPS) / MAX_BIPS;

                    let existingPrice = prices.find((p) => p.symbol === vaultCollateralType.tokenFtsoSymbol);

                    if (!existingPrice) {
                        const priceVault = await this.getPrice(priceReader, vaultCollateralType.tokenFtsoSymbol);
                        const priceVaultUSD = priceVault.price * bigintPow10(18);
                        existingPrice = {
                            symbol: vaultCollateralType.tokenFtsoSymbol,
                            price: priceVaultUSD,
                            decimals: priceVault.decimals,
                        };
                        prices.push(existingPrice);
                    }
                    const poolOnlyCollateralUSD = calculateUSDValueBigInt(info.totalPoolCollateralNATWei, priceUSD, 18 + cflrPriceData.decimals, 18, 3);
                    const vaultOnlyCollateralUSD = calculateUSDValueBigInt(
                        info.totalVaultCollateralWei,
                        existingPrice.price,
                        Number(vaultCollateralType.decimals) + existingPrice.decimals,
                        18,
                        3
                    );
                    const totalCollateralUSD = sumUsdStrings(poolOnlyCollateralUSD, vaultOnlyCollateralUSD);
                    totalCollateral = sumUsdStrings(totalCollateral, totalCollateralUSD);
                    tvlpoolsnat = sumUsdStrings(tvlpoolsnat, totalPoolCollateral);
                    currentTVL = sumUsdStrings(currentTVL, poolOnlyCollateralUSD);
                    const poolTokenAddress = await pool.poolToken();
                    const poolToken = ICollateralPoolToken__factory.connect(poolTokenAddress, provider);
                    const poolNatBalance = await pool.totalCollateral();
                    const totalSupply = await poolToken.totalSupply();
                    const agentPoolCollateralVal = totalSupply === 0n ? 0n : ((await poolToken.balanceOf(agent.vaultAddress)) * poolNatBalance) / totalSupply;
                    const agentPoolCollateralUSDFormatted = calculateUSDValueBigInt(agentPoolCollateralVal, priceUSD, 18 + cflrPriceData.decimals, 18, 3);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, agentPoolCollateralUSDFormatted);
                    agentPoolCollateralOnly = sumUsdStrings(agentPoolCollateralOnly, vaultOnlyCollateralUSD);
                    //Check liq
                    if (Number(info.status) == 2 || Number(info.status) == 3) {
                        agentsLiq++;
                    }
                    const remainingAssets = Number(info.freeCollateralLots) * lotSize;
                    let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                    if (!existingPriceAsset) {
                        const priceAsset = await this.getPrice(priceReader, this.fassetSymbol.get(fasset));
                        existingPriceAsset = {
                            symbol: this.fassetSymbol.get(fasset),
                            price: priceAsset.price,
                            decimals: priceAsset.decimals,
                        };
                        prices.push(existingPriceAsset);
                    }
                    const remainingUSDFormatted = calculateUSDValueBigInt(
                        BigInt(Math.floor(remainingAssets * 10 ** Number(settings.assetDecimals))),
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
                    const mintedUSDFormatted = calculateUSDValueBigInt(
                        info.mintedUBA,
                        existingPriceAsset.price,
                        existingPriceAsset.decimals,
                        Number(settings.assetDecimals),
                        3
                    );
                    mintedAll = sumUsdStrings(mintedAll, mintedUSDFormatted);
                    const mintedReservedLots = (info.mintedUBA + info.reservedUBA) / lotSizeUBA;
                    const mintedAssets = formatFixedBigInt(info.mintedUBA, Number(settings.assetDecimals), {
                        decimals: fasset.includes("XRP") ? 3 : 8,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    //supplyFa.supply = sumUsdStrings(supplyFa.supply, mintedAssets);
                    mintedReservedUBA = mintedReservedUBA + info.mintedUBA + info.reservedUBA;
                    mintedUBA = mintedUBA + info.mintedUBA;
                    //supplyFa.minted = sumUsdStrings(supplyFa.minted, mintedUSDFormatted);
                    const allLots = Number(mintedReservedLots) + Number(info.freeCollateralLots);
                    if (mintingCap === 0n) {
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
                    const existingCollateralNative = supplyCollateral.find((asset) => asset.symbol === nativeSymbol);
                    if (existingCollateralNative) {
                        existingCollateralNative.supply = sumUsdStrings(existingCollateralNative.supply, totalPoolCollateral);
                        existingCollateralNative.supplyUSD = sumUsdStrings(existingCollateralNative.supplyUSD, poolOnlyCollateralUSD);
                    } else {
                        supplyCollateral.push({
                            symbol: nativeSymbol,
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
                    agent.vaultToken = info.vaultCollateralToken as string;
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
            const faSupply = await fAssetContract.totalSupply();
            const mintedLots = faSupply / lotSizeUBA;
            supplyFa.mintedLots = Number(mintedLots);
            if (mintingCap !== 0n) {
                const availableToMintUBA = mintingCap - faSupply;
                const freeLotsUBA = BigInt(supplyFa.availableToMintLots) * lotSizeUBA;
                const availableLotsCap =
                    Number(availableToMintUBA / lotSizeUBA) < supplyFa.availableToMintLots
                        ? Number(availableToMintUBA / lotSizeUBA)
                        : supplyFa.availableToMintLots;
                supplyFa.availableToMintLots = Number(availableLotsCap);
                let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                if (!existingPriceAsset) {
                    const priceAsset = await this.getPrice(priceReader, this.fassetSymbol.get(fasset));
                    prices.push({
                        symbol: this.fassetSymbol.get(fasset),
                        price: priceAsset.price,
                        decimals: priceAsset.decimals,
                    });
                    existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
                }
                const minUBA = availableToMintUBA < freeLotsUBA ? availableToMintUBA : freeLotsUBA;
                const availableToMintUSDFormatted = calculateUSDValueBigInt(
                    Number(availableLotsCap) == 0 ? 0n : minUBA,
                    existingPriceAsset.price,
                    existingPriceAsset.decimals,
                    Number(settings.assetDecimals),
                    3
                );
                supplyFa.availableToMintUSD = availableToMintUSDFormatted;
                supplyFa.allLots = Number(mintedLots) + Number(availableLotsCap);
                const mintingCapUSD = (mintingCap * existingPriceAsset.price) / bigintPow10(existingPriceAsset.decimals);
                supplyFa.mintingCapUSD = formatFixedBigInt(mintingCapUSD, Number(settings.assetDecimals), {
                    decimals: 3,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                supplyFa.mintingCap = formatFixedBigInt(mintingCap, Number(settings.assetDecimals), {
                    decimals: fasset.includes("XRP") ? 3 : 6,
                    groupDigits: true,
                    groupSeparator: ",",
                });
            } else {
                supplyFa.allLots = supplyFa.availableToMintLots + supplyFa.mintedLots;
            }
            let existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
            if (!existingPriceAsset) {
                const priceAsset = await this.getPrice(priceReader, this.fassetSymbol.get(fasset));
                prices.push({
                    symbol: this.fassetSymbol.get(fasset),
                    price: priceAsset.price,
                    decimals: priceAsset.decimals,
                });
                existingPriceAsset = prices.find((p) => p.symbol === this.fassetSymbol.get(fasset));
            }
            const faSupplyUSD = (faSupply * existingPriceAsset.price) / bigintPow10(existingPriceAsset.decimals);
            supplyFa.minted = formatFixedBigInt(faSupplyUSD, Number(settings.assetDecimals), {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            });
            if ((await this.em.count(Pool, { fasset })) == 0) {
                //calculate price of fees
                rewardsAvailableUSD = sumUsdStrings(rewardsAvailableUSD, "0");
                logger.info(`Pools for fasset ${fasset} updated in: ${(Date.now() - start) / 1000}`);
                supplyFa.supply = formatFixedBigInt(faSupply, Number(settings.assetDecimals), {
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
            supplyFa.supply = formatFixedBigInt(faSupply, Number(settings.assetDecimals), {
                decimals: fasset.includes("XRP") ? 3 : 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            if (supplyFa.allLots == 0) {
                supplyFa.mintedPercentage = "0.00";
                supplyFa.availableToMintAsset = "0";
            } else {
                if (await assetManager.mintingPaused()) {
                    supplyFa.mintedPercentage = ((supplyFa.availableToMintLots / supplyFa.allLots) * 100).toFixed(2);
                    supplyFa.availableToMintAsset = "0";
                    supplyFa.availableToMintLots = 0;
                    supplyFa.availableToMintUSD = "0";
                } else {
                    supplyFa.mintedPercentage = ((supplyFa.availableToMintLots / supplyFa.allLots) * 100).toFixed(2);
                    const availableToMintUBACalc = BigInt(supplyFa.availableToMintLots) * lotSizeUBA;
                    supplyFa.availableToMintAsset = formatFixedBigInt(availableToMintUBACalc, Number(settings.assetDecimals), {
                        decimals: fasset.includes("XRP") ? 3 : 6,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                }
            }
            supplyFasset.push(supplyFa);
            const fa = NETWORK_SYMBOLS.find((fa) => (this.envType == "dev" ? fa.test : fa.real) === fasset);
            const rewards = poolRewardsPaid[fa.real];
            const rewardsAsset = formatFixedBigInt(BigInt(rewards?.value ?? "0"), Number(settings.assetDecimals), {
                decimals: fasset.includes("XRP") ? 3 : 6,
                groupDigits: true,
                groupSeparator: ",",
            });
            const rewardsAssetUSDFormatted = calculateUSDValueBigInt(
                BigInt(rewards?.value ?? "0"),
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
                const inflowsBig = BigInt(coreVaultInflows);
                const outflowsBig = BigInt(coreVaultOutflows);
                const inflowsUSD = (inflowsBig * existingPriceAsset.price) / bigintPow10(existingPriceAsset.decimals);
                const outflowsUSD = (outflowsBig * existingPriceAsset.price) / bigintPow10(existingPriceAsset.decimals);
                this.coreVaultInflows = formatFixedBigInt(inflowsBig, 6, {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                this.coreVaultInflowsUSD = formatFixedBigInt(inflowsUSD, Number(settings.assetDecimals), {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                this.coreVaultOutflows = formatFixedBigInt(outflowsBig, 6, {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                this.coreVaultOutflowsUSD = formatFixedBigInt(outflowsUSD, Number(settings.assetDecimals), {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                });
                const cvTotal = inflowsBig - outflowsBig;
                const cvTotalUSDFormatted = calculateUSDValueBigInt(
                    cvTotal,
                    existingPriceAsset.price,
                    existingPriceAsset.decimals,
                    Number(settings.assetDecimals),
                    2
                );
                this.coreVaultSupply = formatFixedBigInt(cvTotal, 6, { decimals: 2, groupDigits: true, groupSeparator: "," });
                this.coreVaultSupplyUSD = cvTotalUSDFormatted;
                const now = Math.floor(Date.now() / 1000);
                const proofOfReserveNow = await this.externalApiService.getCVratio("timestamps=" + now);
                let porRatioNow = proofOfReserveNow["FXRP"] ? proofOfReserveNow["FXRP"][0].value : 1.003;
                if (!proofOfReserveNow["FXRP"] || porRatioNow < 1) {
                    porRatioNow = 1.003;
                }
                const porRatioBN = toBNDecimalBigInt(porRatioNow, 10);
                const totalReserve = (faSupply * porRatioBN) / 10000000000n;
                const reserveUSDFormatted = calculateUSDValueBigInt(
                    totalReserve,
                    existingPriceAsset.price,
                    existingPriceAsset.decimals,
                    Number(settings.assetDecimals),
                    2
                );
                const ratio = faSupply === 0n ? bigintPow10(10) : ((totalReserve * bigintPow10(10)) / faSupply) * 100n;
                let ratioCalc = Number(ratio) / 1e10;
                if (ratioCalc < 100) {
                    ratioCalc = 100;
                }

                const ratioFormatted = ratioCalc.toFixed(2);
                const proofOfReserve: ProofOfReserve = {
                    total: supplyFa.supply,
                    totalUSD: supplyFa.minted,
                    reserve: formatFixedBigInt(totalReserve, 6, { decimals: 2, groupDigits: true, groupSeparator: "," }),
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
                const claimedUSDFormatted = calculateUSDValueBigInt(
                    BigInt(tp.claimed),
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

    /**
     * Reads the on-chain redemption queue and caches both lot counts and raw UBA amounts.
     * The UBA amounts let the frontend display amounts instead of lots.
     */
    async updateRedemptionQueue(fasset: string): Promise<void> {
        const assetManager = this.assetManagerMap.get(fasset);
        const settings = await assetManager.getSettings();
        const maxTickets = Number(settings.maxRedeemedTickets);
        const lotSizeUBA = settings.lotSizeAMG * settings.assetMintingGranularityUBA;
        let maxSingleRedemtionTotal = 0n;
        let maxShortTermRedemptionTotal = 0n;
        let redemptionQueue = await assetManager.redemptionQueue(0, maxTickets);
        if (redemptionQueue[0].length == 0) {
            await this.cacheManager.set(fasset + "maxLotsSingleRedeem", 0, 0);
            await this.cacheManager.set(fasset + "maxLotsTotalRedeem", 0, 0);
            await this.cacheManager.set(fasset + "maxAmountSingleRedeem", "0", 0);
            await this.cacheManager.set(fasset + "maxAmountTotalRedeem", "0", 0);
            return;
        }
        maxSingleRedemtionTotal = redemptionQueue[0].reduce((acc, num) => acc + num.ticketValueUBA, 0n);
        maxShortTermRedemptionTotal = maxSingleRedemtionTotal;
        while (redemptionQueue[1] !== 0n) {
            redemptionQueue = await assetManager.redemptionQueue(redemptionQueue[1], 20);
            maxShortTermRedemptionTotal = maxShortTermRedemptionTotal + redemptionQueue[0].reduce((acc, num) => acc + num.ticketValueUBA, 0n);
        }
        const maxSingleLotsToRedeem = maxSingleRedemtionTotal / lotSizeUBA;
        const maxShortTermLotsTotal = maxShortTermRedemptionTotal / lotSizeUBA;
        // Cache lot-based values as Number (BigInt cannot be JSON-serialized by cache)
        await this.cacheManager.set(fasset + "maxLotsSingleRedeem", Number(maxSingleLotsToRedeem), 0);
        await this.cacheManager.set(fasset + "maxLotsTotalRedeem", Number(maxShortTermLotsTotal), 0);
        // Cache raw UBA amounts for amount-based redemption
        await this.cacheManager.set(fasset + "maxAmountSingleRedeem", maxSingleRedemtionTotal.toString(), 0);
        await this.cacheManager.set(fasset + "maxAmountTotalRedeem", maxShortTermRedemptionTotal.toString(), 0);
    }
}
