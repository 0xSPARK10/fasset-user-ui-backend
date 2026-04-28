import {
    sleep,
    dateStringToTimestamp,
    timestampToDateString,
    convertAmgToUBA,
    convertTokenWeiToAMG,
    convertTokenWeiToUBA,
    sumUsdStrings,
    calculateOvercollateralizationPercentage,
    isValidWalletAddress,
    getDefaultTimeData,
    calculateExpirationMinutes,
    bigintPow10,
    formatFixedBigInt,
    formatBigIntToDisplayDecimals,
    calculateUSDValueBigInt,
    toBNDecimalBigInt,
    formatBigIntToStringForceDecimals,
    AMGSettings,
} from "src/utils/utils";

// ─── sleep ──────────────────────────────────────────────────────────────────

describe("sleep", () => {
    it("should resolve after the specified delay", async () => {
        const start = Date.now();
        await sleep(50);
        const elapsed = Date.now() - start;
        // Allow a tolerance of 30 ms for timer imprecision
        expect(elapsed).toBeGreaterThanOrEqual(40);
        expect(elapsed).toBeLessThan(200);
    });

    it("should resolve immediately when ms is 0", async () => {
        const start = Date.now();
        await sleep(0);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(50);
    });

    it("should return a Promise<void>", async () => {
        const result = await sleep(1);
        expect(result).toBeUndefined();
    });
});

// ─── dateStringToTimestamp ──────────────────────────────────────────────────

describe("dateStringToTimestamp", () => {
    it("should convert a standard ISO date string to a Unix timestamp in seconds", () => {
        // 2024-01-01T00:00:00.000Z => 1704067200
        const ts = dateStringToTimestamp("2024-01-01T00:00:00.000Z");
        expect(ts).toBe(1704067200);
    });

    it("should handle a date with time component", () => {
        // 2024-06-15T12:30:45.000Z
        const expected = Math.floor(new Date("2024-06-15T12:30:45.000Z").getTime() / 1000);
        expect(dateStringToTimestamp("2024-06-15T12:30:45.000Z")).toBe(expected);
    });

    it("should handle the Unix epoch", () => {
        expect(dateStringToTimestamp("1970-01-01T00:00:00.000Z")).toBe(0);
    });

    it("should handle dates before epoch (negative timestamp)", () => {
        const ts = dateStringToTimestamp("1969-12-31T23:59:00.000Z");
        expect(ts).toBe(-60);
    });

    it("should handle a date-only string (no time component)", () => {
        // "2024-01-01" is treated as UTC midnight by the Date constructor
        const ts = dateStringToTimestamp("2024-01-01");
        expect(ts).toBe(1704067200);
    });

    it("should return NaN for an invalid date string", () => {
        const ts = dateStringToTimestamp("not-a-date");
        expect(ts).toBeNaN();
    });
});

// ─── timestampToDateString ──────────────────────────────────────────────────

describe("timestampToDateString", () => {
    it("should convert a Unix timestamp to an ISO string", () => {
        expect(timestampToDateString(1704067200)).toBe("2024-01-01T00:00:00.000Z");
    });

    it("should handle the Unix epoch (0)", () => {
        expect(timestampToDateString(0)).toBe("1970-01-01T00:00:00.000Z");
    });

    it("should handle negative timestamps (before epoch)", () => {
        expect(timestampToDateString(-60)).toBe("1969-12-31T23:59:00.000Z");
    });

    it("should round-trip with dateStringToTimestamp", () => {
        const original = "2024-06-15T12:30:45.000Z";
        const ts = dateStringToTimestamp(original);
        expect(timestampToDateString(ts)).toBe(original);
    });
});

// ─── convertAmgToUBA ────────────────────────────────────────────────────────

describe("convertAmgToUBA", () => {
    const settings: AMGSettings = { assetMintingGranularityUBA: 100n };

    it("should multiply valueAMG by assetMintingGranularityUBA (bigint input)", () => {
        expect(convertAmgToUBA(settings, 5n)).toBe(500n);
    });

    it("should accept a string valueAMG", () => {
        expect(convertAmgToUBA(settings, "10")).toBe(1000n);
    });

    it("should accept a number valueAMG", () => {
        expect(convertAmgToUBA(settings, 3)).toBe(300n);
    });

    it("should return 0n when valueAMG is 0", () => {
        expect(convertAmgToUBA(settings, 0n)).toBe(0n);
    });

    it("should handle very large values", () => {
        const bigSettings: AMGSettings = { assetMintingGranularityUBA: 10n ** 18n };
        const result = convertAmgToUBA(bigSettings, 10n ** 18n);
        expect(result).toBe(10n ** 36n);
    });

    it("should handle granularity of 1", () => {
        const settings1: AMGSettings = { assetMintingGranularityUBA: 1n };
        expect(convertAmgToUBA(settings1, 42n)).toBe(42n);
    });
});

