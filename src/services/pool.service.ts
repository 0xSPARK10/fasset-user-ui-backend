/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { AgentPoolItem, AgentPoolLatest, CostonExpTokenBalance, IndexerTokenBalances } from "../interfaces/requestResponse";
import { AssetManagerSettings, CollateralClass } from "@flarelabs/fasset-bots-core";
import { BN_ZERO, formatFixed, toBN, toBNExp, artifacts } from "@flarelabs/fasset-bots-core/utils";
import { BotService } from "./bot.init.service";
import { EntityManager } from "@mikro-orm/core";
import { Pool } from "../entities/Pool";
import { Liveness } from "../entities/AgentLiveness";
import { CollateralPrice } from "@flarelabs/fasset-bots-core";
import { TokenPriceReader } from "@flarelabs/fasset-bots-core";
import { formatBNToDisplayDecimals } from "src/utils/utils";
import { logger } from "src/logger/winston.logger";
import { Collateral } from "src/entities/Collaterals";
import { ExternalApiService } from "./external.api.service";
import { lastValueFrom } from "rxjs";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";

const NUM_RETRIES = 3;
const IERC20 = artifacts.require("IERC20Metadata");
const CollateralPool = artifacts.require("CollateralPool");
const CollateraPoolToken = artifacts.require("CollateralPoolToken");

@Injectable()
export class PoolService {
    private costonExplorerUrl: string;
    constructor(
        private readonly botService: BotService,
        private readonly externalApiService: ExternalApiService,
        private readonly em: EntityManager,
        private readonly httpService: HttpService,
        private readonly configService: ConfigService
    ) {
        this.costonExplorerUrl = this.configService.get<string>("COSTON_EXPLORER_URL");
    }

    async getTokenBalanceFromIndexer(userAddress: string): Promise<IndexerTokenBalances[]> {
        const data = await this.externalApiService.getUserCollateralPoolTokens(userAddress);
        return data;
    }

    /*async getTokenBalanceFromExplorer(userAddress: string): Promise<CostonExpTokenBalance[]> {
        const data = await lastValueFrom(this.httpService.get(this.costonExplorerUrl + "?module=account&action=tokenlist&address=" + userAddress));
        return data.data.result;
    }*/

    async getAgentLiveness(address: string, now: number): Promise<any> {
        const agentLiveness = await this.em.findOne(Liveness, {
            vaultAddress: address,
        });
        let status = true;
        if (agentLiveness == null) {
            status = false;
        } else {
            if (now - agentLiveness.lastTimestamp > 2 * 60 * 60 * 1000) {
                status = false;
            }
            /*if (agentLiveness.lastPinged == 0) {
            status = true;
          }*/
            /* if (agentLiveness.lastPinged != 0 && agentLiveness.lastTimestamp == 0) {
            status = false;
          }*/
        }
        return status;
    }

    async getPoolCollateralPrice(fasset: string, settings: AssetManagerSettings): Promise<CollateralPrice> {
        const bot = this.botService.getInfoBot(fasset);
        const [priceReader, poolCollateral] = await Promise.all([
            TokenPriceReader.create(settings),
            bot.context.assetManager.getCollateralType(CollateralClass.POOL, await bot.context.assetManager.getWNat()),
        ]);
        return await CollateralPrice.forCollateral(priceReader, settings, poolCollateral);
    }

