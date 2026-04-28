/**
 * Unit tests for UserService.
 *
 * UserService is the largest service in the backend, orchestrating minting,
 * redemption, fee queries, and ecosystem information. It depends on many
 * services and contracts. We mock all dependencies and the contract layer
 * to test each method in isolation.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { EntityManager } from "@mikro-orm/core";
import { ConfigService } from "@nestjs/config";
import { HttpService } from "@nestjs/axios";
import { CACHE_MANAGER } from "@nestjs/cache-manager";

/* ---- mock logger ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

/* ---- mock ethers ---- */
jest.mock("ethers", () => {
    class MockContractFactory {}
    return {
        keccak256: jest.fn().mockReturnValue("0xmockedKeccak"),
        toUtf8Bytes: jest.fn().mockReturnValue(new Uint8Array(0)),
        ethers: { JsonRpcProvider: jest.fn(), Wallet: jest.fn() },
        FetchRequest: jest.fn().mockImplementation(() => ({ setHeader: jest.fn() })),
        Contract: jest.fn(),
        Interface: jest.fn(),
        ContractFactory: MockContractFactory,
    };
});

import { UserService } from "../../src/services/user.service";
import { BotService } from "../../src/services/bot.init.service";
import { ExternalApiService } from "../../src/services/external.api.service";
import { XRPLApiService } from "../../src/services/xrpl-api.service";
import { ContractService } from "../../src/services/contract.service";
import { EthersService } from "../../src/services/ethers.service";
import { FassetConfigService } from "../../src/services/fasset.config.service";
import { Minting } from "../../src/entities/Minting";
import { CollateralReservationEvent } from "../../src/entities/CollateralReservation";

