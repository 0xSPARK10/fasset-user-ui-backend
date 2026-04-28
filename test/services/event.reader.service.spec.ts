/**
 * Unit tests for EventReaderService.
 *
 * EventReaderService reads on-chain events from asset-manager contracts,
 * decodes them via the IIAssetManager ABI, and persists domain entities
 * (Liveness, Minting, Redemption, etc.) to the database.
 *
 * We mock ethers, the typechain factory, and all NestJS dependencies so that
 * no real network or database calls are made.
 */

/* ---- mock heavy transitive dependencies before any imports ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock("ethers", () => {
    class MockContractFactory {}
    const mockId = jest.fn().mockReturnValue("0xtopichash");
    return {
        ethers: {
            JsonRpcProvider: jest.fn(),
            Wallet: jest.fn(),
            id: mockId,
        },
        keccak256: jest.fn().mockReturnValue("0x0"),
        toUtf8Bytes: jest.fn().mockReturnValue(new Uint8Array(0)),
        FetchRequest: jest.fn().mockImplementation(() => ({ setHeader: jest.fn() })),
        Contract: jest.fn(),
        Interface: jest.fn().mockImplementation(() => ({
            parseLog: jest.fn().mockReturnValue(null),
        })),
        ContractFactory: MockContractFactory,
        LogDescription: jest.fn(),
    };
});

jest.mock("../../src/typechain-ethers-v6", () => ({
    IIAssetManager__factory: {
        createInterface: jest.fn().mockReturnValue({
            parseLog: jest.fn().mockReturnValue(null),
        }),
    },
}));

jest.mock("src/utils/utils", () => ({
    formatBigIntToDisplayDecimals: jest.fn().mockReturnValue("100.00"),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { MikroORM, EntityManager } from "@mikro-orm/core";
import { EventReaderService } from "../../src/services/event.reader.service";
import { EthersService } from "../../src/services/ethers.service";
import { ContractService } from "../../src/services/contract.service";
import { FassetConfigService } from "../../src/services/fasset.config.service";

/* ---- shared mock instances ---- */

/** Mocked EntityManager with all methods the service touches. */
const mockEm = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    persistAndFlush: jest.fn().mockResolvedValue(undefined),
    fork: jest.fn(),
};
mockEm.fork.mockReturnValue(mockEm);

const mockOrm = { em: mockEm };

/** Mocked JSON-RPC provider used by EthersService. */
const mockProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(1000),
    getLogs: jest.fn().mockResolvedValue([]),
    getBlock: jest.fn().mockResolvedValue({ timestamp: Math.floor(Date.now() / 1000) }),
};

const mockEthersService = {
    getProvider: jest.fn().mockReturnValue(mockProvider),
    getSigner: jest.fn().mockReturnValue({}),
    getExecutorAddress: jest.fn().mockReturnValue("0xExecutor"),
};

/** Mocked IIAssetManager contract instance. */
const mockAssetManager = {
    getSettings: jest.fn().mockResolvedValue({ assetDecimals: 6n }),
    getAddress: jest.fn().mockResolvedValue("0xAssetManagerAddr"),
    target: "0xAssetManagerAddr",
};

const mockContractService = {
    get: jest.fn().mockReturnValue(mockAssetManager),
    getContractNames: jest.fn().mockReturnValue(["AssetManager_FTestXRP"]),
};

const mockFassetConfigService = {
    getFAssetNames: jest.fn().mockReturnValue(["FTestXRP"]),
};