    //TODO: add verification return
    async getPools(fassets: string[], address: string): Promise<AgentPoolItem[]> {
        if (address === "undefined") {
            return;
        }
        if (this.configService.get<string>("NETWORK") == "songbird") {
            if (this.botService.getInfoBot("FDOGE")) {
                fassets.push("FDOGE");
            }
        }
        //const a = await web3.utils.toChecksumAddress(address);

        // Indexer info map
        const cptokenBalances = await this.getTokenBalanceFromIndexer(address);
        //const contractInfoMap = new Map<string, IndexerTokenBalances>(cptokenBalances.map((info) => [info.token, info]));

        //const allTokens = await this.getTokenBalanceFromExplorer(address);
        //const filteredTokens = allTokens.filter((token) => token.name.startsWith("FAsset Collateral Pool Token"));
        //const contractInfoMap = new Map<string, CostonExpTokenBalance>(filteredTokens.map((info) => [info.contractAddress.toLowerCase(), info]));
        for (let i = 0; i < NUM_RETRIES; i++) {
            try {
                const pools = [];
                const now = Date.now();
                for (const fasset of fassets) {
                    const agents = await this.em.find(Pool, { fasset });

                    // prefetch
                    const livenessPromises = agents.map((agent) => this.getAgentLiveness(agent.vaultAddress, now));
                    const livenessData = await Promise.all(livenessPromises);

                    // calc userPoolNatBalance in USD
                    const bot = this.botService.getInfoBot(fasset);
                    const settings = await bot.context.assetManager.getSettings();
                    const price = await this.getPoolCollateralPrice(fasset, settings);
                    const priceReader = await TokenPriceReader.create(settings);
                    const priceAsset = await priceReader.getPrice(this.botService.getAssetSymbol(fasset), false, settings.maxTrustedPriceAgeSeconds);

                    for (let i = 0; i < agents.length; i++) {
                        const agent = agents[i];
                        try {
                            const status = livenessData[i];
                            const info = cptokenBalances[agent.tokenAddress];
                            //const info = contractInfoMap.get(agent.tokenAddress.toLowerCase());
                            if (!info && !agent.publiclyAvailable) {
                                continue;
                            }
                            const vaultCollaterals = await this.em.find(Collateral, {
                                fasset: fasset,
                                token: agent.vaultToken,
                            });
                            const poolCollaterals = await this.em.find(Collateral, {
                                fasset: fasset,
                                tokenFtsoSymbol: bot.context.nativeChainInfo.tokenSymbol,
                            });
                            const vaultCollateral = vaultCollaterals[0];
                            const poolCollateral = poolCollaterals[0];
                            if (!info) {
                                if (agent.status >= 2) {
                                    continue;
                                }
                                const agentPool = {
                                    vault: agent.vaultAddress,
                                    pool: agent.poolAddress,
                                    totalPoolCollateral: agent.totalPoolCollateral,
                                    poolCR: Number(agent.poolCR).toFixed(2),
                                    vaultCR: Number(agent.vaultCR).toFixed(2),
                                    userPoolBalance: "0",
                                    userPoolFees: "0",
                                    feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                                    userPoolNatBalance: "0",
                                    userPoolNatBalanceInUSD: "0",
                                    agentName: agent.agentName,
                                    vaultType: agent.vaultType,
                                    poolExitCR: Number(agent.poolExitCR).toFixed(2),
                                    status: status,
                                    userPoolShare: "0",
                                    health: agent.status,
                                    freeLots: agent.freeLots,
                                    mintCount: agent.mintNumber,
                                    numLiquidations: agent.numLiquidations,
                                    redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                                    url: agent.url,
                                    poolCollateralUSD: agent.poolNatUsd,
                                    vaultCollateral: agent.vaultCollateral,
                                    collateralToken: agent.vaultCollateralToken === "USDT" ? "USDT0" : agent.vaultCollateralToken,
                                    transferableTokens: "0",
                                    tokenAddress: agent.tokenAddress,
                                    fassetDebt: "0",
                                    nonTimeLocked: "0",
                                    mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                                    mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                                    vaultCCBCR: Number(1).toFixed(2),
                                    vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                                    vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    poolCCBCR: Number(1).toFixed(2),
                                    poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                                    poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                                    description: agent.description,
                                    mintedAssets: agent.mintedUBA,
                                    mintedUSD: agent.mintedUSD,
                                    remainingAssets: agent.remainingUBA,
                                    remainingUSD: agent.remainingUSD,
                                    allLots: agent.allLots,
                                    poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                                    vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                                    userPoolFeesUSD: "0",
                                    totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                                    limitUSD: agent.limitUSD,
                                    infoUrl: agent.infoUrl,
                                    lifetimeClaimedPoolFormatted: "0",
                                    lifetimeClaimedPoolUSDFormatted: "0",
                                    userPoolTokensFull: "0",
                                };
                                pools.push(agentPool);
                                continue;
                            }

                            const pool = await CollateralPool.at(agent.poolAddress);
                            const poolToken = await CollateraPoolToken.at(agent.tokenAddress);
                            const balance = toBN(await poolToken.balanceOf(address));
                            const balanceFormated = formatBNToDisplayDecimals(balance, 3, 18);
                            const fees = toBN(await pool.fAssetFeesOf(address));
                            if ((balance.eqn(0) || balanceFormated == "0") && fees.eqn(0)) {
                                const claimedPools = await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress);
                                let lifetimeClaimedPool = "0";
                                if (Object.keys(claimedPools).length != 0) {
                                    const keys = Object.keys(claimedPools);
                                    const firstKey = keys[0];
                                    lifetimeClaimedPool = claimedPools[firstKey].value;
                                }
                                /*const lifetimeClaimedPool = (await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress))[0]
                                        .claimedUBA;*/
                                const lifetimeClaimedPoolFormatted = formatBNToDisplayDecimals(
                                    toBN(lifetimeClaimedPool),
                                    fasset.includes("XRP") ? 3 : 8,
                                    Number(settings.assetDecimals)
                                );
                                const lifetimeClaimedPoolUSD = toBN(lifetimeClaimedPool)
                                    .mul(priceAsset.price)
                                    .div(toBNExp(1, Number(priceAsset.decimals)));
                                const lifetimeClaimedPoolUSDFormatted = formatFixed(lifetimeClaimedPoolUSD, Number(settings.assetDecimals), {
                                    decimals: 3,
                                    groupDigits: true,
                                    groupSeparator: ",",
                                });
                                const agentPool = {
                                    vault: agent.vaultAddress,
                                    pool: agent.poolAddress,
                                    totalPoolCollateral: agent.totalPoolCollateral,
                                    poolCR: Number(agent.poolCR).toFixed(2),
                                    vaultCR: Number(agent.vaultCR).toFixed(2),
                                    //userPoolBalance: formatFixed(balance, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                    userPoolBalance: formatBNToDisplayDecimals(balance, 3, 18),
                                    //userPoolFees: formatFixed(fees, 6, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                    userPoolFees: "0",
                                    feeShare: (agent.feeShare * 100).toFixed(0),
                                    userPoolNatBalance: "0",
                                    userPoolNatBalanceInUSD: "0",
                                    agentName: agent.agentName,
                                    vaultType: agent.vaultType,
                                    poolExitCR: Number(agent.poolExitCR).toFixed(2),
                                    status: status,
                                    userPoolShare: "0",
                                    health: agent.status,
                                    freeLots: agent.freeLots,
                                    mintCount: agent.mintNumber,
                                    numLiquidations: agent.numLiquidations,
                                    redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                                    url: agent.url,
                                    poolCollateralUSD: agent.poolNatUsd,
                                    vaultCollateral: agent.vaultCollateral,
                                    collateralToken: agent.vaultCollateralToken === "USDT" ? "USDT0" : agent.vaultCollateralToken,
                                    //transferableTokens: formatFixed(transferableTokens, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                    transferableTokens: "0",
                                    tokenAddress: agent.tokenAddress,
                                    //fassetDebt: formatFixed(fassetDebt, 6, { decimals: 6, groupDigits: true, groupSeparator: "," })
                                    fassetDebt: "0",
                                    nonTimeLocked: "0",
                                    mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                                    mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                                    vaultCCBCR: Number(1).toFixed(2),
                                    vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                                    vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    poolCCBCR: Number(1).toFixed(2),
                                    poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                                    poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                                    description: agent.description,
                                    mintedAssets: agent.mintedUBA,
                                    mintedUSD: agent.mintedUSD,
                                    remainingAssets: agent.remainingUBA,
                                    remainingUSD: agent.remainingUSD,
                                    allLots: agent.allLots,
                                    poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                                    vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                                    userPoolFeesUSD: "0",
                                    totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                                    limitUSD: agent.limitUSD,
                                    lifetimeClaimedPoolFormatted: lifetimeClaimedPoolFormatted,
                                    lifetimeClaimedPoolUSDFormatted: lifetimeClaimedPoolUSDFormatted,
                                    userPoolTokensFull: balance.toString(),
                                };
                                pools.push(agentPool);
                                continue;
                            }
                            const poolNatBalance = toBN(await pool.totalCollateral()); // collateral in pool (for example # of SGB in pool)
                            const totalSupply = toBN(await poolToken.totalSupply()); // all issued collateral pool tokens
                            //If formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                            const userPoolNatBalance = balanceFormated.toString() == "0" ? "0" : toBN(balance).mul(poolNatBalance).div(totalSupply);
                            const feesUSD = fees.mul(priceAsset.price).div(toBNExp(1, Number(priceAsset.decimals)));
                            const feesUSDFormatted = formatFixed(feesUSD, Number(settings.assetDecimals), {
                                decimals: 3,
                                groupDigits: true,
                                groupSeparator: ",",
                            });
                            const transferableTokens = await poolToken.transferableBalanceOf(address);
                            const nonTimeLocked = await poolToken.nonTimelockedBalanceOf(address);
                            const totalSupplyNum = Number(totalSupply.div(toBNExp(1, 18)));
                            const balanceNum = Number(balance.div(toBNExp(1, 18)));
                            let percentage = (balanceNum / totalSupplyNum) * 100;
                            //const fassetDebt = await pool.fAssetFeeDebtOf(address); Uncommment if enabled in FE
                            //If formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                            const userPoolNatBalanceUSD =
                                balanceFormated.toString() == "0" ? "0" : toBN(userPoolNatBalance).mul(price.tokenPrice.price).div(toBNExp(1, 18)); //still needs to be trimmed for price.tokenPrice.decimals in formatFixed
                            if (percentage < 0.01 && percentage != 0) {
                                percentage = 0.01;
                            }
                            const claimedPools = await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress);
                            let lifetimeClaimedPool = "0";
                            if (Object.keys(claimedPools).length != 0) {
                                const keys = Object.keys(claimedPools);
                                const firstKey = keys[0];
                                lifetimeClaimedPool = claimedPools[firstKey].value;
                            }
                            /*const lifetimeClaimedPool = (await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress))[0]
                                    .claimedUBA;*/
                            const lifetimeClaimedPoolFormatted = formatBNToDisplayDecimals(
                                toBN(lifetimeClaimedPool),
                                fasset.includes("XRP") ? 3 : 8,
                                Number(settings.assetDecimals)
                            );
                            const lifetimeClaimedPoolUSD = toBN(lifetimeClaimedPool)
                                .mul(priceAsset.price)
                                .div(toBNExp(1, Number(priceAsset.decimals)));
                            const lifetimeClaimedPoolUSDFormatted = formatFixed(lifetimeClaimedPoolUSD, Number(settings.assetDecimals), {
                                decimals: 3,
                                groupDigits: true,
                                groupSeparator: ",",
                            });
                            const agentPool = {
                                vault: agent.vaultAddress,
                                pool: agent.poolAddress,
                                totalPoolCollateral: agent.totalPoolCollateral,
                                poolCR: Number(agent.poolCR).toFixed(2),
                                vaultCR: Number(agent.vaultCR).toFixed(2),
                                //userPoolBalance: formatFixed(balance, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                userPoolBalance: formatBNToDisplayDecimals(balance, 3, 18),
                                //userPoolFees: formatFixed(fees, 6, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                userPoolFees: formatBNToDisplayDecimals(toBN(fees), fasset.includes("XRP") ? 3 : 8, Number(settings.assetDecimals)),
                                feeShare: (agent.feeShare * 100).toFixed(0),
                                userPoolNatBalance: formatFixed(toBN(userPoolNatBalance), 18, {
                                    decimals: 3,
                                    groupDigits: true,
                                    groupSeparator: ",",
                                }),
                                userPoolNatBalanceInUSD: formatFixed(toBN(userPoolNatBalanceUSD), Number(price.tokenPrice.decimals), {
                                    decimals: 6,
                                    groupDigits: true,
                                    groupSeparator: ",",
                                }),
                                agentName: agent.agentName,
                                vaultType: agent.vaultType,
                                poolExitCR: Number(agent.poolExitCR).toFixed(2),
                                status: status,
                                userPoolShare: percentage.toFixed(2),
                                health: agent.status,
                                freeLots: agent.freeLots,
                                mintCount: agent.mintNumber,
                                numLiquidations: agent.numLiquidations,
                                redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                                url: agent.url,
                                poolCollateralUSD: agent.poolNatUsd,
                                vaultCollateral: agent.vaultCollateral,
                                collateralToken: agent.vaultCollateralToken === "USDT" ? "USDT0" : agent.vaultCollateralToken,
                                //transferableTokens: formatFixed(transferableTokens, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                transferableTokens: formatBNToDisplayDecimals(transferableTokens, 3, 18),
                                tokenAddress: agent.tokenAddress,
                                //fassetDebt: formatBNToDisplayDecimals(fassetDebt, Number(settings.assetDecimals), Number(settings.assetDecimals)), can be 0 as debt modal is disabled in FE
                                fassetDebt: "0",
                                nonTimeLocked: formatBNToDisplayDecimals(nonTimeLocked, 3, 18),
                                mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                                mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                                vaultCCBCR: Number(1).toFixed(2),
                                vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                                vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                poolCCBCR: Number(1).toFixed(2),
                                poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                                poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                                description: agent.description,
                                mintedAssets: agent.mintedUBA,
                                mintedUSD: agent.mintedUSD,
                                remainingAssets: agent.remainingUBA,
                                remainingUSD: agent.remainingUSD,
                                allLots: agent.allLots,
                                poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                                vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                                userPoolFeesUSD: feesUSDFormatted,
                                totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                                limitUSD: agent.limitUSD,
                                infoUrl: agent.infoUrl,
                                lifetimeClaimedPoolFormatted: lifetimeClaimedPoolFormatted,
                                lifetimeClaimedPoolUSDFormatted: lifetimeClaimedPoolUSDFormatted,
                                userPoolTokensFull: nonTimeLocked.toString(),
                            };
                            pools.push(agentPool);
                        } catch (error) {
                            logger.error(`Error in getPools for specific user:`, error);
                            continue;
                        }
                    }
                }
                const parseUserPoolBalance = (balance: string): number => {
                    return parseFloat(balance.replace(/,/g, ""));
                };
                pools.sort((a, b) => parseUserPoolBalance(b.userPoolBalance) - parseUserPoolBalance(a.userPoolBalance));

                const end = Date.now();
                return pools;
            } catch (error) {
                logger.warn(`Warning in getPools, attempt ${i + 1} of ${NUM_RETRIES}: `, error);
                if (i < NUM_RETRIES - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                } else {
                    if (error.message.includes("undefined")) {
                        logger.warn("Warning in getPools: ", error);
                    } else {
                        logger.error("Error in getPools: ", error);
                    }
                }
            }
        }
    }

    async getPoolsSpecific(fasset: string, address: string, pool: string): Promise<AgentPoolItem> {
        try {
            const agents = await this.em.find(Pool, { poolAddress: pool });
            const pools = [];
            const now = Date.now();
            const bot = this.botService.getInfoBot(fasset);
            const nativeSymbol = bot.context.nativeChainInfo.tokenSymbol;
            for (const agent of agents) {
                try {
                    const pool = await CollateralPool.at(agent.poolAddress);
                    const poolToken = await CollateraPoolToken.at(agent.tokenAddress);
                    const balance = toBN(await poolToken.balanceOf(address)); // number of collateral pool tokens
                    const balanceFormated = formatBNToDisplayDecimals(balance, 3, 18);
                    const status = await this.getAgentLiveness(agent.vaultAddress, now);
                    const vaultCollaterals = await this.em.find(Collateral, {
                        fasset: fasset,
                        token: agent.vaultToken,
                    });
                    const poolCollaterals = await this.em.find(Collateral, {
                        fasset: fasset,
                        tokenFtsoSymbol: nativeSymbol,
                    });
                    const vaultCollateral = vaultCollaterals[0];
                    const poolCollateral = poolCollaterals[0];
                    const fees = toBN(await pool.fAssetFeesOf(address));
                    if (balance.eq(BN_ZERO) && fees.eqn(0)) {
                        const agentPool = {
                            vault: agent.vaultAddress,
                            pool: agent.poolAddress,
                            totalPoolCollateral: agent.totalPoolCollateral,
                            poolCR: Number(agent.poolCR).toFixed(2),
                            vaultCR: Number(agent.vaultCR).toFixed(2),
                            userPoolBalance: "0",
                            userPoolFees: "0",
                            feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                            userPoolNatBalance: "0",
                            userPoolNatBalanceInUSD: "0",
                            agentName: agent.agentName,
                            vaultType: agent.vaultType,
                            poolExitCR: Number(agent.poolExitCR).toFixed(2),
                            status: status,
                            userPoolShare: "0",
                            health: agent.status,
                            freeLots: agent.freeLots,
                            mintCount: agent.mintNumber,
                            numLiquidations: agent.numLiquidations,
                            redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                            url: agent.url,
                            poolCollateralUSD: agent.poolNatUsd,
                            vaultCollateral: agent.vaultCollateral,
                            collateralToken: agent.vaultCollateralToken === "USDT" ? "USDT0" : agent.vaultCollateralToken,
                            transferableTokens: "0",
                            tokenAddress: agent.tokenAddress,
                            fassetDebt: "0",
                            nonTimeLocked: "0",
                            mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                            mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                            vaultCCBCR: Number(1).toFixed(2),
                            vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                            vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            poolCCBCR: Number(1).toFixed(2),
                            poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                            poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                            description: agent.description,
                            mintedAssets: agent.mintedUBA,
                            mintedUSD: agent.mintedUSD,
                            remainingAssets: agent.remainingUBA,
                            remainingUSD: agent.remainingUSD,
                            allLots: agent.allLots,
                            poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                            vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                            userPoolFeesUSD: "0",
                            totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                            limitUSD: agent.limitUSD,
                            infoUrl: agent.infoUrl,
                            lifetimeClaimedPoolFormatted: "0",
                            lifetimeClaimedPoolUSDFormatted: "0",
                            userPoolTokensFull: balance.toString(),
                        };
                        pools.push(agentPool);
                        continue;
                    }
                    const poolNatBalance = toBN(await pool.totalCollateral()); // collateral in pool (for example # of SGB in pool)
                    const totalSupply = toBN(await poolToken.totalSupply()); // all issued collateral pool tokens
                    //IF formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                    const userPoolNatBalance = balanceFormated.toString() == "0" ? "0" : toBN(balance).mul(poolNatBalance).div(totalSupply);
                    const bot = this.botService.getInfoBot(fasset);
                    const settings = await bot.context.assetManager.getSettings();
                    const priceReader = await TokenPriceReader.create(settings);
                    const priceAsset = await priceReader.getPrice(this.botService.getAssetSymbol(fasset), false, settings.maxTrustedPriceAgeSeconds);
                    const feesUSD = fees.mul(priceAsset.price).div(toBNExp(1, Number(priceAsset.decimals)));
                    const feesUSDFormatted = formatFixed(feesUSD, Number(settings.assetDecimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const transferableTokens = await poolToken.transferableBalanceOf(address);
                    const nonTimeLocked = await poolToken.nonTimelockedBalanceOf(address);
                    //const fassetDebt = await pool.fAssetFeeDebtOf(address);
                    const totalSupplyNum = Number(totalSupply.div(toBNExp(1, 18)));
                    const balanceNum = Number(balance.div(toBNExp(1, 18)));
                    let percentage = (balanceNum / totalSupplyNum) * 100;
                    // calc userPoolNatBalance in USD
                    const price = await this.getPoolCollateralPrice(fasset, settings);
                    //IF formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                    const userPoolNatBalanceUSD =
                        balanceFormated.toString() == "0" ? "0" : toBN(userPoolNatBalance).mul(price.tokenPrice.price).div(toBNExp(1, 18)); //still needs to be trimmed for price.tokenPrice.decimals in formatFixed

                    if (percentage < 0.01 && percentage != 0) {
                        percentage = 0.01;
                    }
                    const claimedPools = await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress);
                    let lifetimeClaimedPool = "0";
                    if (Object.keys(claimedPools).length != 0) {
                        const keys = Object.keys(claimedPools);
                        const firstKey = keys[0];
                        lifetimeClaimedPool = claimedPools[firstKey].value;
                    }
                    const lifetimeClaimedPoolFormatted = formatBNToDisplayDecimals(
                        toBN(lifetimeClaimedPool),
                        fasset.includes("XRP") ? 3 : 8,
                        Number(settings.assetDecimals)
                    );
                    const lifetimeClaimedPoolUSD = toBN(lifetimeClaimedPool)
                        .mul(priceAsset.price)
                        .div(toBNExp(1, Number(priceAsset.decimals)));
                    const lifetimeClaimedPoolUSDFormatted = formatFixed(lifetimeClaimedPoolUSD, Number(settings.assetDecimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const agentPool = {
                        vault: agent.vaultAddress,
                        pool: agent.poolAddress,
                        totalPoolCollateral: agent.totalPoolCollateral,
                        poolCR: Number(agent.poolCR).toFixed(2),
                        vaultCR: Number(agent.vaultCR).toFixed(2),
                        userPoolBalance: formatBNToDisplayDecimals(balance, 3, 18),
                        userPoolFees: formatBNToDisplayDecimals(toBN(fees), fasset.includes("XRP") ? 3 : 8, Number(settings.assetDecimals)),
                        feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                        userPoolNatBalance: formatFixed(toBN(userPoolNatBalance), 18, {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        }),
                        userPoolNatBalanceInUSD: formatFixed(toBN(userPoolNatBalanceUSD), Number(price.tokenPrice.decimals), {
                            decimals: 6,
                            groupDigits: true,
                            groupSeparator: ",",
                        }),
                        agentName: agent.agentName,
                        vaultType: agent.vaultType,
                        poolExitCR: Number(agent.poolExitCR).toFixed(2),
                        status: status,
                        userPoolShare: percentage.toFixed(2),
                        health: agent.status,
                        freeLots: agent.freeLots,
                        mintCount: agent.mintNumber,
                        numLiquidations: agent.numLiquidations,
                        redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                        url: agent.url,
                        poolCollateralUSD: agent.poolNatUsd,
                        vaultCollateral: agent.vaultCollateral,
                        collateralToken: agent.vaultCollateralToken === "USDT" ? "USDT0" : agent.vaultCollateralToken,
                        transferableTokens: formatBNToDisplayDecimals(transferableTokens, 3, 18),
                        tokenAddress: agent.tokenAddress,
                        //fassetDebt: formatBNToDisplayDecimals(fassetDebt, Number(settings.assetDecimals), Number(settings.assetDecimals)), Uncomment if sending cpt enabled in FE
                        fassetDebt: "0",
                        nonTimeLocked: formatBNToDisplayDecimals(nonTimeLocked, 3, 18),
                        mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                        mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                        vaultCCBCR: Number(1).toFixed(2),
                        vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                        vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                        poolCCBCR: Number(1).toFixed(2),
                        poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                        poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                        mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                        description: agent.description,
                        mintedAssets: agent.mintedUBA,
                        mintedUSD: agent.mintedUSD,
                        remainingAssets: agent.remainingUBA,
                        remainingUSD: agent.remainingUSD,
                        allLots: agent.allLots,
                        poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                        vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                        userPoolFeesUSD: feesUSDFormatted,
                        totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                        limitUSD: agent.limitUSD,
                        infoUrl: agent.infoUrl,
                        lifetimeClaimedPoolFormatted: lifetimeClaimedPoolFormatted,
                        lifetimeClaimedPoolUSDFormatted: lifetimeClaimedPoolUSDFormatted,
                        userPoolTokensFull: nonTimeLocked.toString(),
                    };
                    pools.push(agentPool);
                } catch (error) {
                    logger.error(`Error in getPoolsSpecific for specific user:`, error);
                    continue;
                }
            }
            return pools[0];
        } catch (error) {
            throw error;
        }
    }

    //TODO: add verification return
    async getAgents(fassets: string[]): Promise<AgentPoolItem[]> {
        try {
            const pools = [];
            const now = Date.now();
            for (const fasset of fassets) {
                const agents = await this.em.find(Pool, { fasset });
                const bot = this.botService.getUserBot(fasset);

                for (const agent of agents) {
                    try {
                        if (!agent.publiclyAvailable) {
                            continue;
                        }
                        if (agent.status >= 2) {
                            continue;
                        }
                        const status = await this.getAgentLiveness(agent.vaultAddress, now);
                        const vaultCollaterals = await this.em.find(Collateral, {
                            fasset: fasset,
                            token: agent.vaultToken,
                        });
                        const poolCollaterals = await this.em.find(Collateral, {
                            fasset: fasset,
                            tokenFtsoSymbol: bot.context.nativeChainInfo.tokenSymbol,
                        });
                        const vaultCollateral = vaultCollaterals[0];
                        const poolCollateral = poolCollaterals[0];
                        const agentPool = {
                            vault: agent.vaultAddress,
                            pool: agent.poolAddress,
                            totalPoolCollateral: agent.totalPoolCollateral,
                            poolCR: Number(agent.poolCR).toFixed(2),
                            vaultCR: Number(agent.vaultCR).toFixed(2),
                            feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                            agentName: agent.agentName,
                            vaultType: agent.vaultType,
                            poolExitCR: Number(agent.poolExitCR).toFixed(2),
                            freeLots: agent.freeLots,
                            status: status,
                            mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                            health: agent.status,
                            mintCount: agent.mintNumber,
                            numLiquidations: agent.numLiquidations,
                            redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                            url: agent.url,
                            poolCollateralUSD: agent.poolNatUsd,
                            vaultCollateral: agent.vaultCollateral,
                            collateralToken: agent.vaultCollateralToken === "USDT" ? "USDT0" : agent.vaultCollateralToken,
                            mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                            mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                            vaultCCBCR: Number(1).toFixed(2),
                            vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                            vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            poolCCBCR: Number(1).toFixed(2),
                            poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                            poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            description: agent.description,
                            mintedAssets: agent.mintedUBA,
                            mintedUSD: agent.mintedUSD,
                            remainingAssets: agent.remainingUBA,
                            remainingUSD: agent.remainingUSD,
                            allLots: agent.allLots,
                            poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                            vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                            totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                            limitUSD: agent.limitUSD,
                            infoUrl: agent.infoUrl,
                        };
                        pools.push(agentPool);
                    } catch (error) {
                        logger.error(`Error in getAgents (getAgentLiveness):`, error);
                        continue;
                    }
                }
            }
            return pools;
        } catch (error) {
            logger.error(`Error in getAgents:`, error);
            throw error;
        }
    }

    async getAgentSpecific(fasset: string, poolAddress: string): Promise<AgentPoolItem> {
        try {
            const pools = [];
            const now = Date.now();
            const agent = await this.em.findOne(Pool, { poolAddress: poolAddress });
            const status = await this.getAgentLiveness(agent.vaultAddress, now);
            const bot = this.botService.getUserBot(fasset);
            const vaultCollateral = await this.em.findOne(Collateral, {
                fasset: fasset,
                token: agent.vaultToken,
            });
            const poolCollateral = await this.em.findOne(Collateral, {
                fasset: fasset,
                tokenFtsoSymbol: bot.context.nativeChainInfo.tokenSymbol,
            });
            const agentPool: AgentPoolItem = {
                vault: agent.vaultAddress,
                pool: agent.poolAddress,
                tokenAddress: agent.tokenAddress,
                totalPoolCollateral: agent.totalPoolCollateral,
                poolCR: Number(agent.poolCR).toFixed(2),
                vaultCR: Number(agent.vaultCR).toFixed(2),
                feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                agentName: agent.agentName,
                vaultType: agent.vaultType,
                poolExitCR: Number(agent.poolExitCR).toFixed(2),
                freeLots: agent.freeLots,
                status: status,
                mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                health: agent.status,
                mintCount: agent.mintNumber,
                numLiquidations: agent.numLiquidations,
                redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                url: agent.url,
                poolCollateralUSD: agent.poolNatUsd,
                vaultCollateral: agent.vaultCollateral,
                collateralToken: agent.vaultCollateralToken === "USDT" ? "USDT0" : agent.vaultCollateralToken,
                mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                vaultCCBCR: Number(1).toFixed(2),
                vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                poolCCBCR: Number(1).toFixed(2),
                poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                description: agent.description,
                mintedAssets: agent.mintedUBA,
                mintedUSD: agent.mintedUSD,
                remainingAssets: agent.remainingUBA,
                remainingUSD: agent.remainingUSD,
                allLots: agent.allLots,
                poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                limitUSD: agent.limitUSD,
                infoUrl: agent.infoUrl,
            };
            return agentPool;
        } catch (error) {
            logger.error(`Error in getAgents:`, error);
            throw error;
        }
    }

    //TODO: add verification return
    async getAgentsLatest(fasset: string): Promise<AgentPoolLatest[]> {
        try {
            const agents = await this.em.find(Pool, { fasset });
            const infoBot = this.botService.getInfoBot(fasset);
            const pools: AgentPoolLatest[] = [];
            const now = Date.now();
            const vaults = await infoBot.getAvailableAgents();
            const settings = await infoBot.context.assetManager.getSettings();
            const tokenSupply = await infoBot.context.fAsset.totalSupply();
            const lotSizeUBA = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
            const mintingCap = toBN(settings.mintingCapAMG).mul(toBN(settings.assetMintingGranularityUBA));
            const availableToMintUBA = mintingCap.toString() === "0" ? toBN(0) : mintingCap.sub(tokenSupply);
            const availableToMintLots = mintingCap.toString() === "0" ? toBN(0) : availableToMintUBA.div(lotSizeUBA);
            for (const agent of agents) {
                try {
                    if (agent.status != 0 || !agent.publiclyAvailable) {
                        continue;
                    }
                    //const info = await infoBot.context.assetManager.getAgentInfo(agent.vaultAddress);
                    const info = vaults.find((v) => v.agentVault === agent.vaultAddress);
                    if (Number(info.freeCollateralLots) == 0) {
                        continue;
                    }
                    const status = await this.getAgentLiveness(agent.vaultAddress, now);
                    const poolcr = Number(agent.poolCR);
                    const vaultcr = Number(agent.vaultCR);
                    const poolExitCR = Number(agent.poolExitCR);
                    const feeBIPS = info.feeBIPS;
                    const lots =
                        mintingCap.toString() === "0"
                            ? Number(info.freeCollateralLots.toString())
                            : Math.min(Number(info.freeCollateralLots.toString()), availableToMintLots.toNumber());
                    const agentPool = {
                        vault: agent.vaultAddress,
                        totalPoolCollateral: agent.totalPoolCollateral,
                        poolCR: poolcr.toFixed(2),
                        vaultCR: vaultcr.toFixed(2),
                        feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                        agentName: agent.agentName,
                        vaultType: agent.vaultType,
                        poolExitCR: poolExitCR.toFixed(2),
                        freeLots: lots.toString(),
                        status: status,
                        mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                        health: Number(agent.status),
                        url: agent.url,
                        feeBIPS: feeBIPS.toString(),
                        underlyingAddress: agent.underlyingAddress,
                        infoUrl: agent.infoUrl,
                    };
                    pools.push(agentPool);
                } catch (error) {
                    logger.error(`Error in getAgentsLatest (getAgentLiveness):`, error);
                    continue;
                }
            }
            return pools;
        } catch (error) {
            logger.error(`Error in getAgentsLatest:`, error);
            throw error;
        }
    }
}
