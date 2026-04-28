/**
 * Unit tests for RunnerService.
 *
 * RunnerService is the heart of the background processing loop. It watches
 * for pending mintings and redemptions, checks their status against the
 * underlying chain, requests attestation proofs, and executes on-chain calls.
 *
 * We do NOT test the infinite startProcessing loop directly. Instead we test
 * the public helper methods that drive the business logic:
 *   - redemptionStatus
 *   - findRedemptionPayment
 *   - redemptionTimeElapsed
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
import { MikroORM, EntityManager } from "@mikro-orm/core";
import { RunnerService } from "../../src/services/runner.service";
import { EthersService } from "../../src/services/ethers.service";
import { ContractService } from "../../src/services/contract.service";
import { DalService } from "../../src/services/dal.service";
import { FassetConfigService } from "../../src/services/fasset.config.service";
import { RedeemData } from "../../src/interfaces/structure";
import { RedemptionDefaultEvent as RedemptionDefaultEventEntity } from "../../src/entities/RedemptionDefaultEvent";
import { RedemptionBlocked } from "../../src/entities/RedemptionBlockedEvent";

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
    fork: jest.fn(),
};
mockEm.fork.mockReturnValue(mockEm);

/** Minimal MikroORM mock; only em property is needed by the service */
const mockOrm = { em: mockEm };

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

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RunnerService,
                { provide: MikroORM, useValue: mockOrm },
                { provide: EthersService, useValue: mockEthersService },
                { provide: ContractService, useValue: mockContractService },
                { provide: DalService, useValue: mockDalService },
                { provide: FassetConfigService, useValue: mockFassetConfigService },
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
