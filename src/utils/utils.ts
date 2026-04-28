import { TimeData } from "src/interfaces/structure";
import { TimeDataCV } from "src/interfaces/requestResponse";

/** Replacement for AMGSettings from fasset-bots-core */
export interface AMGSettings {
    assetMintingGranularityUBA: bigint;
}

/** AMG_TOKENWEI_PRICE_SCALE = 10^9 */
const AMG_TOKENWEI_PRICE_SCALE = 10n ** 9n;

export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dateStringToTimestamp(dateString: string): number {
    return Math.floor(new Date(dateString).getTime() / 1000);
}

export function timestampToDateString(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
}

export function convertAmgToUBA(settings: AMGSettings, valueAMG: bigint | string | number): bigint {
    return BigInt(valueAMG) * settings.assetMintingGranularityUBA;
}

export function convertTokenWeiToAMG(valueNATWei: bigint | string | number, amgToTokenWeiPrice: bigint | string | number): bigint {
    return (BigInt(valueNATWei) * AMG_TOKENWEI_PRICE_SCALE) / BigInt(amgToTokenWeiPrice);
}

export function convertTokenWeiToUBA(settings: AMGSettings, valueWei: bigint | string | number, amgToNATWeiPrice: bigint | string | number): bigint {
    return convertAmgToUBA(settings, convertTokenWeiToAMG(valueWei, amgToNATWeiPrice));
}

// Convert USD string (with commas and 3 decimal places) to bigint scaled by 1000
function usdStringToBigInt(value: string): bigint {
    const sanitizedValue = value.replace(/,/g, "");
    const [integerPart, decimalPart = ""] = sanitizedValue.split(".");
    return BigInt(integerPart + decimalPart.padEnd(3, "0"));
}

