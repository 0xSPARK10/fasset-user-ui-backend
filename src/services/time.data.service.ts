import { Inject, Injectable } from "@nestjs/common";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { logger } from "src/logger/winston.logger";
import { TimeData, TimeDataCV, TopPool, TopPoolData } from "src/interfaces/structure";
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
import { NETWORK_SYMBOLS } from "src/utils/constants";
import { ExternalApiService } from "./external.api.service";

@Injectable()
export class TimeDataService {
    constructor(
        private readonly externalApiService: ExternalApiService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache
    ) {}

    //Get time data for landing page
    async updateTimeData(topPools: TopPoolData[], fassetList: string[], envType: string): Promise<void> {
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
            for (const p of topPools) {
                const netw = NETWORK_SYMBOLS.find((item) => (envType == "dev" ? item.test : item.real) === p.fasset);
                const collectedPoolFees = await this.externalApiService.getCollectedPoolFeesDiff(dayTimestamp.toString(), now.toString(), p.poolAddress);
                const collateralPoolDiff = await this.externalApiService.getPoolCollateralDiff(dayTimestamp.toString(), now.toString(), p.poolAddress);
                const diffTvl = calculatePoolCollateralDiff(collateralPoolDiff);
                let diffRewards;
                if (collectedPoolFees[netw.real].length === 0) {
                    diffRewards = calculatePoolRewardsDiff([
                        { timestamp: 123, value: "0" },
                        { timestamp: 1234, value: "0" },
                    ]);
                } else {
                    if (collectedPoolFees[netw.real].length === 1) {
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
                for (const f of fassetList) {
                    diffs.push({ fasset: f, diff: "0.0", isPositive: true });
                }
            } else {
                diffs = calculateFassetSupplyDiff(supply, fassetList, envType);
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
}
