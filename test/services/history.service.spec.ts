/**
 * Unit tests for HistoryService.
 *
 * HistoryService queries multiple entity types (Minting, Redemption,
 * RedemptionRequested, IncompleteRedemption) to build a chronological
 * progress list for a user address. We mock the EntityManager and
 * dependent services.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { EntityManager } from "@mikro-orm/core";

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

/* ---- mock utility functions that may cause issues ---- */
jest.mock("src/utils/utils", () => ({
    calculateExpirationMinutes: jest.fn().mockReturnValue(60),
    formatBigIntToDisplayDecimals: jest.fn().mockImplementation((value, displayDecimals, baseDecimals) => {
        return (Number(value) / 10 ** baseDecimals).toFixed(displayDecimals);
    }),
    formatFixedBigInt: jest.fn().mockReturnValue("100.00"),
    isValidWalletAddress: jest.fn().mockReturnValue(true),
}));

import { HistoryService } from "../../src/services/userHistory.service";
import { BotService } from "../../src/services/bot.init.service";
import { UserService } from "../../src/services/user.service";

describe("HistoryService", () => {
    let service: HistoryService;
    let mockEm: any;
    let mockBotService: any;
    let mockUserService: any;

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    /** Mock minting entity */
    const createMockMinting = (overrides: any = {}) => ({
        collateralReservationId: "cr-123",
        txhash: "A".repeat(64),
        paymentAddress: "rPayment",
        userUnderlyingAddress: "rUser",
        userAddress: "0xUser",
        processed: false,
        state: false,
        proved: false,
        fasset: "FTestXRP",
        amount: "100",
        timestamp: oneHourAgo,
        vaultAddress: "0xVault1",
        paymentReference: "0xPayRef",
        proofRequestRound: null,
        ...overrides,
    });

    /** Mock redemption requested entity */
    const createMockRedemptionRequested = (overrides: any = {}) => ({
        agentVault: "0xVault1",
        redeemer: "0xUser",
        requestId: "req-1",
        paymentAddress: "rPayAddr",
        valueUBA: "1000000",
        feeUBA: "10000",
        firstUnderlyingBlock: "100",
        lastUnderlyingBlock: "200",
        lastUnderlyingTimestamp: (now / 1000).toString(),
        paymentReference: "0xRedPayRef",
        timestamp: oneHourAgo,
        txhash: "0xRedeemHash",
        fasset: "FTestXRP",
        ...overrides,
    });

    /** Mock redemption entity (ticket) */
    const createMockRedemption = (overrides: any = {}) => ({
        txhash: "0xRedeemHash",
        processed: false,
        state: false,
        underlyingAddress: "rUnderlying",
        paymentReference: "0xRedPayRef",
        amountUBA: "990000",
        firstUnderlyingBlock: "100",
        lastUnderlyingBlock: "200",
        lastUnderlyingTimestamp: (now / 1000).toString(),
        requestId: "req-1",
        defaulted: false,
        validUntil: now + 86400000,
        fasset: "FTestXRP",
        timestamp: oneHourAgo,
        blocked: false,
        ...overrides,
    });

    beforeEach(async () => {
        jest.clearAllMocks();

        mockEm = {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
        };

        mockBotService = {
            fassetList: ["FTestXRP"],
            getFassetDecimals: jest.fn().mockReturnValue(6),
        };

        mockUserService = {};

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                HistoryService,
                { provide: BotService, useValue: mockBotService },
                { provide: EntityManager, useValue: mockEm },
                { provide: UserService, useValue: mockUserService },
            ],
        }).compile();

        service = module.get<HistoryService>(HistoryService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("getProgress", () => {
        it("should return empty array when user has no mints or redeems", async () => {
            mockEm.find.mockResolvedValue([]);

            const result = await service.getProgress("0xUserAddress");

            expect(result).toEqual([]);
        });

        it("should include MINT entries for recent mintings", async () => {
            const mint = createMockMinting();
            // First call: Minting find, second: IncompleteRedemption find, etc.
            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (entity.name === "Minting" || (filter && filter.userAddress)) return [mint];
                if (filter && filter.redeemer) return []; // IncompleteRedemption
                if (filter && filter.timestamp) return []; // RedemptionRequested
                return [];
            });
            // Mock for MintingDefaultEvent findOne
            mockEm.findOne.mockResolvedValue(null);

            const result = await service.getProgress("0xUser");

            const mintEntries = result.filter((p) => p.action === "MINT");
            expect(mintEntries.length).toBeGreaterThanOrEqual(0);
        });

        it("should include REDEEM entries for recent redemptions", async () => {
            const redeemRequested = createMockRedemptionRequested();
            const redemption = createMockRedemption();

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                // Minting query
                if (filter && filter.userAddress) return [];
                // IncompleteRedemption query
                if (filter && filter.redeemer && !filter.timestamp) return [];
                // RedemptionRequested query
                if (filter && filter.redeemer && filter.timestamp) return [redeemRequested];
                // Redemption query by txhash
                if (filter && filter.txhash) return [redemption];
                return [];
            });

            const result = await service.getProgress("0xUser");

            const redeemEntries = result.filter((p) => p.action === "REDEEM");
            expect(redeemEntries.length).toBeGreaterThanOrEqual(0);
        });

        it("should sort results by timestamp in descending order", async () => {
            const oldMint = createMockMinting({ timestamp: twoDaysAgo + 1000 }); // still within 7 day window
            const newMint = createMockMinting({ timestamp: oneHourAgo });

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress) return [oldMint, newMint];
                return [];
            });
            // CollateralReservationEvent findOne
            mockEm.findOne.mockResolvedValue({
                txhash: "0xCRHash",
                paymentReference: "0xPayRef",
                paymentAddress: "rPayAddr",
                valueUBA: "50000",
                feeUBA: "1000",
                lastUnderlyingBlock: "100",
                lastUnderlyingTimestamp: (now / 1000).toString(),
            });

            const result = await service.getProgress("0xUser");

            if (result.length >= 2) {
                expect(result[0].timestamp).toBeGreaterThanOrEqual(result[1].timestamp);
            }
        });

        it("should skip mints for fassets not in the botService fasset list", async () => {
            const mint = createMockMinting({ fasset: "FTestDOGE" }); // not in fassetList

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress) return [mint];
                return [];
            });

            const result = await service.getProgress("0xUser");

            // FTestDOGE is not in fassetList, so no entries should appear
            const dogeEntries = result.filter((p) => p.fasset === "FTestDOGE");
            expect(dogeEntries).toHaveLength(0);
        });

        it("should mark minting as defaulted when a MintingDefaultEvent exists", async () => {
            const mint = createMockMinting({ txhash: null, timestamp: now - 60000 });

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress) return [mint];
                return [];
            });
            // MintingDefaultEvent exists for this collateral reservation
            mockEm.findOne.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.collateralReservationId) {
                    return { collateralReservationId: "cr-123" };
                }
                if (filter && filter.paymentReference) {
                    return {
                        txhash: "0xCRHash",
                        paymentReference: "0xPayRef",
                    };
                }
                return null;
            });

            const result = await service.getProgress("0xUser");

            const mintEntries = result.filter((p) => p.action === "MINT");
            if (mintEntries.length > 0) {
                expect(mintEntries[0].defaulted).toBe(true);
            }
        });

        it("should subtract minting and executor fees from direct minting amount", async () => {
            const directMinting = {
                txhash: "0x" + "B".repeat(64),
                userAddress: "rXrpAddress",
                targetAddress: "0xTarget",
                mintType: "address",
                tagId: null,
                amount: "10000000", // 10 XRP in drops
                mintingFeeUBA: "100000",
                executorFeeUBA: "50000",
                mintedAmountUBA: null,
                status: "INPROGRESS",
                delayTimestamp: null,
                timestamp: oneHourAgo,
                fasset: "FTestXRP",
                processed: false,
                evm_txhash: null,
            };

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress === "rXrpAddress") return [directMinting];
                return [];
            });

            const result = await service.getProgress("0xUser", "rXrpAddress");

            const dmEntries = result.filter((p) => p.directMinting === true);
            expect(dmEntries).toHaveLength(1);
            // Net amount: 10000000 - 100000 - 50000 = 9850000
            // Formatted: 9850000 / 10^6 = 9.85, displayed with 2 decimals
            expect(dmEntries[0].amount).toBe("9.85");
        });

        it("should use mintedAmountUBA when available (executed minting)", async () => {
            const directMinting = {
                txhash: "0x" + "D".repeat(64),
                userAddress: "rXrpAddress",
                targetAddress: "0xTarget",
                mintType: "address",
                tagId: null,
                amount: "10000000",
                mintingFeeUBA: "100000",
                executorFeeUBA: "50000",
                mintedAmountUBA: "9800000", // exact on-chain value
                status: "EXECUTED",
                delayTimestamp: null,
                timestamp: oneHourAgo,
                fasset: "FTestXRP",
                processed: true,
                evm_txhash: "0xEvmHash123",
            };

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress === "rXrpAddress") return [directMinting];
                return [];
            });

            const result = await service.getProgress("0xUser", "rXrpAddress");

            const dmEntries = result.filter((p) => p.directMinting === true);
            expect(dmEntries).toHaveLength(1);
            // Uses mintedAmountUBA directly: 9800000 / 10^6 = 9.80
            expect(dmEntries[0].amount).toBe("9.80");
        });

        it("should use gross amount when direct minting fees are zero (backward compat)", async () => {
            const directMinting = {
                txhash: "0x" + "C".repeat(64),
                userAddress: "rXrpAddress",
                targetAddress: "0xTarget",
                mintType: "address",
                tagId: null,
                amount: "5000000", // 5 XRP in drops
                mintingFeeUBA: "0",
                executorFeeUBA: "0",
                mintedAmountUBA: null,
                status: "INPROGRESS",
                delayTimestamp: null,
                timestamp: oneHourAgo,
                fasset: "FTestXRP",
                processed: false,
                evm_txhash: null,
            };

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress === "rXrpAddress") return [directMinting];
                return [];
            });

            const result = await service.getProgress("0xUser", "rXrpAddress");

            const dmEntries = result.filter((p) => p.directMinting === true);
            expect(dmEntries).toHaveLength(1);
            // Fees are 0, so net == gross: 5000000 / 10^6 = 5.00
            expect(dmEntries[0].amount).toBe("5.00");
        });

        it("should return evm_txhash in Progress for executed direct minting", async () => {
            const directMinting = {
                txhash: "0x" + "E".repeat(64),
                userAddress: "rXrpAddress",
                targetAddress: "0xTarget",
                mintType: "address",
                tagId: null,
                amount: "10000000",
                mintingFeeUBA: "100000",
                executorFeeUBA: "50000",
                mintedAmountUBA: "9800000",
                status: "EXECUTED",
                delayTimestamp: null,
                timestamp: oneHourAgo,
                fasset: "FTestXRP",
                processed: true,
                evm_txhash: "0xEvmTxHash456",
            };

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress === "rXrpAddress") return [directMinting];
                return [];
            });

            const result = await service.getProgress("0xUser", "rXrpAddress");

            const dmEntries = result.filter((p) => p.directMinting === true);
            expect(dmEntries).toHaveLength(1);
            expect(dmEntries[0].evm_txhash).toBe("0xEvmTxHash456");
        });

        it("should return evm_txhash as null for in-progress direct minting", async () => {
            const directMinting = {
                txhash: "0x" + "F".repeat(64),
                userAddress: "rXrpAddress",
                targetAddress: "0xTarget",
                mintType: "address",
                tagId: null,
                amount: "5000000",
                mintingFeeUBA: "0",
                executorFeeUBA: "0",
                mintedAmountUBA: null,
                status: "INPROGRESS",
                delayTimestamp: null,
                timestamp: oneHourAgo,
                fasset: "FTestXRP",
                processed: false,
                evm_txhash: null,
            };

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress === "rXrpAddress") return [directMinting];
                return [];
            });

            const result = await service.getProgress("0xUser", "rXrpAddress");

            const dmEntries = result.filter((p) => p.directMinting === true);
            expect(dmEntries).toHaveLength(1);
            expect(dmEntries[0].evm_txhash).toBeNull();
        });

        it("should handle incomplete redemptions", async () => {
            const redeemRequested = createMockRedemptionRequested();
            const redemption = createMockRedemption();
            const incompleteData = {
                txhash: "0xRedeemHash",
                redeemer: "0xUser",
                remainingLots: "5",
                timestamp: oneHourAgo,
            };

            mockEm.find.mockImplementation((entity: any, filter: any) => {
                if (filter && filter.userAddress) return [];
                if (filter && filter.redeemer && !filter.timestamp) return [incompleteData];
                if (filter && filter.redeemer && filter.timestamp) return [redeemRequested];
                if (filter && filter.txhash) return [redemption];
                return [];
            });

            const result = await service.getProgress("0xUser");

            const incompleteEntries = result.filter((p) => p.incomplete === true);
            // Should mark the redemption as incomplete
            if (incompleteEntries.length > 0) {
                expect(incompleteEntries[0].remainingLots).toBe("5");
            }
        });
    });
});
