/**
 * Unit tests for EarnService.
 *
 * EarnService fetches ecosystem earning app data from a remote JSON URL.
 * It uses node-cron to schedule periodic updates and axios to fetch data.
 * We mock both modules to prevent real HTTP and cron activity.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

/* ---- mock node-cron to prevent actual scheduling ---- */
jest.mock("node-cron", () => ({
    schedule: jest.fn(),
    stop: jest.fn(),
}));

/* ---- mock axios to prevent actual HTTP calls ---- */
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
    },
}));

/* ---- mock logger to suppress log output in tests ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

import { EarnService } from "../../src/services/earn.service";
import axios from "axios";

describe("EarnService", () => {
    let service: EarnService;

    const mockEcosystemData = {
        sparkDex: {
            type: "DEX",
            pairs: ["FXRP/FLR", "FBTC/USDT"],
            coin_type: "ERC-20",
            url: "https://sparkdex.example.com",
            yt_url: "https://youtube.com/example",
            description: "A decentralized exchange",
        },
        kinetic: {
            type: "Lending",
            pairs: ["FXRP", "FBTC"],
            coin_type: "ERC-20",
            url: "https://kinetic.example.com",
            yt_url: "",
            description: "A lending protocol",
        },
    };

    /**
     * Helper to create the test module with configurable env values
     */
    async function createModule(network: string, jsonUrl: string): Promise<TestingModule> {
        const mockConfigService = {
            get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
                if (key === "NETWORK") return network;
                if (key === "EARN_JSON_URL") return jsonUrl;
                return defaultValue ?? undefined;
            }),
        };

        return Test.createTestingModule({
            providers: [EarnService, { provide: ConfigService, useValue: mockConfigService }],
        }).compile();
    }

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe("with valid config (coston2 network, URL provided)", () => {
        beforeEach(async () => {
            const module = await createModule("coston2", "https://example.com/earn.json");
            service = module.get<EarnService>(EarnService);
        });

        it("should be defined", () => {
            expect(service).toBeDefined();
        });

        describe("onModuleInit", () => {
            it("should fetch ecosystem data on init", async () => {
                (axios.get as jest.Mock).mockResolvedValue({ data: mockEcosystemData });

                await service.onModuleInit();

                expect(axios.get).toHaveBeenCalledWith("https://example.com/earn.json");
            });

            it("should store fetched data so getEcosystemList returns it", async () => {
                (axios.get as jest.Mock).mockResolvedValue({ data: mockEcosystemData });

                await service.onModuleInit();

                expect(service.getEcosystemList()).toEqual(mockEcosystemData);
            });

            it("should handle axios error gracefully and not throw", async () => {
                (axios.get as jest.Mock).mockRejectedValue(new Error("Network error"));

                await expect(service.onModuleInit()).resolves.toBeUndefined();
            });

            it("should handle invalid data format gracefully", async () => {
                (axios.get as jest.Mock).mockResolvedValue({ data: "not-an-object" });

                await service.onModuleInit();
                // After invalid data, ecosystemList should still be undefined or empty
                // depending on error handling
            });
        });

        describe("getEcosystemList", () => {
            it("should return the stored ecosystem data after init", async () => {
                (axios.get as jest.Mock).mockResolvedValue({ data: mockEcosystemData });
                await service.onModuleInit();

                const list = service.getEcosystemList();

                expect(list).toEqual(mockEcosystemData);
                expect(Object.keys(list)).toHaveLength(2);
            });
        });
    });

    describe("with empty JSON URL", () => {
        beforeEach(async () => {
            const module = await createModule("coston2", "");
            service = module.get<EarnService>(EarnService);
        });

        it("should return empty object when EARN_JSON_URL is empty", async () => {
            await service.onModuleInit();

            expect(service.getEcosystemList()).toEqual({});
            expect(axios.get).not.toHaveBeenCalled();
        });
    });

    describe("with unsupported network", () => {
        beforeEach(async () => {
            const module = await createModule("songbird", "https://example.com/earn.json");
            service = module.get<EarnService>(EarnService);
        });

        it("should return empty object when network is not coston2 or flare", async () => {
            await service.onModuleInit();

            expect(service.getEcosystemList()).toEqual({});
            expect(axios.get).not.toHaveBeenCalled();
        });
    });

    describe("with flare network (valid)", () => {
        beforeEach(async () => {
            const module = await createModule("flare", "https://example.com/earn.json");
            service = module.get<EarnService>(EarnService);
        });

        it("should fetch ecosystem data when network is flare", async () => {
            (axios.get as jest.Mock).mockResolvedValue({ data: mockEcosystemData });

            await service.onModuleInit();

            expect(axios.get).toHaveBeenCalledWith("https://example.com/earn.json");
            expect(service.getEcosystemList()).toEqual(mockEcosystemData);
        });
    });

    describe("onApplicationBootstrap", () => {
        beforeEach(async () => {
            const cron = require("node-cron");
            const module = await createModule("coston2", "https://example.com/earn.json");
            service = module.get<EarnService>(EarnService);
        });

        it("should schedule a cron job every 5 minutes", () => {
            const cron = require("node-cron");
            service.onApplicationBootstrap();

            expect(cron.schedule).toHaveBeenCalledWith("*/5 * * * *", expect.any(Function));
        });
    });

    describe("onModuleDestroy", () => {
        beforeEach(async () => {
            const module = await createModule("coston2", "https://example.com/earn.json");
            service = module.get<EarnService>(EarnService);
        });

        it("should stop the cron scheduler", async () => {
            const cron = require("node-cron");
            await service.onModuleDestroy();

            expect(cron.stop).toHaveBeenCalled();
        });
    });
});
