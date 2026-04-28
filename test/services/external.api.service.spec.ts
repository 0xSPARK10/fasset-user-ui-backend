/**
 * Unit tests for ExternalApiService.
 *
 * ExternalApiService makes HTTP calls to the FAsset indexer API and to
 * blockbook indexers for BTC/DOGE chains. We mock HttpService.get()
 * (for NestJS HTTP client) and axios (for blockbook calls) to test
 * every method without real network traffic.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";
import { of, throwError } from "rxjs";

/* ---- mock axios to prevent real blockbook calls ---- */
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn().mockReturnValue({ get: jest.fn() }),
    },
}));

/* ---- mock https module ---- */
jest.mock("https", () => ({
    __esModule: true,
    default: {
        Agent: jest.fn().mockImplementation(() => ({})),
    },
}));

/* ---- mock logger to suppress output ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

import { ExternalApiService } from "../../src/services/external.api.service";
import axios from "axios";

/** Get mock reference for the axios client's get method */
const mockAxiosGet = (axios.create() as any).get as jest.Mock;

describe("ExternalApiService", () => {
    let service: ExternalApiService;
    let httpService: jest.Mocked<HttpService>;

    const ENV = {
        BTC_INDEXER: "https://btc.indexer.example.com",
        DOGE_INDEXER: "https://doge.indexer.example.com",
        USER_API: "admin",
        PASS_API: "secret",
        API_URL: "https://api.example.com",
        APP_TYPE: "dev",
        DOGE_KEY: "doge-key-123",
        BTC_KEY: "btc-key-456",
    };

    /** Creates a mock observable matching the pattern this.httpService.get() returns */
    function mockHttpResponse(data: any) {
        return of({ data, headers: {}, config: {}, status: 200, statusText: "OK" });
    }

    beforeEach(async () => {
        jest.clearAllMocks();

        const mockHttpService = {
            get: jest.fn(),
        };

        const mockConfigService = {
            get: jest.fn().mockImplementation((key: string) => ENV[key]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ExternalApiService,
                { provide: HttpService, useValue: mockHttpService },
                { provide: ConfigService, useValue: mockConfigService },
            ],
        }).compile();

        service = module.get<ExternalApiService>(ExternalApiService);
        httpService = module.get(HttpService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("getMints", () => {
        it("should return the mint count from the API", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: { amount: 42 } }));

            const result = await service.getMints("0xVaultAddress");

            expect(result).toBe(42);
            expect(httpService.get).toHaveBeenCalledWith(
                expect.stringContaining("/dashboard/agent-minting-executed-count?agent=0xVaultAddress"),
                expect.objectContaining({ headers: expect.any(Object) })
            );
        });

        it("should return 0 when API returns status 500", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 500 }));

            const result = await service.getMints("0xVaultAddress");

            expect(result).toBe(0);
        });

        it("should return 0 when API call throws", async () => {
            httpService.get.mockReturnValue(throwError(() => new Error("Connection failed")));

            const result = await service.getMints("0xVaultAddress");

            expect(result).toBe(0);
        });
    });

    describe("getMints with undefined API_URL", () => {
        beforeEach(async () => {
            const mockConfigService = {
                get: jest.fn().mockImplementation((key: string) => {
                    if (key === "API_URL") return undefined;
                    return ENV[key];
                }),
            };

            const module: TestingModule = await Test.createTestingModule({
                providers: [
                    ExternalApiService,
                    { provide: HttpService, useValue: { get: jest.fn() } },
                    { provide: ConfigService, useValue: mockConfigService },
                ],
            }).compile();

            service = module.get<ExternalApiService>(ExternalApiService);
        });

        it("should return 0 when API_URL is undefined", async () => {
            const result = await service.getMints("0xVaultAddress");
            expect(result).toBe(0);
        });
    });

    describe("getRedemptionSuccessRate", () => {
        it("should return the redemption success rate from the API", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: { amount: 95 } }));

            const result = await service.getRedemptionSuccessRate("0xVaultAddress");

            expect(result).toBe(95);
        });

        it("should return 0 when API returns status 500", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 500 }));

            const result = await service.getRedemptionSuccessRate("0xVaultAddress");

            expect(result).toBe(0);
        });

        it("should return 0 on error", async () => {
            httpService.get.mockReturnValue(throwError(() => new Error("fail")));

            const result = await service.getRedemptionSuccessRate("0xVaultAddress");

            expect(result).toBe(0);
        });
    });

    describe("getLiquidationCount", () => {
        it("should return the liquidation count from the API", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: { amount: 3 } }));

            const result = await service.getLiquidationCount("0xVaultAddress");

            expect(result).toBe(3);
        });

        it("should return 0 on error", async () => {
            httpService.get.mockReturnValue(throwError(() => new Error("fail")));

            const result = await service.getLiquidationCount("0xVaultAddress");

            expect(result).toBe(0);
        });
    });

    describe("getUserCollateralPoolTokens", () => {
        it("should return user collateral pool token data", async () => {
            const mockData = { "0xToken1": { balance: "1000" } };
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: mockData }));

            const result = await service.getUserCollateralPoolTokens("0xUserAddress");

            expect(result).toEqual(mockData);
        });

        it("should return 0 when API returns status 500", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 500 }));

            const result = await service.getUserCollateralPoolTokens("0xUserAddress");

            expect(result).toBe(0);
        });
    });

    describe("getUserTotalClaimedPoolFees", () => {
        it("should return total claimed pool fees data", async () => {
            const mockData = { FXRP: { value: "500000" } };
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: mockData }));

            const result = await service.getUserTotalClaimedPoolFees("0xUserAddress");

            expect(result).toEqual(mockData);
        });

        it("should return 0 on error", async () => {
            httpService.get.mockReturnValue(throwError(() => new Error("fail")));

            const result = await service.getUserTotalClaimedPoolFees("0xUserAddress");

            expect(result).toBe(0);
        });
    });

    describe("getBlockBookHeight", () => {
        it("should return blockbook bestHeight for BTC fasset", async () => {
            mockAxiosGet.mockResolvedValue({ data: { blockbook: { bestHeight: "850000" } } });

            const result = await service.getBlockBookHeight("FTestBTC");

            expect(result).toBe("850000");
        });

        it("should return blockbook bestHeight for DOGE fasset", async () => {
            mockAxiosGet.mockResolvedValue({ data: { blockbook: { bestHeight: "5200000" } } });

            const result = await service.getBlockBookHeight("FTestDOGE");

            expect(result).toBe("5200000");
        });

        it("should propagate error when blockbook call fails", async () => {
            mockAxiosGet.mockRejectedValue(new Error("Blockbook down"));

            await expect(service.getBlockBookHeight("FTestBTC")).rejects.toThrow("Blockbook down");
        });
    });

    describe("getFeeEstimationBlockHeight", () => {
        it("should return fee estimation data for a given block height", async () => {
            const feeData = { averageFeePerKb: 50000, decilesFeePerKb: [10000, 30000, 50000] };
            mockAxiosGet.mockResolvedValue({ data: feeData });

            const result = await service.getFeeEstimationBlockHeight("FTestBTC", 850000);

            expect(result).toEqual(feeData);
        });
    });

    describe("submitTX", () => {
        it("should submit a transaction and return the hash result", async () => {
            mockAxiosGet.mockResolvedValue({ data: { result: "txhash123abc" } });

            const result = await service.submitTX("FTestBTC", "rawtxhex");

            expect(result).toBe("txhash123abc");
        });

        it("should throw error.response.data when submission fails", async () => {
            const errorResponse = { response: { data: { error: "bad-txn" } } };
            mockAxiosGet.mockRejectedValue(errorResponse);

            await expect(service.submitTX("FTestBTC", "badtx")).rejects.toEqual({ error: "bad-txn" });
        });
    });

    describe("getNumberOfTransactions", () => {
        it("should return transaction count from the API", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: 1234 }));

            const result = await service.getNumberOfTransactions();

            expect(result).toBe(1234);
        });

        it("should return 0 when API returns status 500", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 500 }));

            const result = await service.getNumberOfTransactions();

            expect(result).toBe(0);
        });
    });

    describe("getPoolTransactionCount", () => {
        it("should return pool transaction count", async () => {
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: { amount: 567 } }));

            const result = await service.getPoolTransactionCount();

            expect(result).toBe(567);
        });
    });

    describe("getTotalClaimedPoolFees", () => {
        it("should return total claimed pool fees", async () => {
            const mockData = { FXRP: { value: "1000000" } };
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: mockData }));

            const result = await service.getTotalClaimedPoolFees();

            expect(result).toEqual(mockData);
        });

        it("should return default value on error", async () => {
            httpService.get.mockReturnValue(throwError(() => new Error("fail")));

            const result = await service.getTotalClaimedPoolFees();

            expect(result).toEqual({ FXRP: { value: "3369000" } });
        });
    });

    describe("getHolderCount", () => {
        it("should return holder count data", async () => {
            const mockData = { FXRP: { amount: 100 }, FBTC: { amount: 50 } };
            httpService.get.mockReturnValue(mockHttpResponse({ status: 200, data: mockData }));

            const result = await service.getHolderCount();

            expect(result).toEqual(mockData);
        });

        it("should return 0 on error", async () => {
            httpService.get.mockReturnValue(throwError(() => new Error("fail")));

            const result = await service.getHolderCount();

            expect(result).toBe(0);
        });
    });
});
