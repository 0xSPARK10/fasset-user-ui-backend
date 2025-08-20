import { BNish, toBN } from "@flarelabs/fasset-bots-core/utils";
import BN from "bn.js";
import { AMG_TOKENWEI_PRICE_SCALE, AMGSettings } from "@flarelabs/fasset-bots-core";

export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dateStringToTimestamp(dateString: string): number {
    return Math.floor(new Date(dateString).getTime() / 1000);
}

export function timestampToDateString(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
}

export function convertAmgToUBA(settings: AMGSettings, valueAMG: BNish) {
    return toBN(valueAMG).mul(toBN(settings.assetMintingGranularityUBA));
}

export function formatBNToDisplayDecimals(bn: BN, displayDecimals: number, baseUnitDecimals: number): string {
    const baseUnitStr = bn.toString(10);
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

    const formattedNumber = fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;

    return formattedNumber;
}

export function convertTokenWeiToAMG(valueNATWei: BNish, amgToTokenWeiPrice: BNish) {
    return toBN(valueNATWei).mul(AMG_TOKENWEI_PRICE_SCALE).div(toBN(amgToTokenWeiPrice));
}

export function convertTokenWeiToUBA(settings: AMGSettings, valueWei: BNish, amgToNATWeiPrice: BNish) {
    return this.convertAmgToUBA(settings, this.convertTokenWeiToAMG(valueWei, amgToNATWeiPrice));
}

//convert USD string to BN
export function usdStringToBN(value: string): BN {
    const sanitizedValue = value.replace(/,/g, "");
    const [integerPart, decimalPart = ""] = sanitizedValue.split(".");
    return new BN(integerPart + decimalPart.padEnd(3, "0"), 10);
}

//convert BN back to a USD string
export function bnToUsdString(bn: BN): string {
    const bnString = bn.toString();
    const integerPart = bnString.slice(0, -3) || "0";
    const decimalPart = bnString.slice(-3).padEnd(3, "0");

    // Add commas for thousands in integer part
    const formattedIntegerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${formattedIntegerPart}.${decimalPart}`;
}

// sum two USD strings
export function sumUsdStrings(usd1: string, usd2: string): string {
    const bn1 = usdStringToBN(usd1);
    const bn2 = usdStringToBN(usd2);

    const totalBN = bn1.add(bn2);

    return bnToUsdString(totalBN);
}

export function calculateOvercollateralizationPercentage(collateral: string, minted: string): string | null {
    // Helper function to clean and parse the USD value
    const parseUSDValue = (value: string): number => {
        // Remove commas and convert to number
        const cleanedValue = value.replace(/,/g, "");
        return parseFloat(cleanedValue);
    };

    // Parse the input values
    const totalCollateral = parseUSDValue(collateral);
    const mintedValue = parseUSDValue(minted);

    // Check if mintedValue is zero to avoid division by zero
    if (mintedValue === 0) {
        console.error("Minted value cannot be zero.");
        return "0"; // or throw an error based on your requirements
    }

    // Calculate the overcollateralization percentage
    const overcollateralizationPercentage = (totalCollateral / mintedValue) * 100;

    // Return the result formatted as a string with two decimal places
    return overcollateralizationPercentage.toFixed(2);
}
