import { FassetSupplyDiff, FassetTimeSupply, GenericDiff, PoolCollateralDiff, TimeSeries, TimeSeriesIndexer, TimeSpan } from "src/interfaces/structure";
import { NETWORK_SYMBOLS } from "./constants";
import { formatFixed, toBN } from "@flarelabs/fasset-bots-core/utils";

export function calculateFassetSupplyDiff(supply: any, fassetList: string[], envType: string): FassetSupplyDiff[] {
    //TODO fix test, production
    const diffs: FassetSupplyDiff[] = [];
    for (const f of fassetList) {
        if (f.includes("DOGE")) {
            continue;
        }
        const netw = NETWORK_SYMBOLS.find((item) => (envType == "dev" ? item.test : item.real) === f);
        if (supply[netw.real]) {
            const data = supply[netw.real];
            const diff = Number(data[1].value) - Number(data[0].value);
            const percentage = Number(data[0].value) == 0 ? 100 : (diff / Number(data[0].value)) * 100;
            const n = envType == "dev" ? netw.test : netw.real;
            diffs.push({ fasset: n, diff: Math.abs(percentage).toFixed(1), isPositive: diff >= 0 });
        } else {
            diffs.push({ fasset: f, diff: "100.0", isPositive: true });
        }
    }
    return diffs;
}

export function calculateInflowsOutflowsDiff(supply: any): GenericDiff {
    //TODO fix test, production
    let diffs: GenericDiff;
    if (supply["FXRP"]) {
        const data = supply["FXRP"];
        const diff = Number(data[1].value) - Number(data[0].value);
        const percentage = Number(data[0].value) == 0 ? 100 : (diff / Number(data[0].value)) * 100;
        diffs = { diff: Math.abs(percentage).toFixed(1), isPositive: diff >= 0 };
    } else {
        diffs = { diff: "100.0", isPositive: true };
    }
    return diffs;
}

export function generateTimestamps(from: number, to: number, points: number): string {
    const step = (to - from) / (points - 1);
    let timestamps = "";
    for (let i = 0; i < points; i++) {
        const value = Math.round(from + i * step).toString();
        timestamps += (i === 0 ? "timestamps=" : "&timestamps=") + value;
    }

    return timestamps;
}

export function isEmptyObject(obj: unknown): boolean {
    return typeof obj === "object" && obj !== null && Object.keys(obj).length === 0;
}

export function calculatePoolRewardsDiff(rewards: any): PoolCollateralDiff {
    const v0 = BigInt(rewards[0].value);
    const v1 = BigInt(rewards[1].value);
    const diff = v1 - v0;
    const percentage = v0 === 0n ? 100 : Number((diff * 10000n) / v0) / 100;
    return {
        diff: percentage.toFixed(2),
        isPositive: diff >= 0n,
    };
}

export function calculatePoolCollateralDiff(rewards: FassetTimeSupply[]): PoolCollateralDiff {
    const v0 = BigInt(rewards[0].value);
    const v1 = BigInt(rewards[1].value);
    const diff = v1 - v0;
    const percentage = v0 === 0n ? 100 : Number((diff * 10000n) / v0) / 100;
    return {
        diff: percentage.toFixed(2),
        isPositive: diff >= 0n,
    };
}

export function formatTimeSeries(data: TimeSeriesIndexer[]): TimeSeries[] {
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

export function formatTimeSeriesPercentage(data: TimeSeriesIndexer[]): TimeSeries[] {
    const timeSeries: TimeSeries[] = [];
    for (let i = 0; i < data.length; i++) {
        timeSeries.push({ timestamp: Math.floor(data[i].end), value: data[i].value });
    }
    return timeSeries;
}

export function formatTimeSpanRatio(data: TimeSpan[]): TimeSeries[] {
    const timeSeries: TimeSeries[] = [];
    if (!data) {
        timeSeries.push({ timestamp: 1757064665, value: "100" });
        return timeSeries;
    }
    for (let i = 0; i < data.length; i++) {
        timeSeries.push({
            timestamp: Math.floor(data[i].timestamp),
            value: data[i].value === 0 || data[i].value < 1 ? "100" : (data[i].value * 100).toFixed(0),
        });
    }
    return timeSeries;
}

export function formatTimespanToTimeseries(data: FassetTimeSupply[]): TimeSeries[] {
    const timeSeries: TimeSeries[] = [];
    for (let i = 0; i < data.length; i++) {
        const valueUSD = formatFixed(toBN(data[i].value), 8, {
            decimals: 3,
            groupDigits: true,
            groupSeparator: ",",
        });
        timeSeries.push({ timestamp: Math.floor(data[i].timestamp), value: valueUSD });
    }
    return timeSeries;
}
