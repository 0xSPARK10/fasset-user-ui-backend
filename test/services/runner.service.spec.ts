/**
 * Unit tests for RunnerService.
 *
 * RunnerService is the heart of the background processing loop. It watches
 * for pending mintings and redemptions, checks their status against the
 * underlying chain, requests attestation proofs, and executes on-chain calls.
 *
 * The startProcessing cadence is covered with fake timers. The remaining tests
 * exercise the public helper methods that drive the business logic:
 *   - redemptionStatus
 *   - findRedemptionPayment
 *   - redemptionTimeElapsed
 */

/* ---- mock heavy transitive dependencies before any imports ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn().mockReturnValue({ get: jest.fn() }),
        isAxiosError: jest.fn((error: any) => error?.isAxiosError === true),
    },
}));

jest.mock("ethers", () => {
    class MockContractFactory {}
    return {
        ethers: { JsonRpcProvider: jest.fn(), Wallet: jest.fn() },
        keccak256: jest.fn().mockReturnValue("0x0"),
        toUtf8Bytes: jest.fn().mockReturnValue(new Uint8Array(0)),
        FetchRequest: jest.fn().mockImplementation(() => ({ setHeader: jest.fn() })),
        Contract: jest.fn(),
        Interface: jest.fn().mockImplementation(() => ({
            parseError: jest.fn().mockReturnValue(null),
            parseLog: jest.fn().mockReturnValue(null),
        })),
        ContractFactory: MockContractFactory,
    };
});

/* Mock the typechain factories so the constructor can build a combined ABI Interface */
jest.mock("../../src/typechain-ethers-v6", () => ({
    IIAssetManager__factory: {
        abi: [],
    },
}));

jest.mock("../../src/typechain-ethers-v6/factories/contracts/assetManager/facets/MintingFacet__factory", () => ({
    MintingFacet__factory: {
        abi: [],
    },
}));

jest.mock("../../src/typechain-ethers-v6/factories/contracts/assetManager/facets/RedemptionDefaultsFacet__factory", () => ({
    RedemptionDefaultsFacet__factory: {
        abi: [],
    },
}));

/* Mock utility functions used inside RunnerService */
const mockDateStringToTimestamp = jest.fn().mockReturnValue(1000000);
jest.mock("src/utils/utils", () => ({
    dateStringToTimestamp: (...args: any[]) => mockDateStringToTimestamp(...args),
    timestampToDateString: jest.fn().mockReturnValue("2024-01-01T00:00:00Z"),
    formatBigIntToDisplayDecimals: jest.fn().mockReturnValue("100.00"),
}));

/* -------------------------------------------------------------------------- */
/*                                  IMPORTS                                    */
/* -------------------------------------------------------------------------- */

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { MikroORM, EntityManager } from "@mikro-orm/core";
import axios from "axios";
import { RunnerService } from "../../src/services/runner.service";
import { SmartAccountsService } from "../../src/services/smart.accounts.service";
import { EthersService } from "../../src/services/ethers.service";
import { ContractService } from "../../src/services/contract.service";
import { DalService } from "../../src/services/dal.service";
import { FassetConfigService } from "../../src/services/fasset.config.service";
import { RedeemData } from "../../src/interfaces/structure";
import { RedemptionDefaultEvent as RedemptionDefaultEventEntity } from "../../src/entities/RedemptionDefaultEvent";
import { RedemptionBlocked } from "../../src/entities/RedemptionBlockedEvent";
import { DirectMinting, DirectMintingStatus } from "../../src/entities/DirectMinting";
import { DirectMintingRecoveryPayment } from "../../src/entities/DirectMintingRecoveryPayment";
import { DirectMintingExecutedEvent } from "../../src/entities/DirectMintingExecutedEvent";
import { DirectMintingExecutedToSmartAccountEvent } from "../../src/entities/DirectMintingExecutedToSmartAccountEvent";
import { DirectMintingDelayedEvent } from "../../src/entities/DirectMintingDelayedEvent";
import { logger } from "../../src/logger/winston.logger";

/* -------------------------------------------------------------------------- */
/*                             MOCK DEFINITIONS                                */
/* -------------------------------------------------------------------------- */

/**
 * A fake EntityManager that stubs all the ORM calls RunnerService makes.
 * fork() returns itself so chained forks keep pointing to the same mock.
 */
const mockEm = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    persistAndFlush: jest.fn().mockResolvedValue(undefined),
    removeAndFlush: jest.fn().mockResolvedValue(undefined),
    nativeDelete: jest.fn().mockResolvedValue(0),
    transactional: jest.fn(),
    fork: jest.fn(),
};
mockEm.fork.mockReturnValue(mockEm);

/** Minimal MikroORM mock; only em property is needed by the service */
const mockOrm = { em: mockEm };

const mockSmartAccountsClient = (axios.create as jest.Mock)() as { get: jest.Mock };

const mockConfig: Record<string, string> = {
    NETWORK: "coston2",
    APP_TYPE: "dev",
    SMART_ACCOUNTS_API_URL: "https://smart-accounts.example",
};
const mockConfigService = {
    get: jest.fn((key: string) => mockConfig[key]),
};

/**
 * Mock verifier that mimics VerifierService methods used by RunnerService.
 * Defaults to "empty" responses (no transactions found, low block numbers).
 */
const mockVerifier = {
    getTransactionsByReference: jest.fn().mockResolvedValue([]),
    getLastFinalizedBlockNumber: jest.fn().mockResolvedValue(100),
    getBlock: jest.fn().mockResolvedValue({ number: 100, timestamp: 1000000 }),
    getTransaction: jest.fn().mockResolvedValue(null),
    getPaymentEncodedRequest: jest.fn().mockResolvedValue("0xEncodedRequest"),
    getPaymentNonexistenceEncodedRequest: jest.fn().mockResolvedValue("0xEncodedRequest"),
};

/**
 * Mock AssetManager contract.
 * getSettings returns a struct with attestationWindowSeconds (86400 = 1 day).
 * executeMinting and redemptionPaymentDefault have estimateGas stubs.
 */
const mockAssetManager = {
    getSettings: jest.fn().mockResolvedValue({ attestationWindowSeconds: 86400n }),
    executeMinting: Object.assign(jest.fn(), { estimateGas: jest.fn().mockResolvedValue(100000n) }),
    redemptionPaymentDefault: Object.assign(jest.fn(), { estimateGas: jest.fn().mockResolvedValue(100000n) }),
    getAddress: jest.fn().mockResolvedValue("0xAssetManager"),
    target: "0xAssetManager",
};

/** Mock for EthersService: provider, signer, and executor address */
const mockEthersService = {
    getProvider: jest.fn().mockReturnValue({
        getBlock: jest.fn().mockResolvedValue({ timestamp: Math.floor(Date.now() / 1000) }),
    }),
    getSigner: jest.fn().mockReturnValue({}),
    getExecutorAddress: jest.fn().mockReturnValue("0xExecutor"),
};

/** Mock for ContractService: returns the mock AssetManager */
const mockContractService = {
    get: jest.fn().mockReturnValue(mockAssetManager),
    getContractNames: jest.fn().mockReturnValue(["AssetManager_FTestXRP"]),
};

/** Mock for DalService: attestation round / proof helpers */
const mockDalService = {
    roundFinalized: jest.fn().mockResolvedValue(true),
    latestFinalizedRound: jest.fn().mockResolvedValue(42),
    obtainProof: jest.fn().mockResolvedValue({ merkleProof: ["0xproof"], data: { response: "data" } }),
    submitRequestToFlareDataConnector: jest.fn().mockResolvedValue({ round: 42, data: "0xEncoded" }),
    attestationProved: jest.fn().mockReturnValue(true),
};

/** Mock for FassetConfigService: provides fasset names and verifier */
const mockFassetConfigService = {
    getFAssetNames: jest.fn().mockReturnValue(["FTestXRP"]),
    getVerifier: jest.fn().mockReturnValue(mockVerifier),
};

/* -------------------------------------------------------------------------- */
/*                               TEST SUITE                                    */
/* -------------------------------------------------------------------------- */

