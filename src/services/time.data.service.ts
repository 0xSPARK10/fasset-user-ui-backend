import { Inject, Injectable } from "@nestjs/common";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { logger } from "src/logger/winston.logger";
import { TimeData, TimeDataCV, TimeSeries, TopPool } from "src/interfaces/structure";
import {
    calculateFassetSupplyDiff,
    calculateInflowsOutflowsDiff,
    calculatePoolCollateralDiff,
    formatTimeSeries,
    formatTimeSeriesPercentage,
    formatTimeSpanRatio,
    formatTimespanToTimeseries,
    generateTimestamps,
    isEmptyObject,
} from "src/utils/dashboard.utils";
import { ExternalApiService } from "./external.api.service";

@Injectable()
export class TimeDataService {
    // Unix seconds for 2025-05-01T00:00:00Z — start of the unified ecosystem TVL window.
    private static readonly TVL_GRAPH_START_TS = 1746057600;
    // Number of points on the unified ecosystem TVL series.
    private static readonly TVL_GRAPH_POINTS = 28;

    constructor(
        private readonly externalApiService: ExternalApiService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache
    ) {}

    //Get time data for landing page
    async updateTimeData(fassetList: string[], envType: string): Promise<void> {
        //Loop for hour, week, month, year
        logger.info("Updating time data");
        // Static placeholder for bestPools — real pool computation has been removed
        // intentionally. The response shape is preserved so FE consumers keep working.
        const placeholderBestPools: TopPool[] = [
            {
                name: "Placeholder Pool",
                vaultAddress: "0x0000000000000000000000000000000000000000",
                poolAddress: "0x0000000000000000000000000000000000000000",
                fasset: fassetList[0] ?? "",
                collateralSymbol: "",
                tvl: "0",
                rewardsPaid: "0",
                url: "",
                tvlDiff: "0",
                tvlDiffPositive: true,
                rewardsDiff: "0",
                rewardsDiffPositive: true,
            },
        ];
        // Build the unified ecosystem TVL series once per refresh: a fixed window
        // spanning [2025-05-01, now] with TVL_GRAPH_POINTS evenly-spaced points.
        // This same series is returned for tvlGraph regardless of the timespan
        // requested by the controller, so we compute and cache it before the loop.
        const nowTs = Math.floor(Date.now() / 1000);
        const tvlStart = TimeDataService.TVL_GRAPH_START_TS;
        const tvlPoints = TimeDataService.TVL_GRAPH_POINTS;
        const unifiedTvlTimestamps: string[] = [];
        const unifiedStep = (nowTs - tvlStart) / (tvlPoints - 1);
        for (let j = 0; j < tvlPoints; j++) {
            unifiedTvlTimestamps.push(Math.round(tvlStart + j * unifiedStep).toString());
        }
        const unifiedPointTVL = await this.externalApiService.getFassetTVLTimespan(unifiedTvlTimestamps);
        // If the external API failed (or returned an empty payload) we DO NOT overwrite
        // the existing cache: a stale-but-real series is preferable to clobbering it
        // with zeros. We still need a value for downstream timeData.tvlGraph below, so
        // we fall back to the previously cached graph (or a single-point placeholder).
        const unifiedTvlApiFailed = isEmptyObject(unifiedPointTVL) || unifiedPointTVL == 0 || unifiedPointTVL.length == 0;
        let unifiedTvlGraph: TimeSeries[];
        if (unifiedTvlApiFailed) {
            logger.warn("getFassetTVLTimespan returned empty/failed result; keeping previously cached tvlGraphData.");
            const cachedTvl = await this.cacheManager.get<TimeSeries[]>("tvlGraphData");
            unifiedTvlGraph = cachedTvl ?? [{ timestamp: nowTs, value: "0" }];
        } else {
            unifiedTvlGraph = formatTimespanToTimeseries(unifiedPointTVL);
            await this.cacheManager.set("tvlGraphData", unifiedTvlGraph, 0);
        }
        for (let i = 0; i <= 5; i++) {
            let timeScopeAPI;
            let timeScopeTime;
            let n;
            switch (i) {
                case 0:
                    timeScopeAPI = "day";
                    timeScopeTime = 24 * 60 * 60;
                    n = 12;
                    break;
                case 1:
                    timeScopeAPI = "week";
                    timeScopeTime = 7 * 24 * 60 * 60;
                    n = 7;
                    break;
                case 2:
                    timeScopeAPI = "month";
                    timeScopeTime = 30 * 24 * 60 * 60;
                    n = 12;
                    break;
                case 3:
                    timeScopeAPI = "year";
                    timeScopeTime = 365 * 24 * 60 * 60;
                    n = 8;
                    break;
                case 4:
                    timeScopeAPI = "yearToDate";
                    const now = new Date();
                    const startOfYear = new Date(now.getFullYear(), 0, 1);
                    timeScopeTime = Math.floor((Date.now() - startOfYear.getTime()) / 1000);
                    n = 18;
                    break;
                case 5:
                    timeScopeAPI = "allTime";
                    timeScopeTime = 5 * 365 * 24 * 60 * 60;
                    n = 18;
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
            // Static placeholder for supplyDiff — real per-fasset supply diff computation
            // has been removed. Response shape preserved so FE consumers keep working.
            const placeholderSupplyDiff = fassetList.map((f) => ({ fasset: f, diff: "0", isPositive: true }));
            const pointMint = await this.externalApiService.getMintTimeseries(now, n, dayTimestamp);
            const pointMintFailed = isEmptyObject(pointMint) || pointMint == 0 || pointMint.length == 0;
            const pointRedeem = await this.externalApiService.getRedeemTimeseries(now, n, dayTimestamp);
            const pointRedeemFailed = isEmptyObject(pointRedeem) || pointRedeem == 0 || pointRedeem.length == 0;
            // If either external call failed, skip writing this scope's cache so that
            // the previous (real) cached payload is not clobbered with zeros.
            if (pointMintFailed || pointRedeemFailed) {
                logger.warn(
                    `External API failed for time scope "${timeScopeAPI}" (mintFailed=${pointMintFailed}, redeemFailed=${pointRedeemFailed}); keeping previous cache.`
                );
                continue;
            }
            const graphMints = formatTimeSeries(pointMint);
            const graphRedeems = formatTimeSeries(pointRedeem);
            // Static placeholders — totalCollateralDiff / coreVault inflow/outflow graphs
            // and diffs are no longer computed. Response shape preserved for FE.
            const placeholderTotalCollateralDiff = { diff: "0", isPositive: true };
            const placeholderCvInflowGraph: TimeSeries[] = [{ timestamp: now, value: "0" }];
            const placeholderCvOutflowGraph: TimeSeries[] = [{ timestamp: now, value: "0" }];
            const placeholderCvTvlGraph: TimeSeries[] = [{ timestamp: now, value: "0" }];
            const placeholderCvSupplyDiff = { diff: "0", isPositive: true };
            const placeholderInflowsDiff = { diff: "0", isPositive: true };
            const placeholderOutflowsDiff = { diff: "0", isPositive: true };
            // Static placeholder for proofOfReserve — external CV-ratio timeseries
            // computation has been removed. Response shape preserved for FE.
            const placeholderProofOfReserve: TimeSeries[] = [{ timestamp: now, value: "0" }];
            const coreVaultData: TimeDataCV = {
                supplyDiff: placeholderCvSupplyDiff.diff,
                isPositiveSupplyDiff: placeholderCvSupplyDiff.isPositive,
                inflowGraph: placeholderCvInflowGraph,
                outflowGraph: placeholderCvOutflowGraph,
                inflowDiff: placeholderInflowsDiff.diff,
                isPositiveInflowDiff: placeholderInflowsDiff.isPositive,
                outflowDiff: placeholderOutflowsDiff.diff,
                isPositiveOutflowDiff: placeholderOutflowsDiff.isPositive,
                tvlGraph: placeholderCvTvlGraph,
            };
            const timeData: TimeData = {
                supplyDiff: placeholderSupplyDiff,
                mintGraph: graphMints,
                redeemGraph: graphRedeems,
                tvlGraph: unifiedTvlGraph,
                bestPools: placeholderBestPools,
                totalCollateralDiff: placeholderTotalCollateralDiff.diff,
                isPositiveCollateralDiff: placeholderTotalCollateralDiff.isPositive,
                coreVaultData: coreVaultData,
                proofOfReserve: placeholderProofOfReserve,
            };
            await this.cacheManager.set(timeScopeAPI + "Data", timeData, 0);
        }
        logger.info("Finished updating time data");
    }
}
