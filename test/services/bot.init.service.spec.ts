/**
 * Unit tests for BotService.
 *
 * BotService is a large service (1171 lines) responsible for fetching pool data,
 * ecosystem stats, time-series caching, and redemption queue management. It
 * interacts heavily with on-chain contracts, the database, and cron jobs.
 *
 * Strategy: We skip onModuleInit and getPools (they require too many live
 * dependencies) and instead manually set the service's internal state after
 * construction. This lets us test the simpler public methods in isolation:
 *   - getEcosystemInfo
 *   - getFassetDecimals
 *   - getAssetSymbol
 *   - getCollateralList
 *   - getTimeSeries (cache hit / miss)
 *   - updateRedemptionQueue (various scenarios)
 *   - getTimeData
 *   - onModuleDestroy
 */

/* ---- mock heavy transitive dependencies before any imports ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock("ethers", () => {
    class MockContractFactory {}
    return {
        ethers: { JsonRpcProvider: jest.fn(), Wallet: jest.fn() },
        keccak256: jest.fn().mockReturnValue("0x0"),
        toUtf8Bytes: jest.fn().mockReturnValue(new Uint8Array(0)),
        FetchRequest: jest.fn().mockImplementation(() => ({ setHeader: jest.fn() })),
        Contract: jest.fn(),
        Interface: jest.fn(),
        ContractFactory: MockContractFactory,
    };
});

jest.mock("node-cron", () => ({
    schedule: jest.fn(),
    stop: jest.fn(),
}));

jest.mock("fs", () => {
    const actualFs = jest.requireActual("fs");
    return {
        ...actualFs,
        readFileSync: jest.fn().mockReturnValue(JSON.stringify({
            fAssets: {
                FTestXRP: { walletUrls: ["https://wallet.example.com"] }
            },
            dataAccessLayerUrls: ["https://dal.example.com"]
        })),
    };
});

/* Mock utility functions to prevent heavy imports from utils module */
jest.mock("src/utils/utils", () => ({
    calculateOvercollateralizationPercentage: jest.fn().mockReturnValue("150"),
    calculateUSDValueBigInt: jest.fn().mockReturnValue("100.000"),
    formatFixedBigInt: jest.fn().mockReturnValue("1,000.000"),
    bigintPow10: jest.fn().mockReturnValue(1000000000000000000n),
    getDefaultTimeData: jest.fn().mockReturnValue({
        supplyDiff: [],
        mintGraph: [],
        redeemGraph: [],
        bestPools: [],
        totalCollateralDiff: "0",
        isPositiveCollateralDiff: false,
    }),
    sumUsdStrings: jest.fn().mockReturnValue("0"),
    toBNDecimalBigInt: jest.fn().mockReturnValue(10000000000n),
    formatBigIntToDisplayDecimals: jest.fn().mockReturnValue("100.00"),
    calculateExpirationMinutes: jest.fn().mockReturnValue(60),
    isValidWalletAddress: jest.fn().mockReturnValue(true),
    dateStringToTimestamp: jest.fn().mockReturnValue(1000000),
    timestampToDateString: jest.fn().mockReturnValue("2024-01-01"),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { MikroORM, EntityManager } from "@mikro-orm/core";
import { ConfigService } from "@nestjs/config";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { BotService } from "../../src/services/bot.init.service";
import { ExternalApiService } from "../../src/services/external.api.service";
import { TimeDataService } from "../../src/services/time.data.service";
import { ContractService } from "../../src/services/contract.service";
import { FassetConfigService } from "../../src/services/fasset.config.service";
import { EthersService } from "../../src/services/ethers.service";
import { getDefaultTimeData } from "../../src/utils/utils";
import * as cron from "node-cron";

/* ------------------------------------------------------------------ */
/*  Shared mock instances                                              */
/* ------------------------------------------------------------------ */

/** Mock EntityManager with fork() returning itself for chaining */
const mockEm = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    persistAndFlush: jest.fn().mockResolvedValue(undefined),
    removeAndFlush: jest.fn().mockResolvedValue(undefined),
    fork: jest.fn(),
};
mockEm.fork.mockReturnValue(mockEm);

const mockOrm = { em: mockEm };

/** ConfigService mock returning dev/coston2 environment values */
const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
        const env: Record<string, string> = {
            APP_TYPE: "dev",
            NETWORK: "coston2",
            BOT_CONFIG_PATH: "coston2-bot.json",
        };
        return env[key] ?? defaultValue;
    }),
};