describe("EventReaderService", () => {
    let service: EventReaderService;

    beforeEach(async () => {
        // Reset all mocks to clean state before each test
        jest.clearAllMocks();
        mockProvider.getLogs.mockResolvedValue([]);

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EventReaderService,
                { provide: EthersService, useValue: mockEthersService },
                { provide: ContractService, useValue: mockContractService },
                { provide: FassetConfigService, useValue: mockFassetConfigService },
                { provide: MikroORM, useValue: mockOrm },
            ],
        }).compile();

        service = module.get<EventReaderService>(EventReaderService);

        /**
         * Manually initialise internal state that onApplicationBootstrap
         * would normally set up. This avoids triggering the infinite
         * event-reading loop during unit tests.
         */
        (service as any).em = mockEm;
        (service as any).executorAddress = "0xExecutor";
        (service as any).assetManagerAddresses = ["0xAssetManagerAddr"];
        (service as any).assetManagerMap = new Map([
            [
                "0xassetmanageraddr",
                { fasset: "FTestXRP", address: "0xAssetManagerAddr", decimals: 6 },
            ],
        ]);
    });

    /* ------------------------------------------------------------------
     * Basic sanity check
     * ------------------------------------------------------------------ */

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    /* ------------------------------------------------------------------
     * Constructor tests
     * ------------------------------------------------------------------ */

    describe("constructor", () => {
        it("should initialise eventTopics with 7 topic hashes", () => {
            /**
             * The constructor calls ethers.id() once per event signature.
             * There are 7 event signatures:
             *   AgentPingResponse, CollateralReserved, RedemptionRequested,
             *   RedemptionDefault, RedemptionRequestIncomplete,
             *   MintingPaymentDefault, RedemptionPaymentBlocked
             */
            expect(service.eventTopics).toHaveLength(7);
        });

        it("should populate every eventTopic entry from ethers.id()", () => {
            /**
             * Our ethers mock returns "0xtopichash" for every ethers.id() call,
             * so all entries should be that value.
             */
            for (const topic of service.eventTopics) {
                expect(topic).toBe("0xtopichash");
            }
        });

        it("should create an iface from IIAssetManager__factory.createInterface()", () => {
            const { IIAssetManager__factory } = require("../../src/typechain-ethers-v6");

            // The constructor must call createInterface exactly once
            expect(IIAssetManager__factory.createInterface).toHaveBeenCalledTimes(1);

            // The resulting interface should be stored on the service
            const iface = (service as any).iface;
            expect(iface).toBeDefined();
            expect(typeof iface.parseLog).toBe("function");
        });
    });

    /* ------------------------------------------------------------------
     * readEventsFrom – basic scenarios
     * ------------------------------------------------------------------ */

    describe("readEventsFrom", () => {
        it("should return an empty array when no logs are found", async () => {
            // Provider returns no logs for the queried block range
            mockProvider.getLogs.mockResolvedValue([]);

            const result = await service.readEventsFrom(100, 200);

            expect(result).toEqual([]);
            expect(mockProvider.getLogs).toHaveBeenCalledTimes(1);
        });

        it("should return parsed events when logs match the interface", async () => {
            // Simulate a single raw log coming back from the provider
            const mockLog = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xTxHash123",
                topics: ["0xtopichash", "0x" + "0".repeat(64)],
                data: "0x" + "0".repeat(64),
            };
            mockProvider.getLogs.mockResolvedValue([mockLog]);

            // Configure the interface to successfully decode this log
            const mockParsedEvent = {
                name: "AgentPingResponse",
                args: {
                    agentVault: "0xVault",
                    sender: "0xSender",
                    timestamp: 1000000n,
                    data: "ping",
                },
            };
            (service as any).iface.parseLog = jest.fn().mockReturnValue(mockParsedEvent);

            const result = await service.readEventsFrom(100, 200);

            // One log in, one decoded event out
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                address: "0xAssetManagerAddr",
                transactionHash: "0xTxHash123",
                parsed: mockParsedEvent,
            });
        });

        it("should skip logs that fail to parse (catches errors silently)", async () => {
            // Provide a log whose data causes parseLog to throw
            const mockLog = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xBadTx",
                topics: ["0xunknown"],
                data: "0xbaddata",
            };
            mockProvider.getLogs.mockResolvedValue([mockLog]);

            // parseLog throws for unrecognised data
            (service as any).iface.parseLog = jest.fn().mockImplementation(() => {
                throw new Error("could not decode log");
            });

            const result = await service.readEventsFrom(100, 200);

            // Error is silently caught; no events returned
            expect(result).toEqual([]);
        });

        it("should skip logs where parseLog returns null", async () => {
            // A log that the interface does not recognise (returns null)
            const mockLog = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xNullParseTx",
                topics: ["0xtopichash"],
                data: "0x",
            };
            mockProvider.getLogs.mockResolvedValue([mockLog]);

            (service as any).iface.parseLog = jest.fn().mockReturnValue(null);

            const result = await service.readEventsFrom(100, 200);

            // null parse result is filtered out
            expect(result).toEqual([]);
        });
    });

    /* ------------------------------------------------------------------
     * readEventsFrom – multiple logs
     * ------------------------------------------------------------------ */

    describe("readEventsFrom with multiple logs", () => {
        it("should correctly process multiple parseable logs from different addresses", async () => {
            /**
             * Two logs from the same asset manager address. Both should
             * be decoded and returned.
             */
            const log1 = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xTxA",
                topics: ["0xtopichash", "0x" + "0".repeat(64)],
                data: "0x" + "0".repeat(64),
            };
            const log2 = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xTxB",
                topics: ["0xtopichash", "0x" + "1".repeat(64)],
                data: "0x" + "1".repeat(64),
            };
            mockProvider.getLogs.mockResolvedValue([log1, log2]);

            const parsedA = {
                name: "AgentPingResponse",
                args: { agentVault: "0xVaultA", sender: "0xSenderA", timestamp: 100n, data: "a" },
            };
            const parsedB = {
                name: "CollateralReserved",
                args: { agentVault: "0xVaultB", minter: "0xMinterB" },
            };

            // Return different parsed events for each invocation
            (service as any).iface.parseLog = jest
                .fn()
                .mockReturnValueOnce(parsedA)
                .mockReturnValueOnce(parsedB);

            const result = await service.readEventsFrom(500, 600);

            expect(result).toHaveLength(2);
            expect(result[0].parsed.name).toBe("AgentPingResponse");
            expect(result[0].transactionHash).toBe("0xTxA");
            expect(result[1].parsed.name).toBe("CollateralReserved");
            expect(result[1].transactionHash).toBe("0xTxB");
        });

        it("should handle a mix of parseable and unparseable logs", async () => {
            /**
             * Three logs: first is parseable, second throws during
             * parseLog, third returns null. Only the first should
             * appear in the result.
             */
            const goodLog = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xGoodTx",
                topics: ["0xtopichash"],
                data: "0xgooddata",
            };
            const errorLog = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xErrorTx",
                topics: ["0xunknown"],
                data: "0xbad",
            };
            const nullLog = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xNullTx",
                topics: ["0xtopichash"],
                data: "0xnull",
            };
            mockProvider.getLogs.mockResolvedValue([goodLog, errorLog, nullLog]);

            const parsedGood = {
                name: "RedemptionRequested",
                args: { requestId: 42n },
            };

            (service as any).iface.parseLog = jest
                .fn()
                .mockReturnValueOnce(parsedGood) // first log: success
                .mockImplementationOnce(() => {   // second log: throws
                    throw new Error("decode failure");
                })
                .mockReturnValueOnce(null);       // third log: null

            const result = await service.readEventsFrom(700, 800);

            // Only the first (successfully parsed) log should be returned
            expect(result).toHaveLength(1);
            expect(result[0].parsed.name).toBe("RedemptionRequested");
            expect(result[0].transactionHash).toBe("0xGoodTx");
        });
    });

    /* ------------------------------------------------------------------
     * readEventsFrom – provider.getLogs call verification
     * ------------------------------------------------------------------ */

    describe("readEventsFrom calls provider.getLogs with correct params", () => {
        it("should pass assetManagerAddresses, fromBlock, toBlock, and topics filter", async () => {
            mockProvider.getLogs.mockResolvedValue([]);

            const fromBlock = 1234;
            const toBlock = 5678;

            await service.readEventsFrom(fromBlock, toBlock);

            /**
             * The service should pass exactly these parameters to getLogs:
             *   - address: the assetManagerAddresses array
             *   - fromBlock / toBlock: the block range to scan
             *   - topics: a nested array [[topic1, topic2, ...]]
             *     (ethers OR-filter for the first topic position)
             */
            expect(mockProvider.getLogs).toHaveBeenCalledWith({
                address: ["0xAssetManagerAddr"],
                fromBlock: 1234,
                toBlock: 5678,
                topics: [service.eventTopics],
            });
        });

        it("should pass updated addresses when assetManagerAddresses changes", async () => {
            /**
             * If a second asset manager is added to the list, the next
             * readEventsFrom call should include both addresses.
             */
            (service as any).assetManagerAddresses = [
                "0xAssetManagerAddr",
                "0xSecondManager",
            ];
            mockProvider.getLogs.mockResolvedValue([]);

            await service.readEventsFrom(100, 200);

            expect(mockProvider.getLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: ["0xAssetManagerAddr", "0xSecondManager"],
                })
            );
        });
    });

    /* ------------------------------------------------------------------
     * readEventsFrom – preserves raw log metadata
     * ------------------------------------------------------------------ */

    describe("readEventsFrom preserves raw log metadata", () => {
        it("should carry the original log address and transactionHash through to the result", async () => {
            /**
             * The decoded result should retain the original address and
             * transactionHash from the raw log, not from the parsed event.
             */
            const mockLog = {
                address: "0xSpecificAddress",
                transactionHash: "0xSpecificTxHash",
                topics: ["0xtopichash"],
                data: "0x1234",
            };
            mockProvider.getLogs.mockResolvedValue([mockLog]);

            const parsed = { name: "AgentPingResponse", args: {} };
            (service as any).iface.parseLog = jest.fn().mockReturnValue(parsed);

            const result = await service.readEventsFrom(0, 100);

            expect(result).toHaveLength(1);
            expect(result[0].address).toBe("0xSpecificAddress");
            expect(result[0].transactionHash).toBe("0xSpecificTxHash");
        });
    });

    /* ------------------------------------------------------------------
     * readEventsFrom – parseLog receives correct arguments
     * ------------------------------------------------------------------ */

    describe("readEventsFrom passes correct data to parseLog", () => {
        it("should call iface.parseLog with the topics and data from each log", async () => {
            const mockLog = {
                address: "0xAssetManagerAddr",
                transactionHash: "0xTxHash",
                topics: ["0xtopic0", "0xtopic1", "0xtopic2"],
                data: "0xsomedata",
            };
            mockProvider.getLogs.mockResolvedValue([mockLog]);

            const parseLogMock = jest.fn().mockReturnValue(null);
            (service as any).iface.parseLog = parseLogMock;

            await service.readEventsFrom(10, 20);

            /**
             * parseLog should receive an object with the same topics array
             * and data string as the original log.
             */
            expect(parseLogMock).toHaveBeenCalledWith({
                topics: ["0xtopic0", "0xtopic1", "0xtopic2"],
                data: "0xsomedata",
            });
        });
    });
});