// ─── convertTokenWeiToAMG ───────────────────────────────────────────────────

describe("convertTokenWeiToAMG", () => {
    it("should compute (valueNATWei * 10^9) / amgToTokenWeiPrice", () => {
        // 1_000_000_000 * 10^9 / 1_000_000_000 = 10^9
        const result = convertTokenWeiToAMG(1_000_000_000n, 1_000_000_000n);
        expect(result).toBe(1_000_000_000n);
    });

    it("should accept string inputs", () => {
        const result = convertTokenWeiToAMG("2000000000", "1000000000");
        expect(result).toBe(2_000_000_000n);
    });

    it("should accept number inputs", () => {
        const result = convertTokenWeiToAMG(1000000000, 1000000000);
        expect(result).toBe(1_000_000_000n);
    });

    it("should return 0n when valueNATWei is 0", () => {
        expect(convertTokenWeiToAMG(0n, 1000n)).toBe(0n);
    });

    it("should perform integer division (truncation)", () => {
        // 1 * 10^9 / 3 = 333333333n (truncated)
        const result = convertTokenWeiToAMG(1n, 3n);
        expect(result).toBe(333333333n);
    });

    it("should handle very large values without overflow", () => {
        const large = 10n ** 30n;
        const price = 10n ** 15n;
        // large * 10^9 / price = 10^30 * 10^9 / 10^15 = 10^24
        const result = convertTokenWeiToAMG(large, price);
        expect(result).toBe(10n ** 24n);
    });
});

// ─── convertTokenWeiToUBA ───────────────────────────────────────────────────

describe("convertTokenWeiToUBA", () => {
    const settings: AMGSettings = { assetMintingGranularityUBA: 100n };

    it("should combine convertTokenWeiToAMG and convertAmgToUBA", () => {
        // convertTokenWeiToAMG(1_000_000_000, 1_000_000_000) = 10^9
        // convertAmgToUBA(settings, 10^9) = 10^9 * 100 = 10^11
        const result = convertTokenWeiToUBA(settings, 1_000_000_000n, 1_000_000_000n);
        expect(result).toBe(100_000_000_000n);
    });

    it("should return 0n when valueWei is 0", () => {
        expect(convertTokenWeiToUBA(settings, 0n, 1000n)).toBe(0n);
    });

    it("should accept string inputs", () => {
        const result = convertTokenWeiToUBA(settings, "1000000000", "1000000000");
        expect(result).toBe(100_000_000_000n);
    });
});

// ─── sumUsdStrings ──────────────────────────────────────────────────────────

describe("sumUsdStrings", () => {
    it("should add two simple USD strings", () => {
        expect(sumUsdStrings("1.000", "2.000")).toBe("3.000");
    });

    it("should handle strings with commas in the integer part", () => {
        expect(sumUsdStrings("1,234.567", "2,345.678")).toBe("3,580.245");
    });

    it("should handle zero values", () => {
        expect(sumUsdStrings("0.000", "0.000")).toBe("0.000");
    });

    it("should handle one zero operand", () => {
        expect(sumUsdStrings("1,000.500", "0.000")).toBe("1,000.500");
    });

    it("should add up to large values with commas in the result", () => {
        expect(sumUsdStrings("999,999.999", "0.001")).toBe("1,000,000.000");
    });

    it("should handle values with no decimal part", () => {
        // When no decimal part exists, padEnd fills with "000"
        expect(sumUsdStrings("100", "200")).toBe("300.000");
    });

    it("should handle values with partial decimals (fewer than 3 digits)", () => {
        // "1.5" => decimal part "5" padded to "500"
        expect(sumUsdStrings("1.5", "2.5")).toBe("4.000");
    });

    it("should handle very large sums", () => {
        const result = sumUsdStrings("999,999,999.999", "1.001");
        expect(result).toBe("1,000,000,001.000");
    });
});