describe("RunnerService", () => {
    let service: RunnerService;

    /**
     * Build a fresh NestJS testing module before each test.
     * After getting the service instance we manually set the internal state
     * that would normally be populated by onApplicationBootstrap, so we can
     * test the helper methods in isolation.
     */
    beforeEach(async () => {
        /* Reset all mock call counts / return values between tests */
        jest.clearAllMocks();

        /* Re-apply default return values that clearAllMocks wiped */
        mockVerifier.getTransactionsByReference.mockResolvedValue([]);
        mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(100);
        mockVerifier.getBlock.mockResolvedValue({ number: 100, timestamp: 1000000 });
        mockDateStringToTimestamp.mockReturnValue(1000000);
        Object.assign(mockConfig, {
            NETWORK: "coston2",
            APP_TYPE: "dev",
            SMART_ACCOUNTS_API_URL: "https://smart-accounts.example",
        });
        mockEm.find.mockResolvedValue([]);
        mockEm.findOne.mockResolvedValue(null);
        mockEm.persistAndFlush.mockResolvedValue(undefined);
        mockEm.transactional.mockImplementation(async (callback: (em: typeof mockEm) => Promise<unknown>) => callback(mockEm));
        mockSmartAccountsClient.get.mockResolvedValue({
            data: { type: "BRIDGE", action: { action: "BRIDGE" }, status: "created" },
        });

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RunnerService,
                SmartAccountsService,
                { provide: MikroORM, useValue: mockOrm },
                { provide: EthersService, useValue: mockEthersService },
                { provide: ContractService, useValue: mockContractService },
                { provide: DalService, useValue: mockDalService },
                { provide: FassetConfigService, useValue: mockFassetConfigService },
                { provide: ConfigService, useValue: mockConfigService },
            ],
        }).compile();

        service = module.get<RunnerService>(RunnerService);

        /* Manually set the internal state that onApplicationBootstrap would populate */
        (service as any).em = mockEm;
        (service as any).executorAddress = "0xExecutor";
        (service as any).fassetNames = ["FTestXRP"];
        (service as any).assetManagerMap = new Map([["FTestXRP", mockAssetManager]]);
    });

    /* ------------------------------------------------------------------ */
    /*                         BASIC SANITY                                */
    /* ------------------------------------------------------------------ */

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("startProcessing", () => {
        const flushMicrotasks = async () => {
            for (let i = 0; i < 10; i++) {
                await Promise.resolve();
            }
        };

        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.clearAllTimers();
            jest.useRealTimers();
            jest.restoreAllMocks();
        });

        it("should wait five seconds before starting the next successful cycle", async () => {
            const neverResolve = () => new Promise<void>(() => undefined);
            const processMintings = jest
                .spyOn(service as any, "processMintings")
                .mockResolvedValueOnce(undefined)
                .mockImplementationOnce(neverResolve);
            jest.spyOn(service as any, "processRedemptions").mockResolvedValue(undefined);
            jest.spyOn(service as any, "processDirectMintings").mockResolvedValue(undefined);
            jest.spyOn(service as any, "processRedemptionsWithTag").mockResolvedValue(undefined);
            jest.spyOn(service as any, "withdrawWNAT").mockResolvedValue(undefined);

            void service.startProcessing();
            await flushMicrotasks();

            expect(processMintings).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(4999);
            expect(processMintings).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(1);
            await flushMicrotasks();
            expect(processMintings).toHaveBeenCalledTimes(2);
        });

        it("should wait five seconds before retrying after a cycle error", async () => {
            const error = new Error("cycle failed");
            const neverResolve = () => new Promise<void>(() => undefined);
            const processMintings = jest
                .spyOn(service as any, "processMintings")
                .mockRejectedValueOnce(error)
                .mockImplementationOnce(neverResolve);

            void service.startProcessing();
            await flushMicrotasks();

            expect(logger.error).toHaveBeenCalledWith("Starting runner.service run into error", error);
            expect(processMintings).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(4999);
            expect(processMintings).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(1);
            await flushMicrotasks();
            expect(processMintings).toHaveBeenCalledTimes(2);
        });

        it("should throttle cycles when no FAssets are configured", async () => {
            (service as any).fassetNames = [];
            const timeoutSpy = jest.spyOn(global, "setTimeout");

            void service.startProcessing();
            await flushMicrotasks();

            expect(timeoutSpy).toHaveBeenCalledTimes(1);
            expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 5000);
            await jest.advanceTimersByTimeAsync(4999);
            expect(timeoutSpy).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(1);
            await flushMicrotasks();
            expect(timeoutSpy).toHaveBeenCalledTimes(2);
            expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 5000);
        });
    });

    describe("processDirectMintings smart-status reconciliation", () => {
        const now = 1_700_000_000_000;
        const threeMinutes = 3 * 60_000;

        function makeCandidate(overrides: Partial<DirectMinting> = {}): DirectMinting {
            const candidate = new DirectMinting(
                `0x${"ab".repeat(32)}`,
                "rCandidate",
                null,
                "oft_candidate",
                null,
                "10000000",
                now - threeMinutes,
                "FTestXRP"
            );
            Object.assign(candidate, { destinationEid: 30101, destinationKind: "ETHEREUM" }, overrides);
            return candidate;
        }

        function axiosError(status?: number, code?: string): Error & { isAxiosError: boolean; response?: { status: number }; code?: string } {
            return Object.assign(new Error("smart status failed"), {
                isAxiosError: true,
                response: status === undefined ? undefined : { status },
                code,
            });
        }

        beforeEach(() => {
            jest.spyOn(Date, "now").mockReturnValue(now);
            mockEm.findOne.mockResolvedValue(null);
            jest.spyOn(service as any, "matchRecoveryPayments").mockResolvedValue(undefined);
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it("creates a dedicated ten-second smart-accounts client", () => {
            expect(axios.create).toHaveBeenCalledWith({
                baseURL: "https://smart-accounts.example",
                timeout: 10_000,
            });
        });

        it("uses scanner discovery time for the inclusive three-minute grace boundary", async () => {
            const tooEarly = makeCandidate({ timestamp: now - threeMinutes + 1 });
            mockEm.find.mockResolvedValueOnce([tooEarly]);

            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();

            const eligible = makeCandidate({ timestamp: now - threeMinutes });
            mockEm.find.mockResolvedValueOnce([eligible]);

            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it.each(["awaiting_recovery", "memo_skipped", "executed"])(
            "fills missing destination metadata before the grace period without applying remote status %s",
            async (status) => {
                const candidate = makeCandidate({ timestamp: now, destinationEid: null, destinationKind: null });
                mockEm.find.mockResolvedValue([candidate]);
                mockSmartAccountsClient.get.mockResolvedValueOnce({
                    data: { type: "BRIDGE", status, action: { destination_eid: 30110, destination_kind: "HYPER_EVM" } },
                });

                await (service as any).processDirectMintings("FTestXRP");
                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate).toMatchObject({
                    destinationEid: 30110,
                    destinationKind: "HYPER_EVM",
                    smartStatusLastCheckedAt: now,
                    status: DirectMintingStatus.INPROGRESS,
                    processed: false,
                });
                expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
                expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
            }
        );

        it.each([
            { destinationEid: null, destinationKind: "ETHEREUM" },
            { destinationEid: 30101, destinationKind: null },
        ])("retries missing destination metadata at sixty seconds before the recovery grace period (%p)", async (metadata) => {
            const candidate = makeCandidate({
                timestamp: now,
                ...metadata,
                smartStatusLastCheckedAt: now - 60_000 + 1,
            });
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({
                data: { type: "BRIDGE", status: "created", action: { destination_eid: 30101, destination_kind: "ETHEREUM" } },
            });

            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();

            (Date.now as jest.Mock).mockReturnValue(now + 1);
            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.destinationEid).toBe(30101);
            expect(candidate.destinationKind).toBe("ETHEREUM");
            expect(candidate.smartStatusLastCheckedAt).toBe(now + 1);
            expect(candidate.status).toBe(DirectMintingStatus.INPROGRESS);
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);

            (Date.now as jest.Mock).mockReturnValue(now + 60_001);
            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it.each([DirectMintingStatus.DELAYED, DirectMintingStatus.AWAITING_RECOVERY, DirectMintingStatus.RECOVERY_PENDING])(
            "fills a missing destination kind during an active delay without reconciling %s",
            async (status) => {
                const candidate = makeCandidate({ status, destinationKind: null });
                const executionAllowedAt = Math.floor(now / 1000) + 60;
                mockEm.find.mockResolvedValue([candidate]);
                mockEm.findOne.mockImplementation((entity: unknown) => Promise.resolve(entity === DirectMintingDelayedEvent ? { executionAllowedAt } : null));
                mockSmartAccountsClient.get.mockResolvedValueOnce({
                    data: { type: "BRIDGE", status: "memo_skipped", action: { destination_eid: 30101, destination_kind: "ETHEREUM" } },
                });

                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate).toMatchObject({
                    destinationEid: 30101,
                    destinationKind: "ETHEREUM",
                    status,
                    delayTimestamp: executionAllowedAt,
                    processed: false,
                });
                expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
                expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
            }
        );

        it("reuses one status response when destination enrichment and recovery reconciliation are both due", async () => {
            const candidate = makeCandidate({ destinationEid: null, destinationKind: null });
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({
                data: { type: "BRIDGE", status: "awaiting_recovery", action: { destination_eid: 30110, destination_kind: "HYPER_EVM" } },
            });

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.destinationEid).toBe(30110);
            expect(candidate.destinationKind).toBe("HYPER_EVM");
            expect(candidate.status).toBe(DirectMintingStatus.AWAITING_RECOVERY);
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it.each([
            { type: "BRIDGE", status: "created" },
            { type: "BRIDGE", status: "created", action: null },
            { type: "BRIDGE", status: "created", action: { destination_eid: null, destination_kind: null } },
            { type: "BRIDGE", status: "created", action: { destination_eid: 30110, destination_kind: "HYPER_EVM" } },
        ])("preserves saved destination metadata when a later status response omits or changes it (%p)", async (data) => {
            const candidate = makeCandidate();
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({ data });

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.destinationEid).toBe(30101);
            expect(candidate.destinationKind).toBe("ETHEREUM");
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it.each([false, true])("attempts destination enrichment before completion and stops polling afterwards (failure: %s)", async (lookupFails) => {
            const candidate = makeCandidate({ timestamp: now, destinationEid: null, destinationKind: null });
            const event = {
                mintedAmountUBA: "9000000",
                mintingFeeUBA: "500000",
                txhash: `0x${"ef".repeat(32)}`,
                blockNumber: 12_345,
            };
            mockEm.find.mockImplementation((_entity: unknown, where: { processed: boolean }) =>
                Promise.resolve(candidate.processed === where.processed ? [candidate] : [])
            );
            mockEm.findOne.mockImplementation((entity: unknown) => Promise.resolve(entity === DirectMintingExecutedToSmartAccountEvent ? event : null));
            if (lookupFails) {
                mockSmartAccountsClient.get.mockRejectedValueOnce(axiosError(500));
            } else {
                mockSmartAccountsClient.get.mockResolvedValueOnce({
                    data: { type: "BRIDGE", status: "created", action: { destination_eid: 30110, destination_kind: "HYPER_EVM" } },
                });
            }

            await (service as any).processDirectMintings("FTestXRP");
            (Date.now as jest.Mock).mockReturnValue(now + 60_000);
            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate).toMatchObject({
                destinationEid: lookupFails ? null : 30110,
                destinationKind: lookupFails ? null : "HYPER_EVM",
                status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT,
                processed: true,
                evm_txhash: event.txhash,
            });
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it("enforces the inclusive persisted sixty-second throttle boundary", async () => {
            const throttled = makeCandidate({ smartStatusLastCheckedAt: now - 60_000 + 1 });
            mockEm.find.mockResolvedValueOnce([throttled]);

            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();

            const eligible = makeCandidate({ smartStatusLastCheckedAt: now - 60_000 });
            mockEm.find.mockResolvedValueOnce([eligible]);

            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it("persists the attempt before requesting the canonical XRP hash", async () => {
            const candidate = makeCandidate();
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockImplementationOnce(async (url: string) => {
                expect(candidate.smartStatusLastCheckedAt).toBe(now);
                expect(mockEm.persistAndFlush).toHaveBeenCalledWith(candidate);
                expect(url).toBe(`/api/v3/direct_mint/shortStatus/0x${"AB".repeat(32)}`);
                return { data: { type: "BRIDGE", status: "created", action: null } };
            });

            await (service as any).processDirectMintings("FTestXRP");

            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it("does not reconcile legacy direct mintings or unsupported OFT sources", async () => {
            const legacy = makeCandidate({ mintType: "address" });
            mockEm.find.mockResolvedValueOnce([legacy]);
            await (service as any).processDirectMintings("FTestXRP");

            const unsupportedFasset = makeCandidate({ fasset: "FXRP" });
            mockEm.find.mockResolvedValueOnce([unsupportedFasset]);
            await (service as any).processDirectMintings("FXRP");

            mockConfig.NETWORK = "songbird";
            const unsupportedNetwork = makeCandidate();
            mockEm.find.mockResolvedValueOnce([unsupportedNetwork]);
            await (service as any).processDirectMintings("FTestXRP");

            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
        });

        it("persists an active delay and makes no smart-status request", async () => {
            const candidate = makeCandidate();
            const executionAllowedAt = Math.floor(now / 1000) + 60;
            mockEm.find.mockResolvedValue([candidate]);
            mockEm.findOne.mockImplementation((entity: any) =>
                Promise.resolve(entity === DirectMintingDelayedEvent ? { executionAllowedAt } : null)
            );

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.DELAYED);
            expect(candidate.delayTimestamp).toBe(executionAllowedAt);
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
        });

        it.each([DirectMintingStatus.AWAITING_RECOVERY, DirectMintingStatus.RECOVERY_PENDING])("keeps %s during an active delay", async (status) => {
            const candidate = makeCandidate({ status });
            const executionAllowedAt = Math.floor(now / 1000) + 60;
            mockEm.find.mockResolvedValue([candidate]);
            mockEm.findOne.mockImplementation((entity: any) =>
                Promise.resolve(entity === DirectMintingDelayedEvent ? { executionAllowedAt } : null)
            );

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(status);
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
        });

        it("reconciles DELAYED only at three minutes after delayTimestamp", async () => {
            const tooEarly = makeCandidate({
                status: DirectMintingStatus.DELAYED,
                delayTimestamp: (now - threeMinutes + 1) / 1000,
            });
            mockEm.find.mockResolvedValueOnce([tooEarly]);
            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();

            const eligible = makeCandidate({
                status: DirectMintingStatus.DELAYED,
                delayTimestamp: (now - threeMinutes) / 1000,
            });
            mockEm.find.mockResolvedValueOnce([eligible]);
            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it.each([DirectMintingStatus.AWAITING_RECOVERY, DirectMintingStatus.RECOVERY_PENDING])("polls %s after delay expiry", async (status) => {
            const candidate = makeCandidate({
                status,
                timestamp: now,
                delayTimestamp: now / 1000 - 1,
            });
            mockEm.find.mockResolvedValue([candidate]);

            await (service as any).processDirectMintings("FTestXRP");

            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it.each([
            { type: "BRIDGE", action: { action: "BRIDGE" } },
            { type: "BRIDGE", action: { action: "CUSTOM" } },
            { type: "BRIDGE" },
            { type: "CUSTOM", action: { action: "CUSTOM" } },
            { type: "CUSTOM" },
            {},
        ])("sets recovery regardless of type/action (%p) and ignores payload execution hints", async (data) => {
            const candidate = makeCandidate();
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({
                data: {
                    ...data,
                    status: "awaiting_recovery",
                    tx_hash: `0x${"cd".repeat(32)}`,
                    payload: { type: "RecoveryMemo", memo: "must-not-be-copied" },
                },
            });

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.AWAITING_RECOVERY);
            expect(candidate.processed).toBe(false);
            expect(candidate.evm_txhash).toBeNull();
            expect(mockEm.persistAndFlush).toHaveBeenLastCalledWith(candidate);
            expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
        });

        it.each(["BRIDGE", "CUSTOM", "VAULT_DEPOSIT", "MINT_AND_SUPPLY"])("uses the short-status source recovery state for %s with no action", async (type) => {
            const candidate = makeCandidate({ destinationEid: null, destinationKind: null });
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({ data: { type, status: "awaiting_recovery", action: null } });

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate).toMatchObject({
                status: DirectMintingStatus.AWAITING_RECOVERY,
                processed: false,
                destinationEid: null,
                destinationKind: null,
                evm_txhash: null,
            });
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
            expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
        });

        it.each([
            [DirectMintingStatus.INPROGRESS, "BRIDGE"],
            [DirectMintingStatus.INPROGRESS, "MINTING"],
            [DirectMintingStatus.INPROGRESS, "CUSTOM"],
            [DirectMintingStatus.AWAITING_RECOVERY, "BRIDGE"],
            [DirectMintingStatus.RECOVERY_PENDING, "BRIDGE"],
        ])("completes memo-skipped recovery from %s before filtering type %s and stops polling", async (status, type) => {
            const candidate = makeCandidate({ status });
            mockEm.find.mockImplementation((_entity: unknown, where: { processed: boolean }) =>
                Promise.resolve(candidate.processed === where.processed ? [candidate] : [])
            );
            mockSmartAccountsClient.get.mockResolvedValueOnce({
                data: { type, status: "memo_skipped", action: null },
            });

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.RECOVERED);
            expect(candidate.processed).toBe(true);
            expect(candidate.evm_txhash).toBeNull();
            expect(mockEm.persistAndFlush).toHaveBeenLastCalledWith(candidate);
            expect(mockEm.removeAndFlush).not.toHaveBeenCalled();

            (Date.now as jest.Mock).mockReturnValue(now + 60_000);
            await (service as any).processDirectMintings("FTestXRP");

            expect(mockEm.find).toHaveBeenLastCalledWith(DirectMinting, { processed: false, fasset: "FTestXRP" }, { orderBy: { id: "ASC" } });
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        });

        it.each([
            ["malformed", null],
            ["missing type", { status: "created" }],
            ["invalid type", { type: 123, status: "created" }],
            ["empty type", { type: "", status: "created" }],
            ["whitespace type", { type: " ", status: "created" }],
            ["missing status", { type: "CUSTOM" }],
            ["invalid status", { type: "CUSTOM", status: 123 }],
            ["empty status", { type: "CUSTOM", status: "" }],
            ["whitespace status", { type: "CUSTOM", status: " " }],
            ["bridge without action", { type: "BRIDGE", status: "created" }],
            ["bridge without destination", { type: "BRIDGE", status: "created", action: null }],
            ["unconfirmed short execution", { type: "BRIDGE", status: "executed", action: null }],
            ["other bridge status", { type: "BRIDGE", action: { action: "CUSTOM" }, status: "executed" }],
        ])("preserves local state for a %s 200 response", async (_name, data) => {
            const candidate = makeCandidate();
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({ data });

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.INPROGRESS);
            expect(candidate.processed).toBe(false);
            expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
        });

        it.each([
            { type: "CUSTOM", status: "created", action: null },
            { type: "MINT_AND_SUPPLY", status: "created", action: null },
            { type: "CUSTOM", action: { action: "BRIDGE" }, status: "executed" },
        ])("deletes only the non-bridge candidate without recovery (%p)", async (data) => {
            const candidate = makeCandidate();
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({ data });

            await (service as any).processDirectMintings("FTestXRP");

            expect(mockEm.removeAndFlush).toHaveBeenCalledTimes(1);
            expect(mockEm.removeAndFlush).toHaveBeenCalledWith(candidate);
            expect(mockEm.nativeDelete).not.toHaveBeenCalled();
        });

        it.each([DirectMintingStatus.AWAITING_RECOVERY, DirectMintingStatus.RECOVERY_PENDING])("keeps %s after non-bridge status", async (status) => {
            const candidate = makeCandidate({ status });
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({ data: { type: "CUSTOM", status: "created" } });

            await (service as any).processDirectMintings("FTestXRP");

            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
            expect(candidate.status).toBe(status);
            expect(candidate.processed).toBe(false);
            expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
        });

        it.each([
            null,
            { type: "BRIDGE", status: "awaiting_recovery" },
            { type: "BRIDGE", status: "created" },
            { type: "BRIDGE", status: "delayed" },
            { type: "BRIDGE", status: "executed" },
            { type: "BRIDGE", status: "unknown" },
            { status: "executed" },
        ])("keeps a newly pending recovery unprocessed without local execution evidence (%p)", async (data) => {
            const candidate = makeCandidate({ status: DirectMintingStatus.RECOVERY_PENDING, timestamp: now });
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockResolvedValueOnce({ data });

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.RECOVERY_PENDING);
            expect(candidate.processed).toBe(false);
            expect(mockSmartAccountsClient.get).toHaveBeenCalledWith(`/api/v3/direct_mint/shortStatus/0x${"AB".repeat(32)}`);
            expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
        });

        it.each([
            ["400", axiosError(400)],
            ["404", axiosError(404)],
            ["429", axiosError(429)],
            ["500", axiosError(500)],
            ["timeout", axiosError(undefined, "ECONNABORTED")],
        ])("preserves local state and the persisted throttle after %s", async (_name, error) => {
            const candidate = makeCandidate({ destinationEid: null });
            mockEm.find.mockResolvedValue([candidate]);
            mockSmartAccountsClient.get.mockRejectedValueOnce(error);

            await (service as any).processDirectMintings("FTestXRP");
            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.INPROGRESS);
            expect(candidate.smartStatusLastCheckedAt).toBe(now);
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
            expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
        });

        it("alerts and throttles an invalid stored XRP hash without making a request", async () => {
            const candidate = makeCandidate({ txhash: "not-a-hash" });
            mockEm.find.mockResolvedValue([candidate]);

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.smartStatusLastCheckedAt).toBe(now);
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("invalid stored XRP hash"));
        });

        it("continues with later candidates after one smart-status failure", async () => {
            const first = makeCandidate({ txhash: `0x${"11".repeat(32)}` });
            const second = makeCandidate({ txhash: `0x${"22".repeat(32)}` });
            mockEm.find.mockResolvedValue([first, second]);
            mockSmartAccountsClient.get
                .mockRejectedValueOnce(axiosError(404))
                .mockResolvedValueOnce({ data: { type: "BRIDGE", action: { action: "BRIDGE" }, status: "awaiting_recovery" } });

            await (service as any).processDirectMintings("FTestXRP");

            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(2);
            expect(first.status).toBe(DirectMintingStatus.INPROGRESS);
            expect(second.status).toBe(DirectMintingStatus.AWAITING_RECOVERY);
        });

        it.each([false, true])("continues with later candidates after deletion (failure: %s)", async (deletionFails) => {
            const first = makeCandidate({ txhash: `0x${"11".repeat(32)}` });
            const second = makeCandidate({ txhash: `0x${"22".repeat(32)}` });
            mockEm.find.mockResolvedValue([first, second]);
            mockSmartAccountsClient.get
                .mockResolvedValueOnce({ data: { type: "CUSTOM", status: "created" } })
                .mockResolvedValueOnce({ data: { type: "BRIDGE", status: "awaiting_recovery" } });
            if (deletionFails) mockEm.removeAndFlush.mockRejectedValueOnce(new Error("Deletion failed"));

            await (service as any).processDirectMintings("FTestXRP");

            expect(mockEm.removeAndFlush).toHaveBeenCalledTimes(1);
            expect(mockEm.removeAndFlush).toHaveBeenCalledWith(first);
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(2);
            expect(second.status).toBe(DirectMintingStatus.AWAITING_RECOVERY);
        });

        it("keeps event-first completion for candidates that are not awaiting recovery", async () => {
            const candidate = makeCandidate();
            const event = {
                mintedAmountUBA: "9000000",
                mintingFeeUBA: "500000",
                txhash: `0x${"ef".repeat(32)}`,
                blockNumber: 12_345,
            };
            mockEm.find.mockResolvedValue([candidate]);
            mockEm.findOne.mockImplementation((entity: any) =>
                Promise.resolve(entity === DirectMintingExecutedToSmartAccountEvent ? event : null)
            );

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT);
            expect(candidate.evm_txhash).toBe(event.txhash);
            expect(candidate.processed).toBe(true);
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
        });

        describe.each([
            [DirectMintingStatus.AWAITING_RECOVERY, "ordinary", DirectMintingExecutedEvent, DirectMintingStatus.EXECUTED],
            [DirectMintingStatus.AWAITING_RECOVERY, "smart-account", DirectMintingExecutedToSmartAccountEvent, DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT],
            [DirectMintingStatus.RECOVERY_PENDING, "ordinary", DirectMintingExecutedEvent, DirectMintingStatus.EXECUTED],
            [DirectMintingStatus.RECOVERY_PENDING, "smart-account", DirectMintingExecutedToSmartAccountEvent, DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT],
        ] as const)("%s with an indexed %s execution", (recoveryStatus, _name, eventModel, executedStatus) => {
            let candidate: DirectMinting;
            const event = {
                mintedAmountUBA: "9000000",
                mintingFeeUBA: "500000",
                executorFeeUBA: "500000",
                txhash: `0x${"ef".repeat(32)}`,
                blockNumber: 12_345,
            };

            beforeEach(() => {
                candidate = makeCandidate({ status: recoveryStatus });
                mockEm.find.mockResolvedValue([candidate]);
                mockEm.findOne.mockImplementation((entity: unknown) => Promise.resolve(entity === eventModel ? event : null));
            });

            it("keeps the recovered status and local execution metadata when the event arrives first", async () => {
                mockSmartAccountsClient.get.mockResolvedValueOnce({ data: { type: "BRIDGE", status: "memo_skipped" } });

                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate).toMatchObject({
                    status: DirectMintingStatus.RECOVERED,
                    processed: true,
                    evm_txhash: event.txhash,
                    mintedAmountUBA: event.mintedAmountUBA,
                    mintingFeeUBA: event.mintingFeeUBA,
                });
                expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
                expect(mockEm.persistAndFlush).toHaveBeenLastCalledWith(candidate);
                expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
            });

            it.each([
                ["awaiting recovery", { type: "BRIDGE", status: "awaiting_recovery" }],
                ["replay pending", { type: "BRIDGE", status: "awaiting_recovery", payload: { type: "RecoveryReplayPending" } }],
                ["unrecognized status", { type: "BRIDGE", status: "unknown" }],
                ["malformed response", null],
                ["incomplete execution response", { status: "executed" }],
            ])("keeps the record pending for %s", async (_description, data) => {
                mockSmartAccountsClient.get.mockResolvedValueOnce({ data });

                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate.status).toBe(recoveryStatus);
                expect(candidate.processed).toBe(false);
                expect(candidate.evm_txhash).toBe(event.txhash);
                expect(candidate.smartStatusLastCheckedAt).toBe(now);
                expect(mockEm.removeAndFlush).not.toHaveBeenCalled();
            });

            it("keeps the record pending after a smart-backend failure", async () => {
                candidate.destinationEid = null;
                const persistedStates: Partial<DirectMinting>[] = [];
                mockEm.persistAndFlush.mockImplementation(async (dm: DirectMinting) => {
                    persistedStates.push({ ...dm });
                });
                mockSmartAccountsClient.get.mockRejectedValueOnce(axiosError(500));

                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate.status).toBe(recoveryStatus);
                expect(candidate.processed).toBe(false);
                expect(candidate.smartStatusLastCheckedAt).toBe(now);
                expect(persistedStates).toContainEqual(
                    expect.objectContaining({ evm_txhash: event.txhash, mintedAmountUBA: event.mintedAmountUBA, processed: false })
                );
                expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
            });

            it("waits for the persisted throttle before checking completion", async () => {
                candidate.smartStatusLastCheckedAt = now - 60_000 + 1;
                mockSmartAccountsClient.get.mockResolvedValueOnce({ data: { type: "BRIDGE", status: "memo_skipped" } });

                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate.status).toBe(recoveryStatus);
                expect(candidate.processed).toBe(false);
                expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();

                (Date.now as jest.Mock).mockReturnValue(now + 1);
                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate.status).toBe(DirectMintingStatus.RECOVERED);
                expect(candidate.processed).toBe(true);
                expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
            });

            it.each([
                [{ destination_eid: 30110, destination_kind: "HYPER_EVM" }, 30110, "HYPER_EVM"],
                [null, null, null],
            ])("allows normal completion after a valid short executed response (%p)", async (action, destinationEid, destinationKind) => {
                candidate.destinationEid = null;
                candidate.destinationKind = null;
                mockSmartAccountsClient.get.mockResolvedValueOnce({
                    data: { type: "BRIDGE", status: "executed", action },
                });

                await (service as any).processDirectMintings("FTestXRP");

                expect(candidate.status).toBe(executedStatus);
                expect(candidate.processed).toBe(true);
                expect(candidate.evm_txhash).toBe(event.txhash);
                expect(candidate.destinationEid).toBe(destinationEid);
                expect(candidate.destinationKind).toBe(destinationKind);
                expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
            });
        });

        it("alerts but still resolves an OFT candidate with missing execution metadata", async () => {
            const candidate = makeCandidate({ id: 42 });
            const event = {
                mintedAmountUBA: "9000000",
                mintingFeeUBA: "500000",
                txhash: null,
                blockNumber: null,
            };
            mockEm.find.mockResolvedValue([candidate]);
            mockEm.findOne.mockImplementation((entity: any) =>
                Promise.resolve(entity === DirectMintingExecutedToSmartAccountEvent ? event : null)
            );

            await (service as any).processDirectMintings("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT);
            expect(candidate.processed).toBe(true);
            expect(logger.error).toHaveBeenCalledWith(
                JSON.stringify({
                    code: "OFT_HISTORY_MISSING_EXECUTION_METADATA",
                    candidateId: 42,
                    xrplTxHash: candidate.txhash,
                    fasset: "FTestXRP",
                    eventType: "DirectMintingExecutedToSmartAccount",
                    evmTxHash: null,
                    executionBlockNumber: null,
                })
            );
        });
    });

    describe("recovery payment matching", () => {
        const now = 1_700_000_000_000;
        let candidate: DirectMinting;
        let payment: DirectMintingRecoveryPayment;
        let transactionEm: { find: jest.Mock; findOne: jest.Mock };

        beforeEach(() => {
            jest.spyOn(Date, "now").mockReturnValue(now);
            candidate = new DirectMinting(
                `0x${"ab".repeat(32)}`,
                "rCandidate",
                null,
                "oft_candidate",
                null,
                "10000000",
                now - 3 * 60_000,
                "FTestXRP"
            );
            candidate.status = DirectMintingStatus.AWAITING_RECOVERY;
            candidate.destinationEid = 30101;
            candidate.destinationKind = "ETHEREUM";
            payment = new DirectMintingRecoveryPayment(`0x${"cd".repeat(32)}`, candidate.txhash, candidate.userAddress, candidate.fasset, now);
            transactionEm = {
                find: jest.fn().mockImplementation(() => Promise.resolve(payment.processed ? [] : [payment])),
                findOne: jest.fn().mockResolvedValue(candidate),
            };
            mockEm.transactional.mockImplementation(async (callback: (em: typeof transactionEm) => Promise<unknown>) => callback(transactionEm));
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it("matches the original hash and asset, and atomically marks only the matching sender's action pending", async () => {
            const original = { ...candidate };

            await (service as any).matchRecoveryPayments("FTestXRP");

            expect(mockEm.transactional).toHaveBeenCalledWith(expect.any(Function), { clear: true });
            expect(transactionEm.find).toHaveBeenCalledWith(DirectMintingRecoveryPayment, { fasset: "FTestXRP", processed: false }, { orderBy: { id: "ASC" } });
            expect(transactionEm.findOne).toHaveBeenCalledWith(DirectMinting, {
                txhash: payment.originalTxHash,
                fasset: "FTestXRP",
                mintType: "oft_candidate",
            });
            expect(candidate).toEqual({ ...original, status: DirectMintingStatus.RECOVERY_PENDING });
            expect(payment.processed).toBe(true);
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
        });

        it.each([DirectMintingStatus.INPROGRESS, DirectMintingStatus.DELAYED])("retries early payments for %s after restart", async (status) => {
            candidate.status = status;
            transactionEm.findOne.mockResolvedValueOnce(null);

            await (service as any).matchRecoveryPayments("FTestXRP");
            expect(payment.processed).toBe(false);
            await (service as any).matchRecoveryPayments("FTestXRP");
            expect(payment.processed).toBe(false);
            expect(candidate.status).toBe(status);

            candidate.status = DirectMintingStatus.AWAITING_RECOVERY;
            const restarted = new RunnerService(
                mockOrm as any,
                mockEthersService as any,
                mockContractService as any,
                mockDalService as any,
                mockFassetConfigService as any,
                mockConfigService as any,
                new SmartAccountsService(mockConfigService as any)
            );
            (restarted as any).em = mockEm;

            await (restarted as any).matchRecoveryPayments("FTestXRP");

            expect(transactionEm.find).toHaveBeenCalledTimes(3);
            expect(candidate.status).toBe(DirectMintingStatus.RECOVERY_PENDING);
            expect(payment.processed).toBe(true);
        });

        it("closes a sender mismatch without changing the original action", async () => {
            payment.userAddress = "rOtherUser";

            await (service as any).matchRecoveryPayments("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.AWAITING_RECOVERY);
            expect(candidate.processed).toBe(false);
            expect(payment.processed).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("XRP sender does not match"));
        });

        it.each([
            [DirectMintingStatus.RECOVERY_PENDING, false],
            [DirectMintingStatus.RECOVERED, true],
            [DirectMintingStatus.EXECUTED, true],
            [DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT, true],
            [DirectMintingStatus.MINTING_PAYMENT_TOO_SMALL_FOR_FEE, true],
        ] as const)("closes an attempt targeting %s without changing that action", async (status, processed) => {
            candidate.status = status;
            candidate.processed = processed;

            await (service as any).matchRecoveryPayments("FTestXRP");

            expect(candidate.status).toBe(status);
            expect(candidate.processed).toBe(processed);
            expect(payment.processed).toBe(true);
        });

        it("closes multiple recovery payments targeting the same awaiting action in one batch", async () => {
            const duplicate = new DirectMintingRecoveryPayment(`0x${"ef".repeat(32)}`, candidate.txhash, candidate.userAddress, candidate.fasset, now);
            transactionEm.find.mockResolvedValueOnce([payment, duplicate]);

            await (service as any).matchRecoveryPayments("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.RECOVERY_PENDING);
            expect(candidate.processed).toBe(false);
            expect(payment.processed).toBe(true);
            expect(duplicate.processed).toBe(true);
        });

        it("does not process original actions after a matching transaction fails and retries on the next pass", async () => {
            mockEm.transactional.mockRejectedValueOnce(new Error("transaction failed"));

            await expect((service as any).processDirectMintings("FTestXRP")).rejects.toThrow("transaction failed");

            expect(payment.processed).toBe(false);
            expect(mockEm.find).not.toHaveBeenCalled();
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();

            await (service as any).matchRecoveryPayments("FTestXRP");

            expect(candidate.status).toBe(DirectMintingStatus.RECOVERY_PENDING);
            expect(payment.processed).toBe(true);
        });

        it("matches an early payment on a later pass and polls only the original hash until recovery completes", async () => {
            candidate.status = DirectMintingStatus.INPROGRESS;
            mockEm.find.mockImplementation(() => Promise.resolve(candidate.processed ? [] : [candidate]));
            mockSmartAccountsClient.get.mockResolvedValue({ data: { type: "BRIDGE", status: "awaiting_recovery" } });

            await (service as any).processDirectMintings("FTestXRP");
            expect(candidate.status).toBe(DirectMintingStatus.AWAITING_RECOVERY);
            expect(payment.processed).toBe(false);

            (Date.now as jest.Mock).mockReturnValue(now + 5000);
            await (service as any).processDirectMintings("FTestXRP");
            expect(candidate.status).toBe(DirectMintingStatus.RECOVERY_PENDING);
            expect(payment.processed).toBe(true);
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);

            (Date.now as jest.Mock).mockReturnValue(now + 60_000);
            await (service as any).processDirectMintings("FTestXRP");
            expect(candidate.status).toBe(DirectMintingStatus.RECOVERY_PENDING);
            expect(candidate.processed).toBe(false);

            (Date.now as jest.Mock).mockReturnValue(now + 120_000);
            mockSmartAccountsClient.get.mockResolvedValueOnce({ data: { type: "BRIDGE", status: "memo_skipped" } });
            await (service as any).processDirectMintings("FTestXRP");
            expect(candidate.status).toBe(DirectMintingStatus.RECOVERED);
            expect(candidate.processed).toBe(true);

            (Date.now as jest.Mock).mockReturnValue(now + 180_000);
            await (service as any).processDirectMintings("FTestXRP");
            expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(3);
            expect(mockSmartAccountsClient.get.mock.calls).toEqual([
                [`/api/v3/direct_mint/shortStatus/0x${"AB".repeat(32)}`],
                [`/api/v3/direct_mint/shortStatus/0x${"AB".repeat(32)}`],
                [`/api/v3/direct_mint/shortStatus/0x${"AB".repeat(32)}`],
            ]);
            expect(candidate.txhash).toBe(payment.originalTxHash);
            expect(candidate.amount).toBe("10000000");
        });

        it.each([
            ["songbird", "FTestXRP"],
            ["coston2", "FXRP"],
        ])("does not match recovery payments for unsupported source %s/%s", async (network, fasset) => {
            mockConfig.NETWORK = network;

            await (service as any).matchRecoveryPayments(fasset);

            expect(mockEm.transactional).not.toHaveBeenCalled();
            expect(candidate.status).toBe(DirectMintingStatus.AWAITING_RECOVERY);
        });
    });

    /* ------------------------------------------------------------------ */
    /*                       redemptionStatus                              */
    /* ------------------------------------------------------------------ */

    describe("redemptionStatus", () => {
        /**
         * Shared RedeemData object used across all redemptionStatus tests.
         * Individual tests override mock return values to trigger each branch.
         */
        const redeemState: RedeemData = {
            type: "redeem",
            requestId: "req-1",
            amountUBA: "1000000",
            paymentReference: "0xPayRef",
            firstUnderlyingBlock: "100",
            lastUnderlyingBlock: "200",
            lastUnderlyingTimestamp: "1000000",
            executorAddress: "0xExecutor",
            createdAt: "2024-01-01T00:00:00Z",
            underlyingAddress: "rAddress",
        };

        /** The settings struct returned by assetManager.getSettings() */
        const settings = { attestationWindowSeconds: 86400n };

        it("should return EXPIRED when timestamp - createdAt >= attestationWindowSeconds", async () => {
            /**
             * dateStringToTimestamp(state.createdAt) returns 1000000.
             * We pass timestamp = 1000000 + 86400 so the difference equals
             * attestationWindowSeconds exactly, triggering the EXPIRED branch.
             */
            mockDateStringToTimestamp.mockReturnValue(1000000);
            const timestamp = 1000000 + 86400; // exactly at the window boundary

            const result = await service.redemptionStatus("FTestXRP", redeemState, timestamp, settings);

            expect(result).toBe("EXPIRED");
        });

        it("should return SUCCESS when findRedemptionPayment finds a matching payment", async () => {
            /**
             * Set timestamp well below the EXPIRED threshold so we skip that branch.
             * Then configure the verifier to return a transaction whose output to
             * the underlying address meets the amountUBA requirement.
             */
            mockDateStringToTimestamp.mockReturnValue(1000000);
            const timestamp = 1000000 + 100; // well within the attestation window

            const matchingTx = {
                hash: "0xTxHash",
                inputs: [["rSender", 2000000n]] as [string, bigint][],
                outputs: [["rAddress", 1000000n]] as [string, bigint][],
                reference: "0xPayRef",
                status: 1,
            };
            mockVerifier.getTransactionsByReference.mockResolvedValue([matchingTx]);

            const result = await service.redemptionStatus("FTestXRP", redeemState, timestamp, settings);

            expect(result).toBe("SUCCESS");
        });

        it("should return DEFAULT when redemptionTimeElapsed returns true", async () => {
            /**
             * We need to:
             * 1. NOT expire (timestamp - createdAt < attestationWindowSeconds)
             * 2. NOT find a payment (empty transactions)
             * 3. Have the underlying chain time elapsed (block height > lastUnderlyingBlock
             *    AND block timestamp > lastUnderlyingTimestamp)
             */
            mockDateStringToTimestamp.mockReturnValue(1000000);
            const timestamp = 1000000 + 100; // within attestation window

            /* No matching transactions -> findRedemptionPayment returns undefined */
            mockVerifier.getTransactionsByReference.mockResolvedValue([]);

            /* Verifier reports a finalized block well past the redemption deadline */
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(999);
            mockVerifier.getBlock.mockResolvedValue({ number: 999, timestamp: 2000000 });

            const result = await service.redemptionStatus("FTestXRP", redeemState, timestamp, settings);

            expect(result).toBe("DEFAULT");
        });

        it("should return PENDING when none of the above conditions are met", async () => {
            /**
             * We need to:
             * 1. NOT expire
             * 2. NOT find a payment
             * 3. NOT have time elapsed (block height <= lastUnderlyingBlock)
             */
            mockDateStringToTimestamp.mockReturnValue(1000000);
            const timestamp = 1000000 + 100; // within attestation window

            /* No matching transactions */
            mockVerifier.getTransactionsByReference.mockResolvedValue([]);

            /* Block height 50 is well below lastUnderlyingBlock (200) */
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(50);
            mockVerifier.getBlock.mockResolvedValue({ number: 50, timestamp: 500000 });

            const result = await service.redemptionStatus("FTestXRP", redeemState, timestamp, settings);

            expect(result).toBe("PENDING");
        });

        it("should return EXPIRED when timestamp exceeds window by a large margin", async () => {
            /**
             * Edge case: timestamp is far past the attestation window.
             * The EXPIRED check should still trigger first.
             */
            mockDateStringToTimestamp.mockReturnValue(1000000);
            const timestamp = 1000000 + 86400 * 10; // 10x the window

            const result = await service.redemptionStatus("FTestXRP", redeemState, timestamp, settings);

            expect(result).toBe("EXPIRED");
        });
    });

    /* ------------------------------------------------------------------ */
    /*                      findRedemptionPayment                          */
    /* ------------------------------------------------------------------ */

    describe("findRedemptionPayment", () => {
        const redeemState: RedeemData = {
            type: "redeem",
            requestId: "req-1",
            amountUBA: "1000000",
            paymentReference: "0xPayRef",
            firstUnderlyingBlock: "100",
            lastUnderlyingBlock: "200",
            lastUnderlyingTimestamp: "1000000",
            executorAddress: "0xExecutor",
            createdAt: "2024-01-01T00:00:00Z",
            underlyingAddress: "rAddress",
        };

        it("should return the transaction when found with sufficient amount to underlyingAddress", async () => {
            /**
             * The verifier returns a transaction whose outputs include rAddress
             * with exactly the required amount (1000000). The method should return
             * this transaction as a successful match.
             */
            const matchingTx = {
                hash: "0xTxHash123",
                inputs: [["rSender", 2000000n]] as [string, bigint][],
                outputs: [["rAddress", 1000000n]] as [string, bigint][],
                reference: "0xPayRef",
                status: 1,
            };
            mockVerifier.getTransactionsByReference.mockResolvedValue([matchingTx]);

            const result = await service.findRedemptionPayment("FTestXRP", redeemState);

            expect(result).toBeDefined();
            expect(result!.hash).toBe("0xTxHash123");
        });

        it("should return the transaction when the output amount exceeds the required amount", async () => {
            /**
             * The underlying payment sent more than the required amountUBA.
             * This is still a valid redemption payment.
             */
            const overpaidTx = {
                hash: "0xOverpaid",
                inputs: [["rSender", 5000000n]] as [string, bigint][],
                outputs: [["rAddress", 5000000n]] as [string, bigint][],
                reference: "0xPayRef",
                status: 1,
            };
            mockVerifier.getTransactionsByReference.mockResolvedValue([overpaidTx]);

            const result = await service.findRedemptionPayment("FTestXRP", redeemState);

            expect(result).toBeDefined();
            expect(result!.hash).toBe("0xOverpaid");
        });

        it("should return the transaction when multiple outputs to same address sum to sufficient amount", async () => {
            /**
             * A single transaction can have multiple outputs to the same address.
             * The method sums them all, so two outputs of 600000 each should
             * satisfy a requirement of 1000000.
             */
            const multiOutputTx = {
                hash: "0xMultiOutput",
                inputs: [["rSender", 2000000n]] as [string, bigint][],
                outputs: [
                    ["rAddress", 600000n],
                    ["rAddress", 600000n],
                ] as [string, bigint][],
                reference: "0xPayRef",
                status: 1,
            };
            mockVerifier.getTransactionsByReference.mockResolvedValue([multiOutputTx]);

            const result = await service.findRedemptionPayment("FTestXRP", redeemState);

            expect(result).toBeDefined();
            expect(result!.hash).toBe("0xMultiOutput");
        });

        it("should return undefined when no matching transaction exists", async () => {
            /**
             * The verifier returns an empty array - no transactions found
             * for the given payment reference at all.
             */
            mockVerifier.getTransactionsByReference.mockResolvedValue([]);

            const result = await service.findRedemptionPayment("FTestXRP", redeemState);

            expect(result).toBeUndefined();
        });

        it("should return undefined when transaction amount is insufficient", async () => {
            /**
             * The verifier returns a transaction but its output to rAddress
             * is below the required amountUBA (1000000).
             */
            const insufficientTx = {
                hash: "0xInsufficient",
                inputs: [["rSender", 500000n]] as [string, bigint][],
                outputs: [["rAddress", 500000n]] as [string, bigint][],
                reference: "0xPayRef",
                status: 1,
            };
            mockVerifier.getTransactionsByReference.mockResolvedValue([insufficientTx]);

            const result = await service.findRedemptionPayment("FTestXRP", redeemState);

            expect(result).toBeUndefined();
        });

        it("should return undefined when transaction goes to a different address", async () => {
            /**
             * The transaction exists and has a sufficient amount, but it is
             * directed to a different underlying address, not to redeemState.underlyingAddress.
             */
            const wrongAddressTx = {
                hash: "0xWrongAddr",
                inputs: [["rSender", 2000000n]] as [string, bigint][],
                outputs: [["rDifferentAddress", 2000000n]] as [string, bigint][],
                reference: "0xPayRef",
                status: 1,
            };
            mockVerifier.getTransactionsByReference.mockResolvedValue([wrongAddressTx]);

            const result = await service.findRedemptionPayment("FTestXRP", redeemState);

            expect(result).toBeUndefined();
        });

        it("should call verifier.getTransactionsByReference with the correct payment reference", async () => {
            mockVerifier.getTransactionsByReference.mockResolvedValue([]);

            await service.findRedemptionPayment("FTestXRP", redeemState);

            expect(mockFassetConfigService.getVerifier).toHaveBeenCalledWith("FTestXRP");
            expect(mockVerifier.getTransactionsByReference).toHaveBeenCalledWith("0xPayRef");
        });
    });

    /* ------------------------------------------------------------------ */
    /*                     redemptionTimeElapsed                           */
    /* ------------------------------------------------------------------ */

    describe("redemptionTimeElapsed", () => {
        const redeemState: RedeemData = {
            type: "redeem",
            requestId: "req-1",
            amountUBA: "1000000",
            paymentReference: "0xPayRef",
            firstUnderlyingBlock: "100",
            lastUnderlyingBlock: "200",
            lastUnderlyingTimestamp: "1000000",
            executorAddress: "0xExecutor",
            createdAt: "2024-01-01T00:00:00Z",
            underlyingAddress: "rAddress",
        };

        it("should return true when block height > lastUnderlyingBlock AND block timestamp > lastUnderlyingTimestamp", async () => {
            /**
             * Both conditions must be met:
             * 1. finalized block number (999) > lastUnderlyingBlock (200)
             * 2. finalized block timestamp (2000000) > lastUnderlyingTimestamp (1000000)
             */
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(999);
            mockVerifier.getBlock.mockResolvedValue({ number: 999, timestamp: 2000000 });

            const result = await service.redemptionTimeElapsed("FTestXRP", redeemState);

            expect(result).toBe(true);
        });

        it("should return false when block height <= lastUnderlyingBlock", async () => {
            /**
             * The finalized block number (150) is still below lastUnderlyingBlock (200),
             * so the time window has not elapsed yet, regardless of the timestamp.
             */
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(150);
            mockVerifier.getBlock.mockResolvedValue({ number: 150, timestamp: 2000000 });

            const result = await service.redemptionTimeElapsed("FTestXRP", redeemState);

            expect(result).toBe(false);
        });

        it("should return false when block height > lastUnderlyingBlock but timestamp <= lastUnderlyingTimestamp", async () => {
            /**
             * Edge case: block number has advanced past the deadline but the
             * timestamp has not. Both conditions must be true for elapsed to be true.
             */
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(999);
            mockVerifier.getBlock.mockResolvedValue({ number: 999, timestamp: 500000 });

            const result = await service.redemptionTimeElapsed("FTestXRP", redeemState);

            expect(result).toBe(false);
        });

        it("should return false when block height equals lastUnderlyingBlock exactly", async () => {
            /**
             * The condition is strictly "greater than", so equal block height
             * means the time has NOT elapsed.
             */
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(200);
            mockVerifier.getBlock.mockResolvedValue({ number: 200, timestamp: 2000000 });

            const result = await service.redemptionTimeElapsed("FTestXRP", redeemState);

            expect(result).toBe(false);
        });

        it("should throw when cannot get finalized block", async () => {
            /**
             * If verifier.getBlock() returns null/falsy, the service should
             * throw an error indicating it cannot get the finalized block.
             */
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(999);
            mockVerifier.getBlock.mockResolvedValue(null);

            await expect(service.redemptionTimeElapsed("FTestXRP", redeemState)).rejects.toThrow(
                "Cannot get finalized block from verifier"
            );
        });

        it("should call verifier methods with correct parameters", async () => {
            mockVerifier.getLastFinalizedBlockNumber.mockResolvedValue(999);
            mockVerifier.getBlock.mockResolvedValue({ number: 999, timestamp: 2000000 });

            await service.redemptionTimeElapsed("FTestXRP", redeemState);

            /* Verify we requested the verifier for the correct fasset */
            expect(mockFassetConfigService.getVerifier).toHaveBeenCalledWith("FTestXRP");
            /* Verify we fetched the block at the finalized height */
            expect(mockVerifier.getBlock).toHaveBeenCalledWith(999);
        });
    });

    /* ------------------------------------------------------------------ */
    /*                      processRedemptions                             */
    /* ------------------------------------------------------------------ */

    describe("processRedemptions", () => {
        /**
         * Helper: creates a mock Redemption entity with sensible defaults.
         * Tests override individual fields as needed.
         */
        const makeRedemption = (overrides: Record<string, any> = {}) => ({
            id: 1,
            txhash: "0xTx",
            processed: false,
            state: false,
            underlyingAddress: "rAddress",
            paymentReference: "0xPayRef",
            amountUBA: "1000000",
            firstUnderlyingBlock: "100",
            lastUnderlyingBlock: "200",
            lastUnderlyingTimestamp: "1000000",
            requestId: "req-1",
            defaulted: false,
            // validUntil far in the future so the expiry check doesn't trigger
            validUntil: Date.now() + 7 * 24 * 60 * 60 * 1000,
            fasset: "FTestXRP",
            blocked: false,
            ...overrides,
        });

        it("should mark redemption as processed when close to expiry", async () => {
            /**
             * When Date.now() > validUntil - 5 days, the redemption is expired
             * and should be marked processed=true without checking payment/default.
             */
            const redemption = makeRedemption({
                validUntil: Date.now() - 1000, // already past validUntil
            });
            mockEm.find.mockResolvedValue([redemption]);

            await (service as any).processRedemptions("FTestXRP");

            expect(redemption.processed).toBe(true);
            expect(mockEm.persistAndFlush).toHaveBeenCalledWith(redemption);
        });

        it("should mark redemption as processed when payment is found", async () => {
            /**
             * The verifier returns a matching transaction with sufficient amount.
             * The redemption should be marked processed=true.
             */
            const redemption = makeRedemption();
            mockEm.find.mockResolvedValue([redemption]);
            mockEm.findOne.mockResolvedValue(null); // no default or blocked events

            const matchingTx = {
                hash: "0xPaymentTx",
                inputs: [["rSender", 2000000n]] as [string, bigint][],
                outputs: [["rAddress", 1000000n]] as [string, bigint][],
                reference: "0xPayRef",
                status: 1,
            };
            mockVerifier.getTransactionsByReference.mockResolvedValue([matchingTx]);

            await (service as any).processRedemptions("FTestXRP");

            expect(redemption.processed).toBe(true);
            expect(redemption.defaulted).toBe(false); // not defaulted, just paid
        });

        it("should mark redemption as defaulted when RedemptionDefaultEvent is found", async () => {
            /**
             * No payment found, but a RedemptionDefaultEvent entity exists in the DB.
             * The redemption should be marked processed=true and defaulted=true.
             */
            const redemption = makeRedemption();
            mockEm.find.mockResolvedValue([redemption]);
            mockVerifier.getTransactionsByReference.mockResolvedValue([]); // no payment

            // findOne returns a default event only for RedemptionDefaultEventEntity
            mockEm.findOne.mockImplementation((entity: any, _filter: any) => {
                if (entity === RedemptionDefaultEventEntity) {
                    return Promise.resolve({ requestId: "req-1" });
                }
                return Promise.resolve(null);
            });

            await (service as any).processRedemptions("FTestXRP");

            expect(redemption.processed).toBe(true);
            expect(redemption.defaulted).toBe(true);
        });

        it("should mark redemption as blocked when RedemptionBlocked is found", async () => {
            /**
             * No payment or default event found, but a RedemptionBlocked entity exists.
             * The redemption should be marked processed=true and blocked=true.
             */
            const redemption = makeRedemption();
            mockEm.find.mockResolvedValue([redemption]);
            mockVerifier.getTransactionsByReference.mockResolvedValue([]); // no payment

            // No default event, but blocked event exists — check entity type
            mockEm.findOne.mockImplementation((entity: any, _filter: any) => {
                if (entity === RedemptionDefaultEventEntity) return Promise.resolve(null);
                if (entity === RedemptionBlocked) return Promise.resolve({ requestId: "req-1" });
                return Promise.resolve(null);
            });

            await (service as any).processRedemptions("FTestXRP");

            expect(redemption.processed).toBe(true);
            expect(redemption.blocked).toBe(true);
        });

        it("should leave redemption unprocessed when no events are found", async () => {
            /**
             * No payment, no default event, no blocked event.
             * The redemption should stay unprocessed for the next iteration.
             */
            const redemption = makeRedemption();
            mockEm.find.mockResolvedValue([redemption]);
            mockVerifier.getTransactionsByReference.mockResolvedValue([]); // no payment
            mockEm.findOne.mockResolvedValue(null); // no default or blocked events

            await (service as any).processRedemptions("FTestXRP");

            expect(redemption.processed).toBe(false);
            expect(redemption.defaulted).toBe(false);
            expect(redemption.blocked).toBe(false);
            // persistAndFlush should NOT have been called (no state change)
            expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
        });
    });
});