describe("UserService", () => {
    let service: UserService;
    let mockEm: any;
    let mockBotService: any;
    let mockCacheManager: any;
    let mockExternalApiService: any;
    let mockXrplService: any;
    let mockContractService: any;
    let mockEthersService: any;
    let mockFassetConfigService: any;
    let mockHttpService: any;
    let mockConfigService: any;

    /** Mock asset manager contract that covers most methods */
    const mockAssetManager = {
        collateralReservationFee: jest.fn().mockResolvedValue(1000000n),
        getSettings: jest.fn().mockResolvedValue({
            lotSizeAMG: 100n,
            assetMintingGranularityUBA: 1000n,
            assetDecimals: 6n,
            mintingCapAMG: 10000n,
            redemptionFeeBIPS: 200n,
            attestationWindowSeconds: 86400n,
            priceReader: "0xPriceReaderAddr",
            agentOwnerRegistry: "0xAgentRegistryAddr",
            maxRedeemedTickets: 10n,
        }),
        getAgentInfo: jest.fn().mockResolvedValue({
            status: 0n,
            feeBIPS: 250n,
            ownerManagementAddress: "0xOwner",
            underlyingAddressString: "rXRPAddress",
            reservedUBA: 0n,
            collateralPool: "0xPoolAddr",
            totalPoolCollateralNATWei: 1000000000000000000n,
            totalVaultCollateralWei: 500000n,
            poolCollateralRatioBIPS: 20000n,
            vaultCollateralRatioBIPS: 15000n,
            poolExitCollateralRatioBIPS: 25000n,
            poolFeeShareBIPS: 3000n,
            mintingPoolCollateralRatioBIPS: 22000n,
            mintingVaultCollateralRatioBIPS: 16000n,
            mintedUBA: 500000n,
            freeCollateralLots: 100n,
            vaultCollateralToken: "0xVaultToken",
            publiclyAvailable: true,
        }),
        getAddress: jest.fn().mockResolvedValue("0xAssetManagerAddr"),
        getAvailableAgentsDetailedList: jest.fn().mockResolvedValue([
            [{ agentVault: "0xVault1", feeBIPS: 250n, freeCollateralLots: 100n }],
        ]),
        emergencyPaused: jest.fn().mockResolvedValue(false),
        assetPriceNatWei: jest.fn().mockResolvedValue([1000000n, 1000000n]),
        getFAssetsBackedByPool: jest.fn().mockResolvedValue(5000000n),
        interface: {
            decodeEventLog: jest.fn(),
            parseLog: jest.fn(),
        },
    };

    /** Mock price reader contract */
    const mockPriceReader = {
        getPrice: jest.fn().mockResolvedValue([250000n, 0n, 5n]),
    };

    /** Mock fAsset contract */
    const mockFAsset = {
        assetSymbol: jest.fn().mockResolvedValue("XRP"),
        symbol: jest.fn().mockResolvedValue("FXRP"),
        totalSupply: jest.fn().mockResolvedValue(50000000n),
        balanceOf: jest.fn().mockResolvedValue(1000000n),
        decimals: jest.fn().mockResolvedValue(6n),
        getAddress: jest.fn().mockResolvedValue("0xFAssetAddr"),
    };

    /** Mock WNat contract */
    const mockWNat = {
        balanceOf: jest.fn().mockResolvedValue(500000000000000000n),
        getAddress: jest.fn().mockResolvedValue("0xWNatAddr"),
    };

    /** Mock Relay contract */
    const mockRelay = {
        getVotingRoundId: jest.fn().mockResolvedValue(100n),
    };

    /** Mock AgentOwnerRegistry */
    const mockAgentOwnerRegistry = {
        getAgentName: jest.fn().mockResolvedValue("TestAgent"),
    };

    beforeEach(async () => {
        jest.clearAllMocks();

        mockEm = {
            findOne: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
            persistAndFlush: jest.fn().mockResolvedValue(undefined),
            removeAndFlush: jest.fn().mockResolvedValue(undefined),
        };

        mockBotService = {
            fassetList: ["FTestXRP"],
            getEcosystemInfo: jest.fn().mockReturnValue({
                tvl: "1000000",
                numAgents: 10,
                agentsInLiquidation: 0,
            }),
            getTimeSeries: jest.fn().mockResolvedValue({
                tvl: [{ timestamp: 1000, value: "100" }],
            }),
            getCollateralList: jest.fn().mockReturnValue(["USDT"]),
            getFassetDecimals: jest.fn().mockReturnValue(6),
        };

        mockCacheManager = {
            get: jest.fn().mockResolvedValue(undefined),
            set: jest.fn().mockResolvedValue(undefined),
        };

        mockExternalApiService = {
            submitTX: jest.fn().mockResolvedValue("txhash123"),
            getBlockBookHeight: jest.fn().mockResolvedValue("850000"),
            getFeeEstimationBlockHeight: jest.fn().mockResolvedValue({
                averageFeePerKb: 50000,
                decilesFeePerKb: [10000, 30000, 50000],
            }),
            getUserCollateralPoolTokens: jest.fn().mockResolvedValue({}),
            getUserTotalClaimedPoolFees: jest.fn().mockResolvedValue({}),
            getDefaultEvent: jest.fn(),
        };

        mockXrplService = {
            getAccountInfo: jest.fn().mockResolvedValue({
                data: {
                    result: {
                        account_data: { Balance: "1000000" },
                        account_flags: { requireDestinationTag: false, depositAuth: false },
                    },
                },
            }),
            accountReceiveBlocked: jest.fn().mockResolvedValue({ requireDestTag: false, depositAuth: false }),
        };

        mockContractService = {
            get: jest.fn().mockImplementation((name: string) => {
                if (name.startsWith("AssetManager_")) return mockAssetManager;
                if (name === "PriceReader") return mockPriceReader;
                if (name === "AgentOwnerRegistry") return mockAgentOwnerRegistry;
                if (name === "Relay") return mockRelay;
                if (name === "WNat") return mockWNat;
                // Assume remaining are FAsset contracts
                return mockFAsset;
            }),
            getCollateralPoolContract: jest.fn(),
            getCollateralPoolTokenContract: jest.fn(),
        };

        mockEthersService = {
            getExecutorAddress: jest.fn().mockReturnValue("0xExecutorAddr"),
            getProvider: jest.fn().mockReturnValue({
                getBalance: jest.fn().mockResolvedValue(2000000000000000000n),
                getBlock: jest.fn().mockResolvedValue({ timestamp: Math.floor(Date.now() / 1000) }),
                getTransactionReceipt: jest.fn(),
            }),
        };

        mockFassetConfigService = {
            getVerifier: jest.fn().mockReturnValue({
                getTransactionsByReference: jest.fn().mockResolvedValue([]),
                getLastFinalizedBlockNumber: jest.fn().mockResolvedValue(1000),
                getBlock: jest.fn().mockResolvedValue({ timestamp: Date.now(), number: 1000 }),
            }),
            getFAssetByName: jest.fn().mockReturnValue({
                chainId: "XRP",
                tokenName: "XRP",
                tokenSymbol: "XRP",
                tokenDecimals: 6,
            }),
            getNativeSymbol: jest.fn().mockReturnValue("C2FLR"),
        };

        mockHttpService = {
            get: jest.fn(),
        };

        mockConfigService = {
            get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
                if (key === "APP_TYPE") return "dev";
                if (key === "COSTON_EXPLORER_URL") return "https://explorer.example.com";
                if (key === "NATIVE_TOKEN_SYMBOL") return defaultValue || "C2FLR";
                return defaultValue ?? undefined;
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UserService,
                { provide: BotService, useValue: mockBotService },
                { provide: EntityManager, useValue: mockEm },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: HttpService, useValue: mockHttpService },
                { provide: CACHE_MANAGER, useValue: mockCacheManager },
                { provide: ExternalApiService, useValue: mockExternalApiService },
                { provide: XRPLApiService, useValue: mockXrplService },
                { provide: ContractService, useValue: mockContractService },
                { provide: EthersService, useValue: mockEthersService },
                { provide: FassetConfigService, useValue: mockFassetConfigService },
            ],
        }).compile();

        service = module.get<UserService>(UserService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("listAvailableFassets", () => {
        it("should return fassets from botService.fassetList", () => {
            const result = service.listAvailableFassets();

            expect(result).toEqual({ fassets: ["FTestXRP"] });
        });

        it("should reflect changes in botService.fassetList", () => {
            mockBotService.fassetList = ["FTestXRP", "FTestBTC"];

            const result = service.listAvailableFassets();

            expect(result.fassets).toHaveLength(2);
            expect(result.fassets).toContain("FTestBTC");
        });
    });

    describe("getCRTFee", () => {
        it("should return collateral reservation fee as string", async () => {
            const result = await service.getCRTFee("FTestXRP", 5);

            expect(result).toEqual({ collateralReservationFee: "1000000" });
            expect(mockAssetManager.collateralReservationFee).toHaveBeenCalledWith(5);
        });

        it("should propagate errors from the contract", async () => {
            mockAssetManager.collateralReservationFee.mockRejectedValueOnce(new Error("Contract error"));

            await expect(service.getCRTFee("FTestXRP", 5)).rejects.toThrow("Contract error");
        });
    });

    describe("getLotSize", () => {
        it("should calculate and return the lot size from settings", async () => {
            const result = await service.getLotSize("FTestXRP");

            // lotSizeAMG(100) * assetMintingGranularityUBA(1000) = 100000
            // formatted: 100000 / 10^6 = 0.1
            expect(result).toEqual({ lotSize: 0.1 });
        });
    });

    describe("getAssetManagerAddress", () => {
        it("should return the asset manager address", async () => {
            const result = await service.getAssetManagerAddress("FTestXRP");

            expect(result).toEqual({ address: "0xAssetManagerAddr" });
        });
    });

    describe("getExecutorAddress", () => {
        it("should return executor address, fee, and redemption fee", async () => {
            const result = await service.getExecutorAddress("FTestXRP");

            expect(result.executorAddress).toBe("0xExecutorAddr");
            expect(result.executorFee).toBeDefined();
            expect(result.redemptionFee).toBe("200");
        });

        it("should call ethersService.getExecutorAddress", async () => {
            await service.getExecutorAddress("FTestXRP");

            expect(mockEthersService.getExecutorAddress).toHaveBeenCalled();
        });
    });

    describe("mintingStatus", () => {
        it("should return status false and step 0 when minting not found", async () => {
            mockEm.findOne.mockResolvedValue(null);

            const result = await service.mintingStatus("0xUnknownHash");

            expect(result).toEqual({ status: false, step: 0 });
        });

        it("should return step 0 when minting is unprocessed and state is false", async () => {
            mockEm.findOne.mockResolvedValue({
                processed: false,
                state: false,
                proved: false,
                proofRequestRound: 104,
            });

            const result = await service.mintingStatus("0xHash1");

            expect(result.status).toBe(false);
            expect(result.step).toBe(0);
        });

        it("should return step 4 when minting is fully processed", async () => {
            mockEm.findOne.mockResolvedValue({
                processed: true,
                state: true,
                proved: true,
                proofRequestRound: 100,
            });

            const result = await service.mintingStatus("0xHash2");

            expect(result.status).toBe(true);
            expect(result.step).toBe(4);
        });

        it("should return step 3 when proved but not processed", async () => {
            mockEm.findOne.mockResolvedValue({
                processed: false,
                state: true,
                proved: true,
                proofRequestRound: 100,
            });

            const result = await service.mintingStatus("0xHash3");

            expect(result.status).toBe(false);
            expect(result.step).toBe(3);
        });
    });

    describe("getCrStatus", () => {
        it("should return status false when CR event not found", async () => {
            mockEm.findOne.mockResolvedValue(null);

            const result = await service.getCrStatus("999");

            expect(result).toEqual({ status: false });
        });

        it("should return CR details when event is found", async () => {
            mockEm.findOne.mockResolvedValue({
                collateralReservationId: "123",
                feeUBA: "1000",
                valueUBA: "50000",
                paymentAddress: "rPaymentAddr",
                paymentReference: "0xPayRef",
            });

            const result = await service.getCrStatus("123");

            expect(result.status).toBe(true);
            expect(result.accepted).toBe(true);
            expect(result.paymentAmount).toBe("51000"); // 1000 + 50000
            expect(result.paymentAddress).toBe("rPaymentAddr");
            expect(result.paymentReference).toBe("0xPayRef");
        });
    });

    describe("requestMinting", () => {
        it("should return early when collateralReservationId is empty", async () => {
            await service.requestMinting({
                fasset: "FTestXRP",
                collateralReservationId: "",
                txhash: "0xHash",
                paymentAddress: "rAddr",
                userUnderlyingAddress: "rUser",
                userAddress: "0xUser",
                amount: "100",
                nativeHash: "0xNative",
                vaultAddress: "0xVault",
            });

            // Should not try to save minting data
            expect(mockEm.count).not.toHaveBeenCalled();
        });

        it("should not duplicate minting if txhash already exists", async () => {
            mockEm.count.mockResolvedValue(1); // already exists
            mockEm.findOne.mockResolvedValue(null); // no wallet found

            await service.requestMinting({
                fasset: "FTestXRP",
                collateralReservationId: "123",
                txhash: "0xExistingHash",
                paymentAddress: "rAddr",
                userUnderlyingAddress: "rUser",
                userAddress: "0xUser",
                amount: "100",
                nativeHash: "0xNative",
                vaultAddress: "0xVault",
            });

            // Should not persist since it already exists
            expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
        });
    });

    describe("submitTx", () => {
        it("should call externalApiService.submitTX and return hash", async () => {
            const result = await service.submitTx("FTestBTC", "rawtxhex");

            expect(result).toEqual({ hash: "txhash123" });
            expect(mockExternalApiService.submitTX).toHaveBeenCalledWith("FTestBTC", "rawtxhex");
        });

        it("should throw LotsException when submitTX fails", async () => {
            mockExternalApiService.submitTX.mockRejectedValue({ error: "invalid tx" });

            await expect(service.submitTx("FTestBTC", "badtx")).rejects.toThrow();
        });
    });

    describe("getEcosystemInfo", () => {
        it("should return ecosystem info from botService", async () => {
            const result = await service.getEcosystemInfo();

            expect(result).toEqual(mockBotService.getEcosystemInfo());
            expect(mockBotService.getEcosystemInfo).toHaveBeenCalled();
        });
    });

    describe("getTimeData", () => {
        it("should return time series data from botService", async () => {
            const result = await service.getTimeData("24h");

            expect(mockBotService.getTimeSeries).toHaveBeenCalledWith("24h");
        });
    });

    describe("estimateFeeForBlocks", () => {
        it("should return hardcoded fee for XRP fasset", async () => {
            const result = await service.estimateFeeForBlocks("FTestXRP");

            expect(result).toEqual({ estimatedFee: "1000", extraBTC: "0.0045" });
        });

        it("should calculate fee from blockbook data for BTC fasset", async () => {
            const result = await service.estimateFeeForBlocks("FTestBTC");

            // Should have called external API for block height and fee estimation
            expect(mockExternalApiService.getBlockBookHeight).toHaveBeenCalledWith("FTestBTC");
        });

        it("should use cached fee if available for BTC fasset", async () => {
            mockCacheManager.get.mockResolvedValue("50000");

            const result = await service.estimateFeeForBlocks("FTestBTC");

            expect(result.estimatedFee).toBeDefined();
        });
    });

    describe("getRedemptionQueue", () => {
        it("should return redemption queue data from cache", async () => {
            mockCacheManager.get.mockImplementation((key: string) => {
                if (key === "FTestXRPmaxLotsSingleRedeem") return 50;
                if (key === "FTestXRPmaxLotsTotalRedeem") return 200;
                return undefined;
            });

            const result = await service.getRedemptionQueue("FTestXRP");

            expect(result.maxLotsOneRedemption).toBe(50);
            expect(result.maxLots).toBe(200);
        });

        it("should return NaN maxLots when cache is empty", async () => {
            mockCacheManager.get.mockResolvedValue(undefined);

            const result = await service.getRedemptionQueue("FTestXRP");

            expect(result.maxLots).toBeNaN();
        });
    });

    describe("getMintingEnabled", () => {
        it("should return fasset status with minting enabled when not paused", async () => {
            mockAssetManager.emergencyPaused.mockResolvedValue(false);

            const result = await service.getMintingEnabled();

            expect(result).toEqual([{ fasset: "FTestXRP", status: true }]);
        });

        it("should return fasset status with minting disabled when paused", async () => {
            mockAssetManager.emergencyPaused.mockResolvedValue(true);

            const result = await service.getMintingEnabled();

            expect(result).toEqual([{ fasset: "FTestXRP", status: false }]);
        });

        it("should check all fassets in the list", async () => {
            mockBotService.fassetList = ["FTestXRP", "FTestBTC"];
            mockAssetManager.emergencyPaused.mockResolvedValue(false);

            const result = await service.getMintingEnabled();

            expect(result).toHaveLength(2);
        });
    });

    describe("isValidRippleTxHash", () => {
        it("should return true for valid 64 hex character hash", () => {
            const validHash = "A".repeat(64);
            expect(service.isValidRippleTxHash(validHash)).toBe(true);
        });

        it("should return true for lowercase hex hash", () => {
            const validHash = "a1b2c3d4e5f6".padEnd(64, "0");
            expect(service.isValidRippleTxHash(validHash)).toBe(true);
        });

        it("should return false for hash shorter than 64 chars", () => {
            expect(service.isValidRippleTxHash("ABC123")).toBe(false);
        });

        it("should return false for hash longer than 64 chars", () => {
            expect(service.isValidRippleTxHash("A".repeat(65))).toBe(false);
        });

        it("should return false for non-hex characters", () => {
            const invalidHash = "G".repeat(64);
            expect(service.isValidRippleTxHash(invalidHash)).toBe(false);
        });

        it("should return false for empty string", () => {
            expect(service.isValidRippleTxHash("")).toBe(false);
        });
    });

    describe("shuffleArray", () => {
        it("should return a new array with the same elements", () => {
            const original = [1, 2, 3, 4, 5];
            const shuffled = service.shuffleArray(original);

            expect(shuffled).toHaveLength(original.length);
            expect(shuffled.sort()).toEqual(original.sort());
        });

        it("should not modify the original array", () => {
            const original = [1, 2, 3, 4, 5];
            const copy = [...original];
            service.shuffleArray(original);

            expect(original).toEqual(copy);
        });

        it("should handle empty arrays", () => {
            expect(service.shuffleArray([])).toEqual([]);
        });

        it("should handle single-element arrays", () => {
            expect(service.shuffleArray([42])).toEqual([42]);
        });
    });

    describe("getAssetPrice", () => {
        it("should return price from cache when available", async () => {
            mockCacheManager.get.mockResolvedValue(2.5);

            const result = await service.getAssetPrice("FTestXRP");

            expect(result).toEqual({ price: 2.5 });
        });

        it("should calculate price from priceReader when not cached", async () => {
            mockCacheManager.get.mockResolvedValue(undefined);
            mockPriceReader.getPrice.mockResolvedValue([250000n, 0n, 5n]);

            const result = await service.getAssetPrice("FTestXRP");

            expect(result.price).toBeDefined();
            expect(typeof result.price).toBe("number");
        });

        it("should cache the calculated price", async () => {
            mockCacheManager.get.mockResolvedValue(undefined);
            mockPriceReader.getPrice.mockResolvedValue([250000n, 0n, 5n]);

            await service.getAssetPrice("FTestXRP");

            expect(mockCacheManager.set).toHaveBeenCalledWith(
                "FTestXRP-price",
                expect.any(Number),
                5000
            );
        });
    });

    describe("getRedemptionFeeData", () => {
        it("should return redemption fee data for each fasset", async () => {
            const result = await service.getRedemptionFeeData();

            expect(result).toHaveLength(1);
            expect(result[0].fasset).toBe("FTestXRP");
            expect(result[0].feePercentage).toBeDefined();
            expect(result[0].feeUSD).toBeDefined();
        });

        it("should calculate fee percentage from redemptionFeeBIPS", async () => {
            const result = await service.getRedemptionFeeData();

            // redemptionFeeBIPS = 200, so percentage = 200/100 = 2.0%
            expect(result[0].feePercentage).toBe("2");
        });
    });

    describe("checkStateFassets", () => {
        it("should return emergency pause state for each fasset", async () => {
            mockAssetManager.emergencyPaused.mockResolvedValue(false);

            const result = await service.checkStateFassets();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ fasset: "FTestXRP", state: false });
        });
    });

    describe("getProtocolFees", () => {
        it("should return redemption fee from settings", async () => {
            const result = await service.getProtocolFees("FTestXRP");

            expect(result).toEqual({ redemptionFee: "200" });
        });
    });

    describe("getCollateralReservationFee", () => {
        it("should return the collateral reservation fee as a string", async () => {
            mockAssetManager.collateralReservationFee.mockResolvedValue(2500000n);

            const result = await service.getCollateralReservationFee("FTestXRP", 10);

            expect(result).toBe("2500000");
        });
    });

    describe("getUniqueAddresses", () => {
        it("should filter out the underlying address and return unique addresses", () => {
            const addresses = ["addr1", "addr2", "addr3", "addr1", "underlyingAddr"];
            const result = service.getUniqueAddresses(addresses, "underlyingAddr");

            expect(result).not.toContain("underlyingAddr");
            expect(result).toContain("addr1");
            expect(result).toContain("addr2");
            expect(result).toContain("addr3");
        });

        it("should return empty array when all addresses are the underlying address", () => {
            const result = service.getUniqueAddresses(["rAddr", "rAddr"], "rAddr");

            expect(result).toEqual([]);
        });

        it("should deduplicate addresses", () => {
            const result = service.getUniqueAddresses(["a", "b", "a", "b"], "c");

            expect(result).toHaveLength(2);
        });
    });

    describe("getNativeBalancesWithAddresses", () => {
        beforeEach(() => {
            // No vault collaterals by default to keep WNAT/FAsset tests clean
            mockBotService.getCollateralList.mockReturnValue([]);
        });

        it("should return WNAT balance with address instead of native balance", async () => {
            const result = await service.getNativeBalancesWithAddresses("0xUserAddr");

            expect(result[0].symbol).toBe("WC2FLR");
            expect(result[0].address).toBe("0xWNatAddr");
            expect(result[0].balance).toBeDefined();
            expect(result[0].exact).toBe("500000000000000000");
            expect(result[0].type).toBe("wnat");
            expect(mockWNat.balanceOf).toHaveBeenCalledWith("0xUserAddr");
            expect(mockWNat.getAddress).toHaveBeenCalled();
        });

        it("should return fasset balance with token address", async () => {
            const result = await service.getNativeBalancesWithAddresses("0xUserAddr");

            // First item is WNAT, second is the FAsset
            const fassetItem = result.find((r) => r.symbol === "FXRP");
            expect(fassetItem).toBeDefined();
            expect(fassetItem.address).toBe("0xFAssetAddr");
            expect(fassetItem.balance).toBeDefined();
            expect(fassetItem.exact).toBe("1000000");
            expect(fassetItem.type).toBe("fasset");
        });

        it("should return collateral balances with token addresses", async () => {
            mockBotService.getCollateralList.mockReturnValue(["USDT"]);
            mockEm.findOne.mockResolvedValue({ token: "0xUSDTAddr", tokenFtsoSymbol: "USDT" });

            // FakeERC20__factory.connect is mocked globally, so we mock its return
            const { FakeERC20__factory: MockFactory } = require("../../src/typechain-ethers-v6");
            MockFactory.connect = jest.fn().mockReturnValue({
                balanceOf: jest.fn().mockResolvedValue(500000n),
                decimals: jest.fn().mockResolvedValue(6n),
            });

            const result = await service.getNativeBalancesWithAddresses("0xUserAddr");

            const collateralItem = result.find((r) => r.symbol === "USDT0");
            expect(collateralItem).toBeDefined();
            expect(collateralItem.address).toBe("0xUSDTAddr");
            expect(collateralItem.exact).toBe("500000");
            expect(collateralItem.type).toBe("collateral");
        });

        it("should propagate errors", async () => {
            mockWNat.balanceOf.mockRejectedValueOnce(new Error("WNat error"));

            await expect(service.getNativeBalancesWithAddresses("0xUserAddr")).rejects.toThrow("WNat error");
        });
    });
});