// ─── calculateOvercollateralizationPercentage ───────────────────────────────

describe("calculateOvercollateralizationPercentage", () => {
    it("should calculate (collateral / minted) * 100 with 2 decimal places", () => {
        expect(calculateOvercollateralizationPercentage("200.000", "100.000")).toBe("200.00");
    });

    it("should handle comma-formatted inputs", () => {
        expect(calculateOvercollateralizationPercentage("2,000.000", "1,000.000")).toBe("200.00");
    });

    it("should return '0' when minted is zero", () => {
        expect(calculateOvercollateralizationPercentage("100.000", "0")).toBe("0");
    });

    it("should handle collateral less than minted", () => {
        expect(calculateOvercollateralizationPercentage("50.000", "100.000")).toBe("50.00");
    });

    it("should handle equal collateral and minted", () => {
        expect(calculateOvercollateralizationPercentage("100.000", "100.000")).toBe("100.00");
    });

    it("should handle very large ratios", () => {
        const result = calculateOvercollateralizationPercentage("1,000,000.000", "1.000");
        expect(result).toBe("100000000.00");
    });

    it("should handle fractional ratios correctly", () => {
        // 1 / 3 * 100 = 33.33...
        expect(calculateOvercollateralizationPercentage("1.000", "3.000")).toBe("33.33");
    });

    it("should return '0' when minted is '0.000'", () => {
        expect(calculateOvercollateralizationPercentage("500.000", "0.000")).toBe("0");
    });
});

// ─── isValidWalletAddress ───────────────────────────────────────────────────

describe("isValidWalletAddress", () => {
    // Valid EVM addresses
    it("should return true for a valid EVM address (all lowercase hex)", () => {
        expect(isValidWalletAddress("0x0048508b510502555ed47e98de98dd6426ddd0c4")).toBe(true);
    });

    it("should return true for a valid EVM address (mixed case)", () => {
        expect(isValidWalletAddress("0x0048508b510502555ED47E98dE98Dd6426dDd0C4")).toBe(true);
    });

    it("should return true for a valid EVM address (all uppercase hex)", () => {
        expect(isValidWalletAddress("0xABCDEF0123456789ABCDEF0123456789ABCDEF01")).toBe(true);
    });

    // Invalid EVM addresses
    it("should return false for an EVM address with 39 hex chars", () => {
        expect(isValidWalletAddress("0x0048508b510502555ED47E98dE98Dd6426dDd0C")).toBe(false);
    });

    it("should return false for an EVM address with 41 hex chars", () => {
        expect(isValidWalletAddress("0x0048508b510502555ED47E98dE98Dd6426dDd0C4A")).toBe(false);
    });

    it("should return false for an EVM address with invalid hex chars", () => {
        expect(isValidWalletAddress("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG")).toBe(false);
    });

    it("should return false for an EVM address without 0x prefix", () => {
        expect(isValidWalletAddress("0048508b510502555ED47E98dE98Dd6426dDd0C4")).toBe(false);
    });

    // Valid XRP addresses
    it("should return true for a valid XRP address (25 chars after r)", () => {
        // 'r' + 25 alphanumeric chars (no 0, O, I, l)
        expect(isValidWalletAddress("r1234567891234567891234567")).toBe(true);
    });

    it("should return true for a valid XRP address (35 chars after r)", () => {
        // XRP addresses exclude 0, O, I, l - use only valid chars (35 after r)
        expect(isValidWalletAddress("rabcdefghijkmnpqrstuvwxyzABCDEFGHJKN")).toBe(true);
    });

    it("should return true for a typical XRP address", () => {
        expect(isValidWalletAddress("rN7n3473SaZBCG4dFL83w7p1W9cgPJKpao")).toBe(true);
    });

    // Invalid XRP addresses
    it("should return false for an XRP address that is too short (24 chars after r)", () => {
        expect(isValidWalletAddress("r123456789112345678912345")).toBe(false);
    });

    it("should return false for an XRP address that is too long (36 chars after r)", () => {
        expect(isValidWalletAddress("rabcdefghijkmnpqrstuvwxyzABCDEFGHIJKL")).toBe(false);
    });

    it("should return false for an XRP address containing 0 (ambiguous char)", () => {
        // The regex excludes '0', 'O', 'I', 'l' per base58 ripple alphabet
        expect(isValidWalletAddress("r0bcdefghijkmnpqrstuvwxyzABC")).toBe(false);
    });

    it("should return false for an XRP address containing 'O'", () => {
        expect(isValidWalletAddress("rObcdefghijkmnpqrstuvwxyzABC")).toBe(false);
    });

    it("should return false for an XRP address containing 'I'", () => {
        expect(isValidWalletAddress("rIbcdefghijkmnpqrstuvwxyzABC")).toBe(false);
    });

    it("should return false for an XRP address containing 'l'", () => {
        expect(isValidWalletAddress("rlbcdefghijkmnpqrstuvwxyzABC")).toBe(false);
    });

    // Edge cases
    it("should return false for an empty string", () => {
        expect(isValidWalletAddress("")).toBe(false);
    });

    it("should return false for null coerced to any", () => {
        expect(isValidWalletAddress(null as any)).toBe(false);
    });

    it("should return false for undefined coerced to any", () => {
        expect(isValidWalletAddress(undefined as any)).toBe(false);
    });

    it("should return false for a random string", () => {
        expect(isValidWalletAddress("hello-world")).toBe(false);
    });

    it("should return false for a number coerced to any", () => {
        expect(isValidWalletAddress(12345 as any)).toBe(false);
    });
});

