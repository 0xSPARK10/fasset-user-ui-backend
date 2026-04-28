/**
 * Unit tests for PoolService.
 *
 * PoolService queries agent pools from the database and combines that data
 * with on-chain information from the asset manager contracts. We mock
 * EntityManager, ExternalApiService, ContractService, and FassetConfigService.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { EntityManager } from "@mikro-orm/core";
import { ConfigService } from "@nestjs/config";

/* ---- mock logger ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

/* ---- mock ethers to prevent heavy module loading ---- */
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

import { PoolService } from "../../src/services/pool.service";
import { ExternalApiService } from "../../src/services/external.api.service";
import { ContractService } from "../../src/services/contract.service";
import { FassetConfigService } from "../../src/services/fasset.config.service";

describe("PoolService", () => {
    let service: PoolService;
    let mockEm: any;
    let mockExternalApiService: any;
    let mockContractService: any;
    let mockFassetConfigService: any;

    /** A mock pool entity matching the Pool entity structure */
    const createMockPool = (overrides: any = {}) => ({
        vaultAddress: "0xVault1",
        poolAddress: "0xPool1",
        tokenAddress: "0xToken1",
        fasset: "FTestXRP",
        agentName: "TestAgent",
        vaultType: "FTestXRP",
        poolCR: 2.5,
        vaultCR: 1.8,
        poolExitCR: 3.0,
        totalPoolCollateral: "10,000.000",
        feeShare: 0.3,
        status: 0,
        freeLots: "50",
        mintFee: 0.025,
        mintNumber: 100,
        redeemSuccessRate: 0.95,
        numLiquidations: 2,
        url: "https://agent.example.com/icon.png",
        poolNatUsd: "5,000.000",
        vaultCollateral: "3,000.000",
        vaultCollateralToken: "USDT",
        vaultCollateralTokenDecimals: 6,
        publiclyAvailable: true,
        mintingPoolCR: 2.2,
        mintingVaultCR: 1.6,
        vaultToken: "0xVaultToken",
        description: "A test agent",
        mintedUBA: "1,000.000",
        mintedUSD: "2,000.000",
        allLots: 200,
        poolOnlyCollateralUSD: "3,000.000",
        vaultOnlyCollateralUSD: "2,000.000",
        remainingUBA: "500.000",
        remainingUSD: "1,000.000",
        totalPortfolioValueUSD: "5,000.000",
        limitUSD: "3,000.000",
        infoUrl: "https://agent.example.com/tos",
        underlyingAddress: "rUnderlyingAddr",
        ...overrides,
    });

    /** Mock collateral entity */
    const mockCollateral = {
        token: "0xVaultToken",
        tokenFtsoSymbol: "USDT",
        minCollateralRatioBIPS: 1.5,
        safetyMinCollateralRatioBIPS: 1.6,
        ccbMinCollateralRatioBIPS: 1,
        decimals: 6,
    };

    const mockPoolCollateral = {
        token: "0xNativeToken",
        tokenFtsoSymbol: "C2FLR",
        minCollateralRatioBIPS: 2.0,
        safetyMinCollateralRatioBIPS: 2.1,
        ccbMinCollateralRatioBIPS: 1,
        decimals: 18,
    };

    /** Mock asset manager contract */
    const mockAssetManager = {
        getSettings: jest.fn().mockResolvedValue({
            assetDecimals: 6n,
            lotSizeAMG: 100n,
            assetMintingGranularityUBA: 1000n,
            mintingCapAMG: 10000n,
        }),
        getAvailableAgentsDetailedList: jest.fn().mockResolvedValue({
            _agents: [
                { agentVault: "0xVault1", feeBIPS: 250n, freeCollateralLots: 100n },
            ],
        }),
    };

    const mockFAsset = {
        totalSupply: jest.fn().mockResolvedValue(5000000n),
    };

    const mockPriceReader = {
        getPrice: jest.fn().mockResolvedValue({ _price: 250000n, _priceDecimals: 5n }),
    };

    beforeEach(async () => {
        jest.clearAllMocks();

        mockEm = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
        };

        mockExternalApiService = {
            getUserCollateralPoolTokens: jest.fn().mockResolvedValue({}),
            getUserTotalClaimedPoolFeesSpecific: jest.fn().mockResolvedValue({}),
        };

        mockContractService = {
            get: jest.fn().mockImplementation((name: string) => {
                if (name.startsWith("AssetManager_")) return mockAssetManager;
                if (name === "PriceReader") return mockPriceReader;
                return mockFAsset;
            }),
            getCollateralPoolContract: jest.fn().mockReturnValue({
                fAssetFeesOf: jest.fn().mockResolvedValue(0n),
                totalCollateral: jest.fn().mockResolvedValue(1000000000000000000n),
            }),
            getCollateralPoolTokenContract: jest.fn().mockReturnValue({
                balanceOf: jest.fn().mockResolvedValue(0n),
                totalSupply: jest.fn().mockResolvedValue(1000000000000000000n),
                transferableBalanceOf: jest.fn().mockResolvedValue(0n),
                nonTimelockedBalanceOf: jest.fn().mockResolvedValue(0n),
            }),
        };

        mockFassetConfigService = {
            getNativeSymbol: jest.fn().mockReturnValue("C2FLR"),
            getFAssetByName: jest.fn().mockReturnValue({
                chainId: "XRP",
                tokenName: "XRP",
                tokenSymbol: "XRP",
                tokenDecimals: 6,
            }),
        };

        const mockConfigService = {
            get: jest.fn().mockImplementation((key: string) => {
                if (key === "NETWORK") return "coston2";
                return undefined;
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PoolService,
                { provide: ExternalApiService, useValue: mockExternalApiService },
                { provide: EntityManager, useValue: mockEm },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: ContractService, useValue: mockContractService },
                { provide: FassetConfigService, useValue: mockFassetConfigService },
            ],
        }).compile();

        service = module.get<PoolService>(PoolService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("getAgentLiveness", () => {
        it("should return false when no liveness record exists", async () => {
            mockEm.findOne.mockResolvedValue(null);

            const result = await service.getAgentLiveness("0xVault1", Date.now());

            expect(result).toBe(false);
        });

        it("should return true when agent was last seen within 2 hours", async () => {
            const now = Date.now();
            mockEm.findOne.mockResolvedValue({
                vaultAddress: "0xVault1",
                lastTimestamp: now - 30 * 60 * 1000, // 30 minutes ago
            });

            const result = await service.getAgentLiveness("0xVault1", now);

            expect(result).toBe(true);
        });

        it("should return false when agent was last seen more than 2 hours ago", async () => {
            const now = Date.now();
            mockEm.findOne.mockResolvedValue({
                vaultAddress: "0xVault1",
                lastTimestamp: now - 3 * 60 * 60 * 1000, // 3 hours ago
            });

            const result = await service.getAgentLiveness("0xVault1", now);

            expect(result).toBe(false);
        });

        it("should return true when agent was last seen exactly 2 hours ago", async () => {
            const now = Date.now();
            mockEm.findOne.mockResolvedValue({
                vaultAddress: "0xVault1",
                lastTimestamp: now - 2 * 60 * 60 * 1000, // exactly 2 hours ago
            });

            const result = await service.getAgentLiveness("0xVault1", now);

            // now - lastTimestamp = 2h exactly, which is NOT > 2h, so status stays true
            expect(result).toBe(true);
        });
    });

    describe("getAgents", () => {
        it("should return empty array when no pools exist", async () => {
            mockEm.find.mockResolvedValue([]);

            const result = await service.getAgents(["FTestXRP"]);

            expect(result).toEqual([]);
        });

        it("should skip agents that are not publicly available", async () => {
            const privateAgent = createMockPool({ publiclyAvailable: false });
            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.fasset) return [privateAgent];
                return [mockCollateral];
            });

            const result = await service.getAgents(["FTestXRP"]);

            expect(result).toEqual([]);
        });

        it("should skip agents with status >= 2 (in liquidation)", async () => {
            const liquidatingAgent = createMockPool({ status: 2, publiclyAvailable: true });
            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.fasset && !filter.token && !filter.tokenFtsoSymbol) return [liquidatingAgent];
                if (filter && filter.token) return [mockCollateral];
                if (filter && filter.tokenFtsoSymbol) return [mockPoolCollateral];
                return [];
            });

            const result = await service.getAgents(["FTestXRP"]);

            expect(result).toEqual([]);
        });

        it("should return formatted agent pool items for valid agents", async () => {
            const agent = createMockPool({ publiclyAvailable: true, status: 0 });
            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.fasset && !filter.token && !filter.tokenFtsoSymbol) return [agent];
                if (filter && filter.token) return [mockCollateral];
                if (filter && filter.tokenFtsoSymbol) return [mockPoolCollateral];
                return [];
            });
            mockEm.findOne.mockResolvedValue({ vaultAddress: "0xVault1", lastTimestamp: Date.now() });

            const result = await service.getAgents(["FTestXRP"]);

            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(result[0].vault).toBe("0xVault1");
            expect(result[0].agentName).toBe("TestAgent");
        });
    });

    describe("getAgentSpecific", () => {
        it("should return a single agent pool item for a given pool address", async () => {
            const agent = createMockPool();
            mockEm.findOne.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.poolAddress) return agent;
                if (filter && filter.vaultAddress) return { vaultAddress: "0xVault1", lastTimestamp: Date.now() };
                if (filter && filter.token) return mockCollateral;
                if (filter && filter.tokenFtsoSymbol) return mockPoolCollateral;
                return null;
            });

            const result = await service.getAgentSpecific("FTestXRP", "0xPool1");

            expect(result).toBeDefined();
            expect(result.vault).toBe("0xVault1");
            expect(result.pool).toBe("0xPool1");
        });
    });

    describe("getAgentsLatest", () => {
        it("should return agents filtered by availability and status", async () => {
            const agent = createMockPool({ status: 0, publiclyAvailable: true });
            mockEm.find.mockResolvedValue([agent]);
            mockEm.findOne.mockResolvedValue({
                vaultAddress: "0xVault1",
                lastTimestamp: Date.now(),
            });

            const result = await service.getAgentsLatest("FTestXRP");

            expect(result.length).toBeGreaterThanOrEqual(1);
            expect(result[0].vault).toBe("0xVault1");
            expect(result[0].freeLots).toBeDefined();
        });

        it("should skip agents not in the available agents list from contract", async () => {
            const agent = createMockPool({ vaultAddress: "0xNotAvailable", status: 0, publiclyAvailable: true });
            mockEm.find.mockResolvedValue([agent]);

            const result = await service.getAgentsLatest("FTestXRP");

            // 0xNotAvailable is not in the mock available agents list
            expect(result).toHaveLength(0);
        });

        it("should return empty array when no agents exist", async () => {
            mockEm.find.mockResolvedValue([]);

            const result = await service.getAgentsLatest("FTestXRP");

            expect(result).toEqual([]);
        });
    });

    describe("getTokenBalanceFromIndexer", () => {
        it("should call externalApiService.getUserCollateralPoolTokens", async () => {
            await service.getTokenBalanceFromIndexer("0xUserAddr");

            expect(mockExternalApiService.getUserCollateralPoolTokens).toHaveBeenCalledWith("0xUserAddr");
        });
    });
});