/** ExternalApiService mock - all endpoints resolve with safe defaults */
const mockExternalApiService = {
    getMints: jest.fn().mockResolvedValue(0),
    getLiquidationCount: jest.fn().mockResolvedValue(0),
    getRedemptionSuccessRate: jest.fn().mockResolvedValue(0),
    getTotalPoolFees: jest.fn().mockResolvedValue({}),
    getHolderCount: jest.fn().mockResolvedValue({}),
    getTotalRedeemedLots: jest.fn().mockResolvedValue({}),
    getBestPerformingPools: jest.fn().mockResolvedValue({}),
    getTotalLiquidationCount: jest.fn().mockResolvedValue(0),
    getTotalMintCount: jest.fn().mockResolvedValue(0),
    getPoolTransactionCount: jest.fn().mockResolvedValue(0),
    getTotalClaimedPoolFees: jest.fn().mockResolvedValue({}),
    getCVInflows: jest.fn().mockResolvedValue({ FXRP: [{ value: "0" }] }),
    getCVOutflows: jest.fn().mockResolvedValue({ FXRP: [{ value: "0" }] }),
    getCVratio: jest.fn().mockResolvedValue({ FXRP: [{ value: 1.003 }] }),
};

/** Cache manager mock - default to cache miss (undefined) */
const mockCacheManager = {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
};

/** TimeDataService mock */
const mockTimeDataService = {
    updateTimeData: jest.fn().mockResolvedValue(undefined),
};

/**
 * ContractService mock - returns a fake AssetManager contract
 * with the minimal interface needed by updateRedemptionQueue
 */
const mockContractService = {
    get: jest.fn().mockReturnValue({
        getSettings: jest.fn().mockResolvedValue({
            assetDecimals: 6n,
            lotSizeAMG: 20n,
            assetMintingGranularityUBA: 1000000n,
            mintingCapAMG: 0n,
            priceReader: "0xPriceReader",
            agentOwnerRegistry: "0xAgentRegistry",
            maxRedeemedTickets: 20n,
            redemptionFeeBIPS: 200n,
        }),
        getAgentInfo: jest.fn().mockResolvedValue({}),
        getAllAgents: jest.fn().mockResolvedValue([[]]),
        getCollateralTypes: jest.fn().mockResolvedValue([]),
        getAddress: jest.fn().mockResolvedValue("0xAssetManager"),
        target: "0xAssetManager",
        redemptionQueue: jest.fn().mockResolvedValue([[], 0n]),
        mintingPaused: jest.fn().mockResolvedValue(false),
    }),
    getContractNames: jest.fn().mockReturnValue([]),
};

/** FassetConfigService mock */
const mockFassetConfigService = {
    getFAssets: jest.fn().mockReturnValue(new Map()),
    getFAssetNames: jest.fn().mockReturnValue(["FTestXRP"]),
    getNativeSymbol: jest.fn().mockReturnValue("C2FLR"),
};