// ─── getDefaultTimeData ─────────────────────────────────────────────────────

describe("getDefaultTimeData", () => {
    it("should return a TimeData object with the provided fasset name", () => {
        const data = getDefaultTimeData("FTestXRP");
        expect(data.supplyDiff).toHaveLength(1);
        expect(data.supplyDiff[0].fasset).toBe("FTestXRP");
        expect(data.supplyDiff[0].diff).toBe("0");
        expect(data.supplyDiff[0].isPositive).toBe(true);
    });

    it("should have mintGraph and redeemGraph each with a single entry at value '0'", () => {
        const data = getDefaultTimeData("FBTC");
        expect(data.mintGraph).toHaveLength(1);
        expect(data.mintGraph[0].value).toBe("0");
        expect(data.redeemGraph).toHaveLength(1);
        expect(data.redeemGraph[0].value).toBe("0");
    });

    it("should have an empty bestPools array", () => {
        const data = getDefaultTimeData("FBTC");
        expect(data.bestPools).toEqual([]);
    });

    it("should have totalCollateralDiff of '0' and isPositiveCollateralDiff true", () => {
        const data = getDefaultTimeData("FBTC");
        expect(data.totalCollateralDiff).toBe("0");
        expect(data.isPositiveCollateralDiff).toBe(true);
    });

    it("should include coreVaultData with default zero values", () => {
        const data = getDefaultTimeData("FBTC");
        const cv = data.coreVaultData;
        expect(cv.supplyDiff).toBe("0");
        expect(cv.isPositiveSupplyDiff).toBe(true);
        expect(cv.inflowGraph).toHaveLength(1);
        expect(cv.inflowGraph[0].value).toBe("0");
        expect(cv.outflowGraph).toHaveLength(1);
        expect(cv.outflowGraph[0].value).toBe("0");
        expect(cv.inflowDiff).toBe("0");
        expect(cv.isPositiveInflowDiff).toBe(true);
        expect(cv.outflowDiff).toBe("0");
        expect(cv.isPositiveOutflowDiff).toBe(true);
        expect(cv.tvlGraph).toHaveLength(1);
        expect(cv.tvlGraph[0].value).toBe("0");
    });

    it("should include proofOfReserve with a single zero entry", () => {
        const data = getDefaultTimeData("FBTC");
        expect(data.proofOfReserve).toHaveLength(1);
        expect(data.proofOfReserve[0].value).toBe("0");
    });

    it("should set timestamps close to now (within 5 seconds)", () => {
        const now = Math.floor(Date.now() / 1000);
        const data = getDefaultTimeData("FBTC");
        expect(Math.abs(data.mintGraph[0].timestamp - now)).toBeLessThanOrEqual(5);
        expect(Math.abs(data.redeemGraph[0].timestamp - now)).toBeLessThanOrEqual(5);
    });
});

// ─── calculateExpirationMinutes ─────────────────────────────────────────────