// Convert bigint (scaled by 1000) back to a USD string
function bigintToUsdString(value: bigint): string {
    const str = value.toString();
    const integerPart = str.slice(0, -3) || "0";
    const decimalPart = str.slice(-3).padEnd(3, "0");
    const formattedIntegerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${formattedIntegerPart}.${decimalPart}`;
}

// sum two USD strings
export function sumUsdStrings(usd1: string, usd2: string): string {
    const v1 = usdStringToBigInt(usd1);
    const v2 = usdStringToBigInt(usd2);
    return bigintToUsdString(v1 + v2);
}

export function calculateOvercollateralizationPercentage(collateral: string, minted: string): string | null {
    const parseUSDValue = (value: string): number => {
        // Remove commas and convert to number
        const cleanedValue = value.replace(/,/g, "");
        return parseFloat(cleanedValue);
    };
    const totalCollateral = parseUSDValue(collateral);
    const mintedValue = parseUSDValue(minted);
    if (mintedValue === 0) {
        console.error("Minted value cannot be zero.");
        return "0";
    }

    // Calculate the overcollateralization percentage
    const overcollateralizationPercentage = (totalCollateral / mintedValue) * 100;
    return overcollateralizationPercentage.toFixed(2);
}


export function isValidWalletAddress(address: string): boolean {
    if (!address || typeof address !== "string") return false;
    const evmRegex = /^0x[a-fA-F0-9]{40}$/;
    if (evmRegex.test(address)) return true;
    const xrpRegex = /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/;
    if (xrpRegex.test(address)) return true;

    return false;
}

export function getDefaultTimeData(fasset: string): TimeData {
    const now = Math.floor(Date.now() / 1000);
    const defaultTimeData: TimeDataCV = {
        supplyDiff: "0",
        isPositiveSupplyDiff: true,
        inflowGraph: [{ timestamp: now, value: "0" }],
        outflowGraph: [{ timestamp: now, value: "0" }],
        inflowDiff: "0",
        isPositiveInflowDiff: true,
        outflowDiff: "0",
        isPositiveOutflowDiff: true,
        tvlGraph: [{ timestamp: now, value: "0" }],
    };
    return {
        supplyDiff: [{ fasset: fasset, diff: "0", isPositive: true }],
        mintGraph: [{ timestamp: now, value: "0" }],
        redeemGraph: [{ timestamp: now, value: "0" }],
        bestPools: [],
        totalCollateralDiff: "0",
        isPositiveCollateralDiff: true,
        coreVaultData: defaultTimeData,
        proofOfReserve: [{ timestamp: now, value: "0" }],
    };
}


export function calculateExpirationMinutes(lastUnderlyingTimestamp: string): string {
    const t = Number(lastUnderlyingTimestamp);
    const now = Math.floor(Date.now() / 1000);
    if (now >= t || t - now <= 60) {
        return String(1);
    }
    return String(Math.floor((t - now) / 60));
}

// ─── bigint helpers (ethers / pool.service refactor) ────────────────────────

/**
 * 10n ** BigInt(exp) – replacement for toBNExp(1, exp)
 */
export function bigintPow10(exp: number): bigint {
    return 10n ** BigInt(exp);
}

/**
 * Format a bigint fixed-point value into a human-readable string.
 * Equivalent to the old fasset-bots-core `formatFixed(bn, decimals, opts)`.
 */
export function formatFixedBigInt(value: bigint, baseUnitDecimals: number, opts: { decimals: number; groupDigits?: boolean; groupSeparator?: string }): string {
    const isNegative = value < 0n;
    const abs = isNegative ? -value : value;
    const str = abs.toString();

    let integerPart: string;
    let fractionalPart: string;

    if (str.length > baseUnitDecimals) {
        integerPart = str.slice(0, str.length - baseUnitDecimals);
        fractionalPart = str.slice(str.length - baseUnitDecimals);
    } else {
        integerPart = "0";
        fractionalPart = str.padStart(baseUnitDecimals, "0");
    }

    fractionalPart = fractionalPart.slice(0, opts.decimals).padEnd(opts.decimals, "0");
    // trim trailing zeros after dot
    fractionalPart = fractionalPart.replace(/0+$/, "");

    if (opts.groupDigits) {
        const sep = opts.groupSeparator ?? ",";
        integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    }

    const sign = isNegative ? "-" : "";
    return fractionalPart ? `${sign}${integerPart}.${fractionalPart}` : `${sign}${integerPart}`;
}

/**
 * bigint version of `formatBNToDisplayDecimals`.
 * Formats a bigint value with fixed-point decimals for display.
 */
export function formatBigIntToDisplayDecimals(value: bigint, displayDecimals: number, baseUnitDecimals: number): string {
    const baseUnitStr = value.toString();
    let integerPart = "0";
    let fractionalPart = baseUnitStr;

    if (baseUnitStr.length > baseUnitDecimals) {
        integerPart = baseUnitStr.slice(0, baseUnitStr.length - baseUnitDecimals);
        fractionalPart = baseUnitStr.slice(baseUnitStr.length - baseUnitDecimals);
    } else {
        fractionalPart = baseUnitStr.padStart(baseUnitDecimals, "0");
    }
    fractionalPart = fractionalPart.slice(0, displayDecimals).padEnd(displayDecimals, "0");
    fractionalPart = fractionalPart.replace(/\.?0+$/, "");
    integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

    return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}

/**
 * bigint version of `calculateUSDValue`.
 * Returns a formatted USD string.
 */
export function calculateUSDValueBigInt(amount: bigint, price: bigint, priceDecimals: number, assetDecimals: number, formatDecimals: number): string {
    const amountUSD = (amount * price) / bigintPow10(priceDecimals);
    return formatFixedBigInt(amountUSD, assetDecimals, {
        decimals: formatDecimals,
        groupDigits: true,
        groupSeparator: ",",
    });
}

/**
 * bigint version of `toBNDecimal`.
 * Converts a decimal number (string or number) to a bigint scaled by `decimals` places.
 * Example: toBNDecimalBigInt(1.003, 10) => 10030000000n
 */
export function toBNDecimalBigInt(value: string | number, decimals = 10): bigint {
    const [whole, fraction = "0"] = value.toString().split(".");
    const fractionPadded = fraction.padEnd(decimals, "0").slice(0, decimals);
    return BigInt(whole + fractionPadded);
}

/**
 * bigint version of `formatBNToStringForceDecimals`.
 * Display `displayDecimals` fractional digits; if all are zero it only shows 2.
 */
export function formatBigIntToStringForceDecimals(value: bigint, displayDecimals: number, baseUnitDecimals: number): string {
    const baseUnitStr = value.toString();

    let integerPart = "0";
    let fractionalPart = "";

    if (baseUnitStr.length > baseUnitDecimals) {
        integerPart = baseUnitStr.slice(0, baseUnitStr.length - baseUnitDecimals);
        fractionalPart = baseUnitStr.slice(baseUnitStr.length - baseUnitDecimals);
    } else {
        fractionalPart = baseUnitStr.padStart(baseUnitDecimals, "0");
    }
    fractionalPart = fractionalPart.padEnd(baseUnitDecimals, "0");
    const fullFraction = fractionalPart.slice(0, displayDecimals);

    const isAllZero = /^0+$/.test(fullFraction);

    let displayFraction: string;

    if (isAllZero && displayDecimals > 2) {
        displayFraction = "00";
    } else {
        displayFraction = fullFraction.padEnd(displayDecimals, "0");
    }
    integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

    if (displayFraction.length > 0) {
        return `${integerPart}.${displayFraction}`;
    }

    return integerPart;
}
