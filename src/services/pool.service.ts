/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { AgentPoolItem, AgentPoolLatest, IndexerTokenBalances } from "../interfaces/requestResponse";
import { EntityManager } from "@mikro-orm/core";
import { Pool } from "../entities/Pool";
import { Liveness } from "../entities/AgentLiveness";
import { formatBigIntToDisplayDecimals, formatFixedBigInt, calculateUSDValueBigInt, bigintPow10 } from "src/utils/utils";
import { logger } from "src/logger/winston.logger";
import { Collateral } from "src/entities/Collaterals";
import { ExternalApiService } from "./external.api.service";
import { ConfigService } from "@nestjs/config";
import { FILTER_AGENT } from "src/utils/constants";
import { ContractService } from "./contract.service";
import { FassetConfigService } from "./fasset.config.service";
import type { IAssetManager } from "../typechain-ethers-v6";
import type { ICollateralPool } from "../typechain-ethers-v6";
import type { ICollateralPoolToken } from "../typechain-ethers-v6";
import type { IPriceReader } from "../typechain-ethers-v6";
import type { IFAsset } from "../typechain-ethers-v6";

const NUM_RETRIES = 3;

// ─── helpers ────────────────────────────────────────────────────────────────

/** Get IAssetManager contract for a given fasset via deploys naming convention */
function getAssetManagerName(fasset: string): string {
    return `AssetManager_${fasset}`;
}

@Injectable()
export class PoolService {
    constructor(
        private readonly externalApiService: ExternalApiService,
        private readonly em: EntityManager,
        private readonly configService: ConfigService,
        private readonly contractService: ContractService,
        private readonly fassetConfigService: FassetConfigService
    ) {}

    // ─── indexer helpers ────────────────────────────────────────────────

    async getTokenBalanceFromIndexer(userAddress: string): Promise<IndexerTokenBalances[]> {
        const data = await this.externalApiService.getUserCollateralPoolTokens(userAddress);
        return data;
    }