describe("calculateExpirationMinutes", () => {
    it("should return '1' when the timestamp is in the past", () => {
        const pastTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
        expect(calculateExpirationMinutes(pastTimestamp)).toBe("1");
    });

    it("should return '1' when the timestamp equals now", () => {
        const now = String(Math.floor(Date.now() / 1000));
        expect(calculateExpirationMinutes(now)).toBe("1");
    });

    it("should return '1' when the remaining time is exactly 60 seconds", () => {
        // t - now <= 60 => returns "1"
        const timestamp = String(Math.floor(Date.now() / 1000) + 60);
        expect(calculateExpirationMinutes(timestamp)).toBe("1");
    });

    it("should return '1' when the remaining time is 30 seconds (less than 60)", () => {
        const timestamp = String(Math.floor(Date.now() / 1000) + 30);
        expect(calculateExpirationMinutes(timestamp)).toBe("1");
    });

    it("should return the floor of remaining minutes when more than 60 seconds remain", () => {
        // 600 seconds => 10 minutes
        const timestamp = String(Math.floor(Date.now() / 1000) + 600);
        expect(calculateExpirationMinutes(timestamp)).toBe("10");
    });

    it("should truncate partial minutes (e.g. 150 seconds = 2 minutes, not 2.5)", () => {
        // 150 seconds / 60 = 2.5 => floor = 2
        const timestamp = String(Math.floor(Date.now() / 1000) + 150);
        expect(calculateExpirationMinutes(timestamp)).toBe("2");
    });

    it("should handle very large future timestamps", () => {
        // 1 year from now ~ 525600 minutes
        const oneYear = 365 * 24 * 3600;
        const timestamp = String(Math.floor(Date.now() / 1000) + oneYear);
        const result = Number(calculateExpirationMinutes(timestamp));
        // Should be approximately 525600, within a small delta
        expect(result).toBeGreaterThan(525500);
        expect(result).toBeLessThanOrEqual(525600);
    });
});

// ─── bigintPow10 ────────────────────────────────────────────────────────────

describe("bigintPow10", () => {
    it("should return 1n for exponent 0", () => {
        expect(bigintPow10(0)).toBe(1n);
    });

    it("should return 10n for exponent 1", () => {
        expect(bigintPow10(1)).toBe(10n);
    });

    it("should return 1000n for exponent 3", () => {
        expect(bigintPow10(3)).toBe(1000n);
    });

    it("should return 10^18 for exponent 18", () => {
        expect(bigintPow10(18)).toBe(1_000_000_000_000_000_000n);
    });

    it("should return 10^50 for exponent 50", () => {
        expect(bigintPow10(50)).toBe(10n ** 50n);
    });

    it("should handle exponent 9", () => {
        expect(bigintPow10(9)).toBe(1_000_000_000n);
    });
});

// ─── formatFixedBigInt ──────────────────────────────────────────────────────