/** EthersService mock returning a minimal provider and signer */
const mockEthersService = {
    getProvider: jest.fn().mockReturnValue({
        getBalance: jest.fn().mockResolvedValue(0n),
        getBlock: jest.fn().mockResolvedValue({ timestamp: Math.floor(Date.now() / 1000) }),
    }),
    getSigner: jest.fn().mockReturnValue({}),
    getExecutorAddress: jest.fn().mockReturnValue("0xExecutor"),
};

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe("BotService", () => {
    let service: BotService;

    beforeEach(async () => {
        /* Reset all mock call history between tests */
        jest.clearAllMocks();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BotService,
                { provide: MikroORM, useValue: mockOrm },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: ExternalApiService, useValue: mockExternalApiService },
                { provide: CACHE_MANAGER, useValue: mockCacheManager },
                { provide: TimeDataService, useValue: mockTimeDataService },
                { provide: ContractService, useValue: mockContractService },
                { provide: FassetConfigService, useValue: mockFassetConfigService },
                { provide: EthersService, useValue: mockEthersService },
            ],
        }).compile();

        service = module.get<BotService>(BotService);

        /*
         * Manually seed internal state so we can test getter methods
         * without calling onModuleInit (which has too many side effects).
         */
        (service as any).fassetList = ["FTestXRP"];
        (service as any).fassetDecimals = [{ fasset: "FTestXRP", decimals: 6 }];
        (service as any).fassetSymbol = new Map([["FTestXRP", "XRP"]]);
        (service as any).ecosystemTVL = "1000.000";
        (service as any).tvlPoolsNat = "500.000";
        (service as any).ecosystemTransactions = "42";
        (service as any).numAgents = 5;
        (service as any).agentsInLiquidation = 1;
        (service as any).fassetCirculatingSupply = [];
        (service as any).mintedAll = "200.000";
        (service as any).numberOfLiquidations = 3;
        (service as any).rewardsAvailableUSD = "50.000";
        (service as any).overCollaterized = "150";
        (service as any).collateralCirculatingSupply = [];
        (service as any).totalCollateral = "1500.000";
        (service as any).numMints = 10;
        (service as any).totalPoolRewardsPaidUSD = "25.000";
        (service as any).poolRewards = [];
        (service as any).holders = 100;
        (service as any).topPools = [];
        (service as any).agentPoolCollateral = "300.000";
        (service as any).numRedeems = 5;
        (service as any).collateralTokenList = ["testUSDC", "testETH"];
        (service as any).assetManagerMap = new Map([["FTestXRP", mockContractService.get()]]);
    });

    /* -------------------------------------------------------------- */
    /*  1. Basic instantiation                                         */
    /* -------------------------------------------------------------- */

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    /* -------------------------------------------------------------- */
    /*  2. getEcosystemInfo                                            */
    /* -------------------------------------------------------------- */

    describe("getEcosystemInfo", () => {
        it("should return the full ecosystem data object built from instance state", () => {
            const result = service.getEcosystemInfo();

            /* Verify every field is correctly mapped from the internal state */
            expect(result.tvl).toBe("1000.000");
            expect(result.tvlPoolsNat).toBe("500.000");
            expect(result.numTransactions).toBe("42");
            expect(result.numAgents).toBe(5);
            expect(result.agentsInLiquidation).toBe(1);
            expect(result.supplyByFasset).toEqual([]);
            expect(result.totalMinted).toBe("200.000");
            expect(result.numLiquidations).toBe(3);
            expect(result.rewardsAvailableUSD).toBe("50.000");
            expect(result.overCollaterazied).toBe("150");
            expect(result.supplyByCollateral).toEqual([]);
            expect(result.totalCollateral).toBe("1500.000");
            expect(result.numMints).toBe(10);
            expect(result.totalPoolRewardsPaidUSD).toBe("25.000");
            expect(result.poolRewards).toEqual([]);
            expect(result.numHolders).toBe(100);
            expect(result.agentCollateral).toBe("300.000");
            expect(result.numRedeems).toBe(5);

            /* Core vault fields default to "0" because we did not set them */
            expect(result.coreVaultSupply).toBe("0");
            expect(result.coreVaultSupplyUSD).toBe("0");
            expect(result.coreVaultInflows).toBe("0");
            expect(result.coreVaultInflowsUSD).toBe("0");
            expect(result.coreVaultOutflows).toBe("0");
            expect(result.coreVaultOutflowsUSD).toBe("0");

            /* Proof of reserve should be the PROOF_OF_RESERVE constant default */
            expect(result.proofOfReserve).toEqual({
                total: "0",
                totalUSD: "0",
                reserve: "0",
                reserveUSD: "0",
                ratio: "0",
            });
        });
    });

    /* -------------------------------------------------------------- */
    /*  3. getFassetDecimals                                           */
    /* -------------------------------------------------------------- */

    describe("getFassetDecimals", () => {
        it("should return the correct decimals for a known fasset", () => {
            /* FTestXRP was seeded with 6 decimals in the setup */
            const decimals = service.getFassetDecimals("FTestXRP");
            expect(decimals).toBe(6);
        });

        it("should throw when the fasset is unknown (find returns undefined)", () => {
            /* Accessing .decimals on undefined should throw a TypeError */
            expect(() => service.getFassetDecimals("FUnknown")).toThrow();
        });
    });

    /* -------------------------------------------------------------- */
    /*  4. getAssetSymbol                                              */
    /* -------------------------------------------------------------- */

    describe("getAssetSymbol", () => {
        it("should return the underlying asset symbol for a known fasset", () => {
            /* FTestXRP -> "XRP" from the fassetSymbol map */
            const symbol = service.getAssetSymbol("FTestXRP");
            expect(symbol).toBe("XRP");
        });

        it("should return undefined for an unknown fasset", () => {
            /* Map.get() returns undefined for missing keys */
            const symbol = service.getAssetSymbol("FUnknown");
            expect(symbol).toBeUndefined();
        });
    });

    /* -------------------------------------------------------------- */
    /*  5. getCollateralList                                           */
    /* -------------------------------------------------------------- */

    describe("getCollateralList", () => {
        it("should return the collateral token list array", () => {
            const list = service.getCollateralList();
            expect(list).toEqual(["testUSDC", "testETH"]);
        });

        it("should return an empty array when no collateral tokens are configured", () => {
            (service as any).collateralTokenList = [];
            expect(service.getCollateralList()).toEqual([]);
        });
    });

    /* -------------------------------------------------------------- */
    /*  6. getTimeSeries                                               */
    /* -------------------------------------------------------------- */

    describe("getTimeSeries", () => {
        it("should return cached data when the cache manager has a hit", async () => {
            /* Simulate a cache hit for "24hData" */
            const cachedData = {
                supplyDiff: [{ fasset: "FTestXRP", diff: "10", isPositive: true }],
                mintGraph: [{ timestamp: 1000, value: "50" }],
                redeemGraph: [],
                bestPools: [],
                totalCollateralDiff: "5",
                isPositiveCollateralDiff: true,
            };
            mockCacheManager.get.mockResolvedValueOnce(cachedData);

            const result = await service.getTimeSeries("24h");

            /* Should have queried the cache with the correct key */
            expect(mockCacheManager.get).toHaveBeenCalledWith("24hData");
            /* Should return the exact cached object */
            expect(result).toBe(cachedData);
        });

        it("should return default time data when there is a cache miss", async () => {
            /* Default mock returns undefined (cache miss) */
            mockCacheManager.get.mockResolvedValueOnce(undefined);

            const result = await service.getTimeSeries("7d");

            /* Should query cache with "7dData" */
            expect(mockCacheManager.get).toHaveBeenCalledWith("7dData");

            /* Should fall back to getDefaultTimeData with the first fasset in the list */
            expect(getDefaultTimeData).toHaveBeenCalledWith("FTestXRP");

            /* Should return the mocked default structure */
            expect(result).toEqual({
                supplyDiff: [],
                mintGraph: [],
                redeemGraph: [],
                bestPools: [],
                totalCollateralDiff: "0",
                isPositiveCollateralDiff: false,
            });
        });
    });

    /* -------------------------------------------------------------- */
    /*  7. updateRedemptionQueue                                       */
    /* -------------------------------------------------------------- */

    describe("updateRedemptionQueue", () => {
        it("should set cache values for maxLotsSingleRedeem and maxLotsTotalRedeem with non-empty queue", async () => {
            /**
             * Simulate a redemption queue that returns 2 tickets in a single page
             * (nextIndex = 0n means no more pages).
             * lotSizeUBA = lotSizeAMG (20) * assetMintingGranularityUBA (1_000_000) = 20_000_000
             * Ticket values: 40_000_000 + 60_000_000 = 100_000_000
             * maxSingleLotsToRedeem = 100_000_000 / 20_000_000 = 5
             * maxShortTermLotsTotal = same (single page) = 5
             */
            const fakeAssetManager = mockContractService.get();
            fakeAssetManager.redemptionQueue.mockResolvedValueOnce([
                [
                    { ticketValueUBA: 40_000_000n },
                    { ticketValueUBA: 60_000_000n },
                ],
                0n, // nextIndex = 0 -> no more pages
            ]);

            await service.updateRedemptionQueue("FTestXRP");

            /* Verify the correct lot counts were stored in the cache */
            expect(mockCacheManager.set).toHaveBeenCalledWith("FTestXRPmaxLotsSingleRedeem", 5n, 0);
            expect(mockCacheManager.set).toHaveBeenCalledWith("FTestXRPmaxLotsTotalRedeem", 5n, 0);
        });

        it("should handle an empty redemption queue by setting both cache values to 0", async () => {
            /**
             * When the queue has no tickets, the service should short-circuit
             * and write 0 for both maxLotsSingleRedeem and maxLotsTotalRedeem.
             */
            const fakeAssetManager = mockContractService.get();
            fakeAssetManager.redemptionQueue.mockResolvedValueOnce([[], 0n]);

            await service.updateRedemptionQueue("FTestXRP");

            expect(mockCacheManager.set).toHaveBeenCalledWith("FTestXRPmaxLotsSingleRedeem", 0, 0);
            expect(mockCacheManager.set).toHaveBeenCalledWith("FTestXRPmaxLotsTotalRedeem", 0, 0);
            /* Should only have been called twice (the two set calls above) */
            expect(mockCacheManager.set).toHaveBeenCalledTimes(2);
        });

        it("should handle pagination when redemptionQueue returns non-zero nextIndex", async () => {
            /**
             * Simulate a multi-page redemption queue:
             *   Page 1: 2 tickets (total 100_000_000), nextIndex = 20n (more pages)
             *   Page 2: 1 ticket  (total  20_000_000), nextIndex = 0n  (done)
             *
             * lotSizeUBA = 20_000_000
             * maxSingleRedemtionTotal (first page only) = 100_000_000
             *   -> maxLotsSingleRedeem = 100_000_000 / 20_000_000 = 5
             *
             * maxShortTermRedemptionTotal (all pages) = 100_000_000 + 20_000_000 = 120_000_000
             *   -> maxLotsTotalRedeem = 120_000_000 / 20_000_000 = 6
             */
            const fakeAssetManager = mockContractService.get();

            /* First call: initial page */
            fakeAssetManager.redemptionQueue.mockResolvedValueOnce([
                [
                    { ticketValueUBA: 40_000_000n },
                    { ticketValueUBA: 60_000_000n },
                ],
                20n, // non-zero nextIndex signals more pages
            ]);

            /* Second call: pagination with nextIndex=20, fetching next 20 items */
            fakeAssetManager.redemptionQueue.mockResolvedValueOnce([
                [{ ticketValueUBA: 20_000_000n }],
                0n, // done
            ]);

            await service.updateRedemptionQueue("FTestXRP");

            /* maxLotsSingleRedeem is calculated from just the first page */
            expect(mockCacheManager.set).toHaveBeenCalledWith("FTestXRPmaxLotsSingleRedeem", 5n, 0);

            /* maxLotsTotalRedeem includes all pages */
            expect(mockCacheManager.set).toHaveBeenCalledWith("FTestXRPmaxLotsTotalRedeem", 6n, 0);

            /* The redemptionQueue function should have been called twice (two pages) */
            expect(fakeAssetManager.redemptionQueue).toHaveBeenCalledTimes(2);

            /* Verify the correct pagination arguments were used */
            expect(fakeAssetManager.redemptionQueue).toHaveBeenNthCalledWith(1, 0, 20);
            expect(fakeAssetManager.redemptionQueue).toHaveBeenNthCalledWith(2, 20n, 20);
        });
    });

    /* -------------------------------------------------------------- */
    /*  8. getTimeData                                                 */
    /* -------------------------------------------------------------- */

    describe("getTimeData", () => {
        it("should call timeDataService.updateTimeData with topPools, fassetList, and envType", async () => {
            await service.getTimeData();

            expect(mockTimeDataService.updateTimeData).toHaveBeenCalledTimes(1);
            expect(mockTimeDataService.updateTimeData).toHaveBeenCalledWith(
                [], // topPools (seeded as empty array)
                ["FTestXRP"], // fassetList
                "dev", // envType from configService
            );
        });

        it("should not throw when updateTimeData rejects (error is caught internally)", async () => {
            /* Simulate an error in the time data service */
            mockTimeDataService.updateTimeData.mockRejectedValueOnce(new Error("network failure"));

            /* getTimeData catches the error internally, so it should resolve without throwing */
            await expect(service.getTimeData()).resolves.toBeUndefined();
        });
    });

    /* -------------------------------------------------------------- */
    /*  9. onModuleDestroy                                             */
    /* -------------------------------------------------------------- */

    describe("onModuleDestroy", () => {
        it("should call cron.stop() to halt all scheduled cron jobs", async () => {
            await service.onModuleDestroy();

            expect(cron.stop).toHaveBeenCalledTimes(1);
        });
    });
});