    // ─── agent liveness ─────────────────────────────────────────────────

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
        }
        return status;
    }

    // ─── contract accessors (cached per-call via ContractService) ───────

    private getAssetManager(fasset: string): IAssetManager {
        return this.contractService.get<IAssetManager>(getAssetManagerName(fasset));
    }

    private getPool(poolAddress: string): ICollateralPool {
        return this.contractService.getCollateralPoolContract(poolAddress);
    }

    private getPoolToken(tokenAddress: string): ICollateralPoolToken {
        return this.contractService.getCollateralPoolTokenContract(tokenAddress);
    }

    private getPriceReader(): IPriceReader {
        return this.contractService.get<IPriceReader>("PriceReader");
    }

    private getFAsset(fasset: string): IFAsset {
        return this.contractService.get<IFAsset>(fasset);
    }

    /**
     * Get the native token price from the PriceReader.
     * Returns { price, decimals } as bigints.
     */
    private async getNativePrice(): Promise<{ price: bigint; decimals: bigint }> {
        const nativeSymbol = this.fassetConfigService.getNativeSymbol();
        const priceReader = this.getPriceReader();
        const result = await priceReader.getPrice(nativeSymbol);
        return { price: result._price, decimals: result._priceDecimals };
    }

    /**
     * Get the asset price from the PriceReader by fasset name.
     * Returns { price, decimals } as bigints.
     */
    private async getAssetPrice(fasset: string): Promise<{ price: bigint; decimals: bigint }> {
        const fassetConfig = this.fassetConfigService.getFAssetByName(fasset);
        const priceReader = this.getPriceReader();
        const result = await priceReader.getPrice(fassetConfig.tokenSymbol);
        return { price: result._price, decimals: result._priceDecimals };
    }

    // ─── lifetime claimed pool helper ───────────────────────────────────

    private async getLifetimeClaimedPool(
        address: string,
        poolAddress: string,
        fasset: string,
        assetDecimals: number,
        assetPrice: { price: bigint; decimals: bigint }
    ): Promise<{ formatted: string; usdFormatted: string }> {
        const claimedPools = await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, poolAddress);
        let lifetimeClaimedPool = "0";
        if (Object.keys(claimedPools).length != 0) {
            const keys = Object.keys(claimedPools);
            const firstKey = keys[0];
            lifetimeClaimedPool = claimedPools[firstKey].value;
        }
        const formatted = formatBigIntToDisplayDecimals(BigInt(lifetimeClaimedPool), fasset.includes("XRP") ? 3 : 8, assetDecimals);
        const usdFormatted = calculateUSDValueBigInt(BigInt(lifetimeClaimedPool), assetPrice.price, Number(assetPrice.decimals), assetDecimals, 3);
        return { formatted, usdFormatted };
    }

    // ─── getPools ───────────────────────────────────────────────────────

    async getPools(fassets: string[], address: string): Promise<AgentPoolItem[]> {
        if (address === "undefined") {
            return [];
        }
        // Drop entries that came from a missing/blank ?fasset= query. When the FE
        // sends no query, NestJS passes `undefined`, which the controller wraps
        // into `[undefined]`; without this filter we'd look up a non-existent
        // "AssetManager_undefined" contract and burn 3 retries.
        fassets = (fassets ?? []).filter((f) => f && f !== "undefined");
        if (fassets.length === 0) {
            return [];
        }
        if (this.configService.get<string>("NETWORK") == "songbird") {
            if (fassets.indexOf("FDOGE") === -1) {
                try {
                    this.getAssetManager("FDOGE");
                    fassets.push("FDOGE");
                } catch {
                    // FDOGE asset manager not available
                }
            }
        }

        const cptokenBalances = await this.getTokenBalanceFromIndexer(address);

        for (let i = 0; i < NUM_RETRIES; i++) {
            try {
                const pools: AgentPoolItem[] = [];
                const now = Date.now();
                for (const fasset of fassets) {
                    const agents = await this.em.find(Pool, { fasset });

                    // prefetch liveness
                    const livenessPromises = agents.map((agent) => this.getAgentLiveness(agent.vaultAddress, now));
                    const livenessData = await Promise.all(livenessPromises);

                    // get asset manager settings & prices
                    const assetManager = this.getAssetManager(fasset);
                    const settings = await assetManager.getSettings();
                    const assetDecimals = Number(settings.assetDecimals);
                    const nativeSymbol = this.fassetConfigService.getNativeSymbol();
                    const nativePrice = await this.getNativePrice();
                    const assetPrice = await this.getAssetPrice(fasset);

                    for (let j = 0; j < agents.length; j++) {
                        const agent = agents[j];
                        if (agent.vaultAddress.toLowerCase() === FILTER_AGENT) {
                            continue;
                        }
                        try {
                            const status = livenessData[j];
                            const info = cptokenBalances[agent.tokenAddress];
                            if (!info && !agent.publiclyAvailable) {
                                continue;
                            }

                            const [vaultCollaterals, poolCollaterals] = await Promise.all([
                                this.em.find(Collateral, { fasset, token: agent.vaultToken }),
                                this.em.find(Collateral, { fasset, tokenFtsoSymbol: nativeSymbol }),
                            ]);
                            const vaultCollateral = vaultCollaterals[0];
                            const poolCollateral = poolCollaterals[0];

                            if (!info) {
                                if (agent.status >= 2) {
                                    continue;
                                }
                                const agentPool: AgentPoolItem = {
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

                            // User has tokens for this pool
                            const pool = this.getPool(agent.poolAddress);
                            const poolToken = this.getPoolToken(agent.tokenAddress);
                            const balance = await poolToken.balanceOf(address);
                            const balanceFormatted = formatBigIntToDisplayDecimals(balance, 3, 18);
                            const fees = await pool.fAssetFeesOf(address);

                            if ((balance === 0n || balanceFormatted == "0") && fees === 0n) {
                                const claimed = await this.getLifetimeClaimedPool(address, agent.poolAddress, fasset, assetDecimals, assetPrice);
                                const agentPool: AgentPoolItem = {
                                    vault: agent.vaultAddress,
                                    pool: agent.poolAddress,
                                    totalPoolCollateral: agent.totalPoolCollateral,
                                    poolCR: Number(agent.poolCR).toFixed(2),
                                    vaultCR: Number(agent.vaultCR).toFixed(2),
                                    userPoolBalance: formatBigIntToDisplayDecimals(balance, 3, 18),
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
                                    lifetimeClaimedPoolFormatted: claimed.formatted,
                                    lifetimeClaimedPoolUSDFormatted: claimed.usdFormatted,
                                    userPoolTokensFull: balance.toString(),
                                };
                                pools.push(agentPool);
                                continue;
                            }

                            // User has meaningful balance
                            const [poolNatBalance, totalSupply, transferableTokens, nonTimeLocked] = await Promise.all([
                                pool.totalCollateral(),
                                poolToken.totalSupply(),
                                poolToken.transferableBalanceOf(address),
                                poolToken.nonTimelockedBalanceOf(address),
                            ]);

                            // If formatted balance is "0" (very low decimals), treat pool balance (also in USD) as 0
                            const userPoolNatBalance = balanceFormatted === "0" ? 0n : (balance * poolNatBalance) / totalSupply;

                            const feesUSDFormatted = calculateUSDValueBigInt(fees, assetPrice.price, Number(assetPrice.decimals), assetDecimals, 3);

                            const totalSupplyNum = Number(totalSupply / bigintPow10(18));
                            const balanceNum = Number(balance / bigintPow10(18));
                            let percentage = (balanceNum / totalSupplyNum) * 100;

                            // userPoolNatBalance is in wei (18 decimals), nativePrice.price is scaled by 10^nativePrice.decimals
                            // Result: userPoolNatBalanceUSD has (18 + nativePrice.decimals) total decimal places
                            const userPoolNatBalanceUSD = balanceFormatted === "0" ? 0n : userPoolNatBalance * nativePrice.price;

                            if (percentage < 0.01 && percentage != 0) {
                                percentage = 0.01;
                            }

                            const claimed = await this.getLifetimeClaimedPool(address, agent.poolAddress, fasset, assetDecimals, assetPrice);

                            const agentPool: AgentPoolItem = {
                                vault: agent.vaultAddress,
                                pool: agent.poolAddress,
                                totalPoolCollateral: agent.totalPoolCollateral,
                                poolCR: Number(agent.poolCR).toFixed(2),
                                vaultCR: Number(agent.vaultCR).toFixed(2),
                                userPoolBalance: formatBigIntToDisplayDecimals(balance, 3, 18),
                                userPoolFees: formatBigIntToDisplayDecimals(fees, fasset.includes("XRP") ? 3 : 8, assetDecimals),
                                feeShare: (agent.feeShare * 100).toFixed(0),
                                userPoolNatBalance: formatFixedBigInt(userPoolNatBalance, 18, {
                                    decimals: 3,
                                    groupDigits: true,
                                    groupSeparator: ",",
                                }),
                                userPoolNatBalanceInUSD: formatFixedBigInt(userPoolNatBalanceUSD, 18 + Number(nativePrice.decimals), {
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
                                transferableTokens: formatBigIntToDisplayDecimals(transferableTokens, 3, 18),
                                tokenAddress: agent.tokenAddress,
                                fassetDebt: "0",
                                nonTimeLocked: formatBigIntToDisplayDecimals(nonTimeLocked, 3, 18),
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
                                lifetimeClaimedPoolFormatted: claimed.formatted,
                                lifetimeClaimedPoolUSDFormatted: claimed.usdFormatted,
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

    // ─── getPoolsSpecific ───────────────────────────────────────────────

    async getPoolsSpecific(fasset: string, address: string, pool: string): Promise<AgentPoolItem> {
        try {
            const agents = await this.em.find(Pool, { poolAddress: pool });
            const resultPools: AgentPoolItem[] = [];
            const now = Date.now();
            const nativeSymbol = this.fassetConfigService.getNativeSymbol();

            for (const agent of agents) {
                if (agent.vaultAddress.toLowerCase() === FILTER_AGENT) {
                    continue;
                }
                try {
                    const poolContract = this.getPool(agent.poolAddress);
                    const poolToken = this.getPoolToken(agent.tokenAddress);
                    const balance = await poolToken.balanceOf(address);
                    const balanceFormatted = formatBigIntToDisplayDecimals(balance, 3, 18);
                    const status = await this.getAgentLiveness(agent.vaultAddress, now);

                    const [vaultCollaterals, poolCollaterals] = await Promise.all([
                        this.em.find(Collateral, { fasset, token: agent.vaultToken }),
                        this.em.find(Collateral, { fasset, tokenFtsoSymbol: nativeSymbol }),
                    ]);
                    const vaultCollateral = vaultCollaterals[0];
                    const poolCollateral = poolCollaterals[0];

                    const fees = await poolContract.fAssetFeesOf(address);

                    if (balance === 0n && fees === 0n) {
                        const agentPool: AgentPoolItem = {
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
                        resultPools.push(agentPool);
                        continue;
                    }

                    const [poolNatBalance, totalSupply, transferableTokens, nonTimeLocked] = await Promise.all([
                        poolContract.totalCollateral(),
                        poolToken.totalSupply(),
                        poolToken.transferableBalanceOf(address),
                        poolToken.nonTimelockedBalanceOf(address),
                    ]);

                    // If formatted balance is "0" (very low decimals), treat pool balance as 0
                    const userPoolNatBalance = balanceFormatted === "0" ? 0n : (balance * poolNatBalance) / totalSupply;

                    const assetManager = this.getAssetManager(fasset);
                    const settings = await assetManager.getSettings();
                    const assetDecimals = Number(settings.assetDecimals);
                    const assetPrice = await this.getAssetPrice(fasset);
                    const feesUSDFormatted = calculateUSDValueBigInt(fees, assetPrice.price, Number(assetPrice.decimals), assetDecimals, 3);

                    const totalSupplyNum = Number(totalSupply / bigintPow10(18));
                    const balanceNum = Number(balance / bigintPow10(18));
                    let percentage = (balanceNum / totalSupplyNum) * 100;

                    // calc userPoolNatBalance in USD
                    const nativePrice = await this.getNativePrice();
                    const userPoolNatBalanceUSD = balanceFormatted === "0" ? 0n : userPoolNatBalance * nativePrice.price;

                    if (percentage < 0.01 && percentage != 0) {
                        percentage = 0.01;
                    }

                    const claimed = await this.getLifetimeClaimedPool(address, agent.poolAddress, fasset, assetDecimals, assetPrice);

                    const agentPool: AgentPoolItem = {
                        vault: agent.vaultAddress,
                        pool: agent.poolAddress,
                        totalPoolCollateral: agent.totalPoolCollateral,
                        poolCR: Number(agent.poolCR).toFixed(2),
                        vaultCR: Number(agent.vaultCR).toFixed(2),
                        userPoolBalance: formatBigIntToDisplayDecimals(balance, 3, 18),
                        userPoolFees: formatBigIntToDisplayDecimals(fees, fasset.includes("XRP") ? 3 : 8, assetDecimals),
                        feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                        userPoolNatBalance: formatFixedBigInt(userPoolNatBalance, 18, {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        }),
                        userPoolNatBalanceInUSD: formatFixedBigInt(userPoolNatBalanceUSD, 18 + Number(nativePrice.decimals), {
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
                        transferableTokens: formatBigIntToDisplayDecimals(transferableTokens, 3, 18),
                        tokenAddress: agent.tokenAddress,
                        fassetDebt: "0",
                        nonTimeLocked: formatBigIntToDisplayDecimals(nonTimeLocked, 3, 18),
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
                        lifetimeClaimedPoolFormatted: claimed.formatted,
                        lifetimeClaimedPoolUSDFormatted: claimed.usdFormatted,
                        userPoolTokensFull: nonTimeLocked.toString(),
                    };
                    resultPools.push(agentPool);
                } catch (error) {
                    logger.error(`Error in getPoolsSpecific for specific user:`, error);
                    continue;
                }
            }
            return resultPools[0];
        } catch (error) {
            throw error;
        }
    }

    // ─── getAgents ──────────────────────────────────────────────────────

    async getAgents(fassets: string[]): Promise<AgentPoolItem[]> {
        try {
            const pools: AgentPoolItem[] = [];
            const now = Date.now();
            const nativeSymbol = this.fassetConfigService.getNativeSymbol();

            for (const fasset of fassets) {
                const agents = await this.em.find(Pool, { fasset });

                for (const agent of agents) {
                    try {
                        if (!agent.publiclyAvailable || agent.vaultAddress.toLowerCase() === FILTER_AGENT || agent.status >= 2) {
                            continue;
                        }
                        const status = await this.getAgentLiveness(agent.vaultAddress, now);

                        const [vaultCollaterals, poolCollaterals] = await Promise.all([
                            this.em.find(Collateral, { fasset, token: agent.vaultToken }),
                            this.em.find(Collateral, { fasset, tokenFtsoSymbol: nativeSymbol }),
                        ]);
                        const vaultCollateral = vaultCollaterals[0];
                        const poolCollateral = poolCollaterals[0];

                        const agentPool: AgentPoolItem = {
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
                            // required fields from AgentPoolCommon/AgentPoolItem
                            tokenAddress: agent.tokenAddress,
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

    // ─── getAgentSpecific ───────────────────────────────────────────────

    async getAgentSpecific(fasset: string, poolAddress: string): Promise<AgentPoolItem> {
        try {
            const now = Date.now();
            const agent = await this.em.findOne(Pool, { poolAddress: poolAddress });
            const status = await this.getAgentLiveness(agent.vaultAddress, now);
            const nativeSymbol = this.fassetConfigService.getNativeSymbol();

            const [vaultCollateral, poolCollateral] = await Promise.all([
                this.em.findOne(Collateral, { fasset, token: agent.vaultToken }),
                this.em.findOne(Collateral, { fasset, tokenFtsoSymbol: nativeSymbol }),
            ]);

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
            logger.error(`Error in getAgentSpecific:`, error);
            throw error;
        }
    }

    // ─── getAgentsLatest ────────────────────────────────────────────────

    async getAgentsLatest(fasset: string): Promise<AgentPoolLatest[]> {
        try {
            const agents = await this.em.find(Pool, { fasset });
            const assetManager = this.getAssetManager(fasset);
            const pools: AgentPoolLatest[] = [];
            const now = Date.now();

            // Fetch available agents list from the asset manager contract
            const [settingsResult, availableResult, fAssetContract] = await Promise.all([
                assetManager.getSettings(),
                assetManager.getAvailableAgentsDetailedList(0, 1000),
                Promise.resolve(this.getFAsset(fasset)),
            ]);
            const settings = settingsResult;
            const vaults = availableResult._agents;
            const tokenSupply = await fAssetContract.totalSupply();

            const lotSizeUBA = settings.lotSizeAMG * settings.assetMintingGranularityUBA;
            const mintingCap = settings.mintingCapAMG * settings.assetMintingGranularityUBA;
            const availableToMintUBA = mintingCap === 0n ? 0n : mintingCap - tokenSupply;
            const availableToMintLots = mintingCap === 0n ? 0n : availableToMintUBA / lotSizeUBA;

            for (const agent of agents) {
                try {
                    if (agent.status != 0 || !agent.publiclyAvailable || agent.vaultAddress.toLowerCase() === FILTER_AGENT) {
                        continue;
                    }
                    const info = vaults.find((v) => v.agentVault === agent.vaultAddress);
                    if (!info || Number(info.freeCollateralLots) == 0) {
                        continue;
                    }
                    const status = await this.getAgentLiveness(agent.vaultAddress, now);
                    const poolcr = Number(agent.poolCR);
                    const vaultcr = Number(agent.vaultCR);
                    const poolExitCR = Number(agent.poolExitCR);
                    const feeBIPS = info.feeBIPS;
                    const lots = mintingCap === 0n ? Number(info.freeCollateralLots) : Math.min(Number(info.freeCollateralLots), Number(availableToMintLots));
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
