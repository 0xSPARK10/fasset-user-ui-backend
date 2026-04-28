/**
 * Unit tests for FassetConfigService.
 *
 * FassetConfigService reads configuration JSON files on construction to
 * populate fasset definitions, native symbol, verifiers, DAL URLs, and
 * wallet URLs. We mock fs.readFileSync to provide test config data.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

/* ---- mock VerifierService to avoid real network calls ---- */
jest.mock("../../src/services/verifier.service", () => ({
    VerifierService: jest.fn().mockImplementation((chainId, urls, keys) => ({
        chainId,
        urls,
        keys,
    })),
    ChainId: { XRP: "XRP", BTC: "BTC" },
}));

/** The mock config data that readFileSync will return for the network config */
const mockNetworkConfig = {
    nativeSymbol: "C2FLR",
    fassets: {
        FTestXRP: {
            chainId: "XRP",
            tokenName: "Test XRP",
            tokenSymbol: "testXRP",
            tokenDecimals: 6,
        },
        FTestBTC: {
            chainId: "BTC",
            tokenName: "Test BTC",
            tokenSymbol: "testBTC",
            tokenDecimals: 8,
        },
    },
};

/** The mock bot config file */
const mockBotConfig = {
    dataAccessLayerUrls: ["https://dal1.example.com", "https://dal2.example.com"],
    fAssets: {
        FTestXRP: {
            walletUrls: ["https://xrpl-wallet.example.com"],
        },
        FTestBTC: {
            walletUrls: ["https://btc-wallet.example.com"],
        },
    },
};

/* ---- mock fs.readFileSync to return our test configs ---- */
jest.mock("fs", () => ({
    readFileSync: jest.fn().mockImplementation((filePath: string) => {
        if (filePath.includes("coston2.json")) {
            return JSON.stringify(mockNetworkConfig);
        }
        if (filePath.includes("bot")) {
            return JSON.stringify(mockBotConfig);
        }
        // fallback for the network config path
        return JSON.stringify(mockNetworkConfig);
    }),
}));

import { FassetConfigService } from "../../src/services/fasset.config.service";

describe("FassetConfigService", () => {
    let service: FassetConfigService;

    beforeEach(async () => {
        jest.clearAllMocks();

        const mockConfigService = {
            get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
                if (key === "NETWORK") return "coston2";
                if (key === "BOT_CONFIG_PATH") return "coston2-bot.json";
                if (key === "XRP_INDEXER_URLS") return "https://verifier1.example.com,https://verifier2.example.com";
                if (key === "VERIFIER_API_KEY") return "key1,key2";
                return defaultValue ?? undefined;
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [FassetConfigService, { provide: ConfigService, useValue: mockConfigService }],
        }).compile();

        service = module.get<FassetConfigService>(FassetConfigService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("getFAssets", () => {
        it("should return a Map of all fasset configurations", () => {
            const fassets = service.getFAssets();

            expect(fassets).toBeInstanceOf(Map);
            expect(fassets.size).toBe(2);
            expect(fassets.has("FTestXRP")).toBe(true);
            expect(fassets.has("FTestBTC")).toBe(true);
        });

        it("should contain correct fasset data for FTestXRP", () => {
            const fassets = service.getFAssets();
            const xrp = fassets.get("FTestXRP");

            expect(xrp.chainId).toBe("XRP");
            expect(xrp.tokenName).toBe("Test XRP");
            expect(xrp.tokenSymbol).toBe("testXRP");
            expect(xrp.tokenDecimals).toBe(6);
        });

        it("should contain correct fasset data for FTestBTC", () => {
            const fassets = service.getFAssets();
            const btc = fassets.get("FTestBTC");

            expect(btc.chainId).toBe("BTC");
            expect(btc.tokenName).toBe("Test BTC");
            expect(btc.tokenDecimals).toBe(8);
        });
    });

    describe("getFAssetNames", () => {
        it("should return an array of all fasset names", () => {
            const names = service.getFAssetNames();

            expect(names).toEqual(["FTestXRP", "FTestBTC"]);
        });

        it("should return names in the order they appear in config", () => {
            const names = service.getFAssetNames();

            expect(names[0]).toBe("FTestXRP");
            expect(names[1]).toBe("FTestBTC");
        });
    });

    describe("getFAssetByName", () => {
        it("should return the fasset configuration for a given name", () => {
            const fasset = service.getFAssetByName("FTestXRP");

            expect(fasset).toBeDefined();
            expect(fasset.chainId).toBe("XRP");
            expect(fasset.tokenSymbol).toBe("testXRP");
        });

        it("should return undefined for an unknown fasset name", () => {
            const fasset = service.getFAssetByName("UNKNOWN");

            expect(fasset).toBeUndefined();
        });
    });

    describe("getNativeSymbol", () => {
        it("should return the native symbol from the config", () => {
            const symbol = service.getNativeSymbol();

            expect(symbol).toBe("C2FLR");
        });
    });

    describe("getVerifier", () => {
        it("should return a verifier for a valid fasset name", () => {
            const verifier = service.getVerifier("FTestXRP");

            expect(verifier).toBeDefined();
        });

        it("should throw an error for an unknown fasset name", () => {
            expect(() => service.getVerifier("UNKNOWN")).toThrow("Verifier not found for fasset UNKNOWN");
        });
    });

    describe("getDataAccessLayerUrls", () => {
        it("should return the DAL URLs from the bot config", () => {
            const urls = service.getDataAccessLayerUrls();

            expect(urls).toEqual(["https://dal1.example.com", "https://dal2.example.com"]);
        });
    });

    describe("getWalletUrl", () => {
        it("should return the first wallet URL for a given fasset", () => {
            const url = service.getWalletUrl("FTestXRP");

            expect(url).toBe("https://xrpl-wallet.example.com");
        });

        it("should return the first wallet URL for BTC fasset", () => {
            const url = service.getWalletUrl("FTestBTC");

            expect(url).toBe("https://btc-wallet.example.com");
        });

        it("should return undefined for an unknown fasset", () => {
            const url = service.getWalletUrl("UNKNOWN");

            expect(url).toBeUndefined();
        });
    });
});
