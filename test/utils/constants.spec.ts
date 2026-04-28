import {
    EXECUTION_FEE,
    STATE_CONNECTOR_ADDRESS,
    PROOF_OF_RESERVE,
    EMPTY_SUPPLY_BY_COLLATERAL,
    RedemptionStatusEnum,
    NETWORK_SYMBOLS,
    TEN_MINUTES,
    FILTER_AGENT,
} from "../../src/utils/constants";

describe("Constants", () => {
    describe("EXECUTION_FEE", () => {
        it("should be 2.5 * 10^18 as bigint", () => {
            expect(EXECUTION_FEE).toBe(2_500_000_000_000_000_000n);
        });

        it("should be a bigint type", () => {
            expect(typeof EXECUTION_FEE).toBe("bigint");
        });
    });

    describe("STATE_CONNECTOR_ADDRESS", () => {
        it("should be a valid Ethereum address", () => {
            expect(STATE_CONNECTOR_ADDRESS).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        it("should have the correct value", () => {
            expect(STATE_CONNECTOR_ADDRESS).toBe("0x0c13aDA1C7143Cf0a0795FFaB93eEBb6FAD6e4e3");
        });
    });

    describe("PROOF_OF_RESERVE", () => {
        it("should have all fields set to zero strings", () => {
            expect(PROOF_OF_RESERVE).toEqual({
                total: "0",
                totalUSD: "0",
                reserve: "0",
                reserveUSD: "0",
                ratio: "0",
            });
        });
    });

    describe("EMPTY_SUPPLY_BY_COLLATERAL", () => {
        it("should contain FLR and USDT entries", () => {
            expect(EMPTY_SUPPLY_BY_COLLATERAL).toHaveLength(2);
            expect(EMPTY_SUPPLY_BY_COLLATERAL[0].symbol).toBe("FLR");
            expect(EMPTY_SUPPLY_BY_COLLATERAL[1].symbol).toBe("USDT");
        });

        it("should have zero values for all entries", () => {
            for (const entry of EMPTY_SUPPLY_BY_COLLATERAL) {
                expect(entry.supply).toBe("0");
                expect(entry.supplyUSD).toBe("0");
            }
        });
    });

    describe("RedemptionStatusEnum", () => {
        it("should have EXPIRED status", () => {
            expect(RedemptionStatusEnum.EXPIRED).toBe("EXPIRED");
        });

        it("should have SUCCESS status", () => {
            expect(RedemptionStatusEnum.SUCCESS).toBe("SUCCESS");
        });

        it("should have DEFAULT status", () => {
            expect(RedemptionStatusEnum.DEFAULT).toBe("DEFAULT");
        });

        it("should have PENDING status", () => {
            expect(RedemptionStatusEnum.PENDING).toBe("PENDING");
        });

        it("should have exactly 4 values", () => {
            const values = Object.values(RedemptionStatusEnum);
            expect(values).toHaveLength(4);
        });
    });

    describe("NETWORK_SYMBOLS", () => {
        it("should contain XRP, BTC, and DOGE entries", () => {
            expect(NETWORK_SYMBOLS).toHaveLength(3);
            const symbols = NETWORK_SYMBOLS.map((ns) => ns.symbol);
            expect(symbols).toContain("XRP");
            expect(symbols).toContain("BTC");
            expect(symbols).toContain("DOGE");
        });

        it("should map XRP to FXRP (real) and FTestXRP (test)", () => {
            const xrp = NETWORK_SYMBOLS.find((ns) => ns.symbol === "XRP");
            expect(xrp.real).toBe("FXRP");
            expect(xrp.test).toBe("FTestXRP");
        });

        it("should map BTC to FBTC (real) and FTestBTC (test)", () => {
            const btc = NETWORK_SYMBOLS.find((ns) => ns.symbol === "BTC");
            expect(btc.real).toBe("FBTC");
            expect(btc.test).toBe("FTestBTC");
        });

        it("should map DOGE to FDOGE (real) and FTestDOGE (test)", () => {
            const doge = NETWORK_SYMBOLS.find((ns) => ns.symbol === "DOGE");
            expect(doge.real).toBe("FDOGE");
            expect(doge.test).toBe("FTestDOGE");
        });
    });

    describe("TEN_MINUTES", () => {
        it("should be 600000 milliseconds", () => {
            expect(TEN_MINUTES).toBe(600000);
        });

        it("should equal 10 * 60 * 1000", () => {
            expect(TEN_MINUTES).toBe(10 * 60 * 1000);
        });
    });

    describe("FILTER_AGENT", () => {
        it("should be a lowercase Ethereum address", () => {
            expect(FILTER_AGENT).toMatch(/^0x[a-f0-9]{40}$/);
        });

        it("should be the lowercase version of the known filter address", () => {
            expect(FILTER_AGENT).toBe("0x09011d2A11A40DB855Cb00B3AA5a0F5F3bd485FD".toLowerCase());
        });
    });
});