describe("formatFixedBigInt", () => {
    it("should format a basic value with decimals", () => {
        // value = 1234567890n, baseUnitDecimals = 6, decimals = 3
        // integer = "1234", fractional = "567890" => sliced to "567"
        // trailing zeros trimmed: "567" => "567"
        expect(formatFixedBigInt(1234567890n, 6, { decimals: 3 })).toBe("1234.567");
    });

    it("should format zero value", () => {
        expect(formatFixedBigInt(0n, 18, { decimals: 6 })).toBe("0");
    });

    it("should handle value smaller than baseUnitDecimals (leading zeros in fraction)", () => {
        // value = 123n, baseUnitDecimals = 6 => "0.000123"
        // decimals = 6 => fractional = "000123", no trailing zeros to trim
        expect(formatFixedBigInt(123n, 6, { decimals: 6 })).toBe("0.000123");
    });

    it("should trim trailing zeros in the fractional part", () => {
        // value = 1500000n, baseUnitDecimals = 6 => int = "1", frac = "500000"
        // decimals = 6 => "500000" trimmed => "5"
        expect(formatFixedBigInt(1500000n, 6, { decimals: 6 })).toBe("1.5");
    });

    it("should return integer only when all fractional digits are zero", () => {
        // value = 1000000n, baseUnitDecimals = 6 => int = "1", frac = "000000"
        expect(formatFixedBigInt(1000000n, 6, { decimals: 6 })).toBe("1");
    });

    it("should handle group digits with default separator (comma)", () => {
        // value = 1234567000000n, baseUnitDecimals = 6, groupDigits
        // integer = "1234567" => "1,234,567"
        expect(
            formatFixedBigInt(1234567000000n, 6, { decimals: 2, groupDigits: true }),
        ).toBe("1,234,567");
    });

    it("should handle group digits with custom separator", () => {
        expect(
            formatFixedBigInt(1234567000000n, 6, {
                decimals: 2,
                groupDigits: true,
                groupSeparator: ".",
            }),
        ).toBe("1.234.567");
    });

    it("should handle negative values", () => {
        expect(formatFixedBigInt(-1500000n, 6, { decimals: 6 })).toBe("-1.5");
    });

    it("should handle negative zero", () => {
        expect(formatFixedBigInt(-0n, 6, { decimals: 6 })).toBe("0");
    });

    it("should handle decimals = 0 (integer output only)", () => {
        // fractional part sliced to 0 length => empty => no decimal point
        expect(formatFixedBigInt(1500000n, 6, { decimals: 0 })).toBe("1");
    });

    it("should pad fractional part when baseUnitDecimals is large and value is small", () => {
        // value = 1n, baseUnitDecimals = 18, decimals = 18
        // str = "1", padStart(18) => "000000000000000001"
        expect(formatFixedBigInt(1n, 18, { decimals: 18 })).toBe("0.000000000000000001");
    });

    it("should truncate fractional digits to the requested decimals", () => {
        // value = 1234567890123456789n, baseUnitDecimals = 18, decimals = 2
        // int = "1", frac = "234567890123456789" => sliced to "23"
        expect(formatFixedBigInt(1234567890123456789n, 18, { decimals: 2 })).toBe("1.23");
    });

    it("should handle negative value with group digits", () => {
        expect(
            formatFixedBigInt(-1234567890000n, 6, {
                decimals: 3,
                groupDigits: true,
            }),
        ).toBe("-1,234,567.89");
    });
});

// ─── formatBigIntToDisplayDecimals ──────────────────────────────────────────

describe("formatBigIntToDisplayDecimals", () => {
    it("should format a basic value with display decimals", () => {
        // 1234567890n, displayDecimals = 3, baseUnitDecimals = 6
        // integer = "1234", fractional = "567890" => slice(0,3) = "567" => padEnd(3) = "567"
        // trim trailing "0" => "567"
        // grouping: "1,234"
        expect(formatBigIntToDisplayDecimals(1234567890n, 3, 6)).toBe("1,234.567");
    });

    it("should format zero value", () => {
        expect(formatBigIntToDisplayDecimals(0n, 6, 18)).toBe("0");
    });

    it("should handle a value with all-zero fractional part", () => {
        expect(formatBigIntToDisplayDecimals(1000000n, 6, 6)).toBe("1");
    });

    it("should handle value smaller than baseUnitDecimals", () => {
        // 123n, baseUnitDecimals = 6 => int = "0", frac = "000123"
        // displayDecimals = 6 => "000123", trim trailing zeros => "000123"
        expect(formatBigIntToDisplayDecimals(123n, 6, 6)).toBe("0.000123");
    });

    it("should trim trailing zeros", () => {
        // 1500000n, baseUnitDecimals = 6 => int = "1", frac = "500000"
        // displayDecimals = 6 => "500000", trim => "5"
        expect(formatBigIntToDisplayDecimals(1500000n, 6, 6)).toBe("1.5");
    });

    it("should apply comma grouping to the integer part", () => {
        // 1234567000000000000000000n (1234567 * 10^18) with baseUnitDecimals = 18
        // int = "1234567", frac all zeros => no frac
        // grouping => "1,234,567"
        expect(formatBigIntToDisplayDecimals(1234567000000000000000000n, 6, 18)).toBe("1,234,567");
    });

    it("should handle displayDecimals = 0", () => {
        // No fractional part shown
        expect(formatBigIntToDisplayDecimals(1500000n, 0, 6)).toBe("1");
    });

    it("should pad fractional part if displayDecimals is larger than available digits", () => {
        // 1100000n, baseUnitDecimals = 6 => int = "1", frac = "100000"
        // displayDecimals = 8 => slice(0,8) of "100000" => "100000" padEnd(8) = "10000000"
        // trim trailing zeros => "1"
        expect(formatBigIntToDisplayDecimals(1100000n, 8, 6)).toBe("1.1");
    });
});

