/**
 * Unit tests for XRPLApiService.
 *
 * XRPLApiService wraps an Axios HTTP client configured for XRPL JSON-RPC.
 * We mock axios.create and the resulting AxiosInstance to verify that
 * correct parameters and headers are sent for account info requests.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

/* ---- mock axios.create to return a controllable client ---- */
const mockPost = jest.fn();
const mockAxiosInstance = { post: mockPost };

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn().mockReturnValue(mockAxiosInstance),
    },
}));

import { XRPLApiService } from "../../src/services/xrpl-api.service";
import axios from "axios";

describe("XRPLApiService", () => {
    let service: XRPLApiService;
    let configService: jest.Mocked<ConfigService>;

    const MOCK_WALLET_URL = "https://xrpl-node.example.com";
    const MOCK_API_KEY = "xrpl-api-key-123";

    beforeEach(async () => {
        jest.clearAllMocks();

        const mockConfigService = {
            get: jest.fn().mockImplementation((key: string) => {
                if (key === "XRP_WALLET_URLS") return MOCK_WALLET_URL;
                if (key === "XRP_RPC") return MOCK_API_KEY;
                return undefined;
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [XRPLApiService, { provide: ConfigService, useValue: mockConfigService }],
        }).compile();

        service = module.get<XRPLApiService>(XRPLApiService);
        configService = module.get(ConfigService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("createAxiosConfig", () => {
        it("should create config with correct baseURL and timeout", () => {
            const config = service.createAxiosConfig("https://example.com");

            expect(config.baseURL).toBe("https://example.com");
            expect(config.timeout).toBe(20000);
            expect(config.headers["Content-Type"]).toBe("application/json");
        });

        it("should include API key headers when apiKey is provided", () => {
            const config = service.createAxiosConfig("https://example.com", "my-api-key");

            expect(config.headers["X-API-KEY"]).toBe("my-api-key");
            expect(config.headers["x-apikey"]).toBe("my-api-key");
        });

        it("should not include API key headers when apiKey is undefined", () => {
            const config = service.createAxiosConfig("https://example.com");

            expect(config.headers["X-API-KEY"]).toBeUndefined();
            expect(config.headers["x-apikey"]).toBeUndefined();
        });

        it("should not include API key headers when apiKey is empty string", () => {
            const config = service.createAxiosConfig("https://example.com", "");

            // Empty string is falsy so no API key headers should be set
            expect(config.headers["X-API-KEY"]).toBeUndefined();
        });
    });

    describe("onModuleInit", () => {
        it("should create an axios instance with the first wallet URL and API key", async () => {
            await service.onModuleInit();

            expect(axios.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    baseURL: MOCK_WALLET_URL,
                    timeout: 20000,
                })
            );
        });

        it("should handle comma-separated URLs and use the first one", async () => {
            configService.get.mockImplementation((key: string) => {
                if (key === "XRP_WALLET_URLS") return "https://node1.com, https://node2.com";
                if (key === "XRP_RPC") return "key1, key2";
                return undefined;
            });

            await service.onModuleInit();

            expect(axios.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    baseURL: "https://node1.com",
                })
            );
        });
    });

    describe("getAccountInfo", () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it("should call client.post with correct JSON-RPC params", async () => {
            const mockResponse = {
                data: {
                    result: {
                        account_data: { Balance: "1000000" },
                        account_flags: { requireDestinationTag: false, depositAuth: false },
                    },
                },
            };
            mockPost.mockResolvedValue(mockResponse);

            const result = await service.getAccountInfo("rTestAddress123");

            expect(mockPost).toHaveBeenCalledWith("", {
                method: "account_info",
                params: [
                    {
                        account: "rTestAddress123",
                        ledger_index: "validated",
                        strict: true,
                    },
                ],
            });
            expect(result).toEqual(mockResponse);
        });

        it("should propagate errors from the HTTP client", async () => {
            mockPost.mockRejectedValue(new Error("Connection timeout"));

            await expect(service.getAccountInfo("rTestAddress")).rejects.toThrow("Connection timeout");
        });
    });

    describe("accountReceiveBlocked", () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it("should return correct flags when account has depositAuth and requireDestTag", async () => {
            mockPost.mockResolvedValue({
                data: {
                    result: {
                        account_flags: {
                            requireDestinationTag: true,
                            depositAuth: true,
                        },
                    },
                },
            });

            const flags = await service.accountReceiveBlocked("rTaggedAccount");

            expect(flags).toEqual({
                requireDestTag: true,
                depositAuth: true,
            });
        });

        it("should return false flags when account has no special flags", async () => {
            mockPost.mockResolvedValue({
                data: {
                    result: {
                        account_flags: {
                            requireDestinationTag: false,
                            depositAuth: false,
                        },
                    },
                },
            });

            const flags = await service.accountReceiveBlocked("rNormalAccount");

            expect(flags).toEqual({
                requireDestTag: false,
                depositAuth: false,
            });
        });

        it("should default to false when account_flags fields are missing", async () => {
            mockPost.mockResolvedValue({
                data: {
                    result: {
                        account_flags: {},
                    },
                },
            });

            const flags = await service.accountReceiveBlocked("rEmptyFlags");

            expect(flags).toEqual({
                requireDestTag: false,
                depositAuth: false,
            });
        });
    });
});