// ─── calculateUSDValueBigInt ────────────────────────────────────────────────

describe("calculateUSDValueBigInt", () => {
    it("should calculate a basic USD value", () => {
        // amount = 1 * 10^18, price = 2 * 10^5, priceDecimals = 5, assetDecimals = 18, formatDecimals = 2
        // amountUSD = (10^18 * 2*10^5) / 10^5 = 2*10^18
        // formatFixedBigInt(2*10^18, 18, { decimals: 2, groupDigits: true }) => "2"
        const amount = 10n ** 18n;
        const price = 2n * 10n ** 5n;
        expect(calculateUSDValueBigInt(amount, price, 5, 18, 2)).toBe("2");
    });

    it("should handle zero amount", () => {
        expect(calculateUSDValueBigInt(0n, 100000n, 5, 18, 2)).toBe("0");
    });

    it("should handle zero price", () => {
        expect(calculateUSDValueBigInt(10n ** 18n, 0n, 5, 18, 2)).toBe("0");
    });

    it("should format with commas for large values", () => {
        // amount = 1,000,000 tokens with 18 decimals
        // price = 1.5 with 5 price decimals = 150000
        const amount = 1_000_000n * 10n ** 18n;
        const price = 150000n; // 1.5 * 10^5
        // amountUSD = (10^24 * 150000) / 10^5 = 1.5 * 10^24
        // formatFixedBigInt(1.5*10^24, 18, { decimals: 2, groupDigits: true })
        // int = "1500000", frac = all zeros => "1,500,000"
        expect(calculateUSDValueBigInt(amount, price, 5, 18, 2)).toBe("1,500,000");
    });

    it("should show fractional USD digits when present", () => {
        // amount = 1 token, price = 1.23456 (5 decimals) = 123456
        const amount = 10n ** 18n;
        const price = 123456n;
        // amountUSD = (10^18 * 123456) / 10^5 = 123456 * 10^13 = 1234560000000000000
        // formatFixedBigInt(1234560000000000000n, 18, { decimals: 5, groupDigits: true })
        // int = "1", frac = "234560000000000000" => sliced to 5 => "23456"
        expect(calculateUSDValueBigInt(amount, price, 5, 18, 5)).toBe("1.23456");
    });
});

// ─── toBNDecimalBigInt ──────────────────────────────────────────────────────

describe("toBNDecimalBigInt", () => {
    it("should convert an integer to a scaled bigint", () => {
        // 1 with 10 decimals => 10000000000n
        expect(toBNDecimalBigInt(1, 10)).toBe(10000000000n);
    });

    it("should convert a decimal number to a scaled bigint", () => {
        // 1.003 with 10 decimals => "10030000000"
        expect(toBNDecimalBigInt(1.003, 10)).toBe(10030000000n);
    });

    it("should handle a string input", () => {
        expect(toBNDecimalBigInt("2.5", 10)).toBe(25000000000n);
    });

    it("should handle zero", () => {
        expect(toBNDecimalBigInt(0, 10)).toBe(0n);
    });

    it("should handle zero with decimals = 0", () => {
        expect(toBNDecimalBigInt(0, 0)).toBe(0n);
    });

    it("should default to 10 decimals if not provided", () => {
        expect(toBNDecimalBigInt(1)).toBe(10000000000n);
    });

    it("should handle a fraction longer than the decimals parameter (truncation)", () => {
        // "1.123456789012345" with 6 decimals => "1123456" (fraction truncated to 6 digits)
        expect(toBNDecimalBigInt("1.123456789012345", 6)).toBe(1123456n);
    });

    it("should handle a fraction shorter than the decimals parameter (padding)", () => {
        // "1.5" with 18 decimals => "1" + "5" padEnd(18) = "1500000000000000000"
        expect(toBNDecimalBigInt("1.5", 18)).toBe(1500000000000000000n);
    });

    it("should handle whole number with no fraction part", () => {
        // "42" with 6 decimals => whole = "42", fraction = "0" padEnd(6) = "000000"
        // => "42000000"
        expect(toBNDecimalBigInt("42", 6)).toBe(42000000n);
    });

    it("should handle decimals = 0 with a whole number", () => {
        // "123" with 0 decimals => "123" + "" (fraction "0" sliced to 0) => BigInt("123")
        // Actually: fraction = "0", padEnd(0) = "", slice(0,0) = "" => BigInt("123" + "") = 123n
        expect(toBNDecimalBigInt("123", 0)).toBe(123n);
    });
});

// ─── formatBigIntToStringForceDecimals ──────────────────────────────────────

describe("formatBigIntToStringForceDecimals", () => {
    it("should format a value with non-zero fractional digits", () => {
        // 1500000n, displayDecimals = 6, baseUnitDecimals = 6
        // int = "1", frac = "500000", padEnd(6) = "500000", fullFraction = "500000"
        // Not all zero => displayFraction = "500000"
        // grouping int => "1"
        expect(formatBigIntToStringForceDecimals(1500000n, 6, 6)).toBe("1.500000");
    });

    it("should show '.00' when all fractional digits are zero and displayDecimals > 2", () => {
        // 1000000n, displayDecimals = 6, baseUnitDecimals = 6
        // int = "1", frac = "000000", fullFraction = "000000"
        // all zeros and displayDecimals > 2 => displayFraction = "00"
        expect(formatBigIntToStringForceDecimals(1000000n, 6, 6)).toBe("1.00");
    });

    it("should show full zeros when displayDecimals = 2 and fraction is all zeros", () => {
        // 1000000n, displayDecimals = 2, baseUnitDecimals = 6
        // frac = "000000", fullFraction = "00"
        // isAllZero = true, but displayDecimals is NOT > 2 => displayFraction = fullFraction.padEnd(2) = "00"
        expect(formatBigIntToStringForceDecimals(1000000n, 2, 6)).toBe("1.00");
    });

    it("should handle zero value", () => {
        // 0n, displayDecimals = 6, baseUnitDecimals = 6
        // baseUnitStr = "0", length (1) <= 6 => int = "0", frac = "000000"
        // fullFraction = "000000" => all zero, displayDecimals > 2 => "00"
        expect(formatBigIntToStringForceDecimals(0n, 6, 6)).toBe("0.00");
    });

    it("should handle value smaller than baseUnitDecimals", () => {
        // 123n, displayDecimals = 6, baseUnitDecimals = 6
        // str = "123", padStart(6) = "000123"
        // int = "0", frac = "000123", fullFraction = "000123"
        // Not all zero => displayFraction = "000123"
        expect(formatBigIntToStringForceDecimals(123n, 6, 6)).toBe("0.000123");
    });

    it("should apply comma grouping to the integer part", () => {
        // 1234567000000n, displayDecimals = 6, baseUnitDecimals = 6
        // int = "1234567", frac = "000000" => all zeros => "00"
        expect(formatBigIntToStringForceDecimals(1234567000000n, 6, 6)).toBe("1,234,567.00");
    });

    it("should handle displayDecimals = 0", () => {
        // fullFraction = "" (slice 0 chars), isAllZero on "" => /^0+$/ is false
        // displayFraction = "".padEnd(0) = ""
        // displayFraction.length = 0 => return integerPart only
        expect(formatBigIntToStringForceDecimals(1500000n, 0, 6)).toBe("1");
    });

    it("should handle displayDecimals = 1 with all-zero fraction", () => {
        // fullFraction = "0", isAllZero = true, displayDecimals (1) is NOT > 2
        // displayFraction = "0".padEnd(1) = "0"
        expect(formatBigIntToStringForceDecimals(1000000n, 1, 6)).toBe("1.0");
    });

    it("should pad fractional part to displayDecimals if fraction is non-zero", () => {
        // 1100000n, displayDecimals = 6, baseUnitDecimals = 6
        // int = "1", frac = "100000", fullFraction = "100000"
        // not all zero => displayFraction = "100000"
        expect(formatBigIntToStringForceDecimals(1100000n, 6, 6)).toBe("1.100000");
    });

    it("should handle large values with commas and fractional digits", () => {
        // 999999999123456n, displayDecimals = 6, baseUnitDecimals = 6
        // int = "999999999", frac = "123456"
        // not all zero => "123456"
        // grouping => "999,999,999"
        expect(formatBigIntToStringForceDecimals(999999999123456n, 6, 6)).toBe("999,999,999.123456");
    });
});
