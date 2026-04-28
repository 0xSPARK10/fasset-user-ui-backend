/**
 * Unit tests for DalService.
 *
 * DalService manages communication with the Flare Data Access Layer (DAL).
 * It creates axios clients for each configured DAL URL, handles proof retrieval,
 * round finalization checks, and submission of attestation requests to the
 * Flare Data Connector (FDC).
 *
 * All external dependencies (ethers, axios, contracts) are mocked so no real
 * network calls are made.
 */

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

/* ---- mock logger to suppress output ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

/* ---- mock axios to intercept all HTTP calls ---- */
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn().mockReturnValue({
            get: jest.fn(),
            post: jest.fn(),
        }),
    },
}));

/* ---- mock axios-retry so retry logic does not interfere with tests ---- */
jest.mock("axios-retry", () => ({
    __esModule: true,
    default: jest.fn(),
    isNetworkOrIdempotentRequestError: jest.fn(),
    exponentialDelay: jest.fn(),
}));

/* ---- mock the typechain factory used for fee configuration lookups ---- */
jest.mock("../../src/typechain-ethers-v6", () => ({
    IFdcRequestFeeConfigurations__factory: {
        connect: jest.fn().mockReturnValue({
            getRequestFee: jest.fn().mockResolvedValue(100n),
        }),
    },
}));

/* ---- mock the retry utility to avoid real delays in tests ---- */
jest.mock("../../src/utils/retry", () => ({
    retry: jest.fn().mockImplementation(async (fn: () => Promise<any>) => fn()),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DalService, AttestationNotProved } from "../../src/services/dal.service";
import { ContractService } from "../../src/services/contract.service";
import { EthersService } from "../../src/services/ethers.service";
import axios from "axios";

/* Grab the mock axios client that axios.create() returns.
 * Since the mock always returns the same object, we can capture it here
 * and configure get/post responses per-test. */
const mockAxiosClient = (axios.create as jest.Mock)() as {
    get: jest.Mock;
    post: jest.Mock;
};

/* -------------------------------------------------------------------------- */
/*                        ZERO_BYTES32 constant mirror                        */
/* -------------------------------------------------------------------------- */

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NON_ZERO_BYTES32 = "0x" + "ab".repeat(32);

/* -------------------------------------------------------------------------- */
/*                               MOCK PROVIDERS                               */
/* -------------------------------------------------------------------------- */

/** Mock ConfigService: returns comma-separated DAL URLs and API keys */
const mockConfigService = {
    get: jest.fn().mockImplementation((key: string) => {
        if (key === "DAL_URLS") return "https://dal1.example.com,https://dal2.example.com";
        if (key === "DAL_API_KEY") return "key1,key2";
        return undefined;
    }),
};

/** Mock Relay contract with merkleRoots and getVotingRoundId methods */
const mockRelay = {
    merkleRoots: jest.fn().mockResolvedValue(ZERO_BYTES32),
    getVotingRoundId: jest.fn().mockResolvedValue(100n),
};

/** Mock FdcHub contract with fee configuration lookup and attestation request */
const mockFdcHub = {
    fdcRequestFeeConfigurations: jest.fn().mockResolvedValue("0xFeeConfigAddress"),
    requestAttestation: jest.fn().mockResolvedValue({
        wait: jest.fn().mockResolvedValue({
            hash: "0xtxhash",
            blockNumber: 1000,
        }),
    }),
};

/** Mock FdcVerification contract with all verification methods */
const mockFdcVerification = {
    verifyPayment: jest.fn().mockResolvedValue(true),
    verifyReferencedPaymentNonexistence: jest.fn().mockResolvedValue(true),
    verifyConfirmedBlockHeightExists: jest.fn().mockResolvedValue(true),
    verifyBalanceDecreasingTransaction: jest.fn().mockResolvedValue(true),
    verifyAddressValidity: jest.fn().mockResolvedValue(true),
};

/** Mock ContractService: returns the correct mock contract by name */
const mockContractService = {
    get: jest.fn().mockImplementation((name: string) => {
        if (name === "Relay") return mockRelay;
        if (name === "FdcHub") return mockFdcHub;
        if (name === "FdcVerification") return mockFdcVerification;
        return {};
    }),
};

/** Mock EthersService: provides a fake provider and signer */
const mockEthersService = {
    getProvider: jest.fn().mockReturnValue({
        getBlock: jest.fn().mockResolvedValue({ timestamp: 1000000 }),
    }),
    getSigner: jest.fn().mockReturnValue({}),
};

/* -------------------------------------------------------------------------- */
/*                                TEST SUITE                                  */
/* -------------------------------------------------------------------------- */

describe("DalService", () => {
    let service: DalService;

    beforeEach(async () => {
        /* Reset all mock call histories between tests */
        jest.clearAllMocks();

        /* Re-configure default mock config values (in case a test overrode them) */
        mockConfigService.get.mockImplementation((key: string) => {
            if (key === "DAL_URLS") return "https://dal1.example.com,https://dal2.example.com";
            if (key === "DAL_API_KEY") return "key1,key2";
            return undefined;
        });

        /* Reset default relay mock to return ZERO_BYTES32 (not finalized) */
        mockRelay.merkleRoots.mockResolvedValue(ZERO_BYTES32);
        mockRelay.getVotingRoundId.mockResolvedValue(100n);

        /* Reset FdcVerification mock to return true (valid proof) */
        mockFdcVerification.verifyPayment.mockResolvedValue(true);
        mockFdcVerification.verifyReferencedPaymentNonexistence.mockResolvedValue(true);
        mockFdcVerification.verifyConfirmedBlockHeightExists.mockResolvedValue(true);
        mockFdcVerification.verifyBalanceDecreasingTransaction.mockResolvedValue(true);
        mockFdcVerification.verifyAddressValidity.mockResolvedValue(true);

        /* Build the NestJS testing module with all mocked providers */
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DalService,
                { provide: ConfigService, useValue: mockConfigService },
                { provide: ContractService, useValue: mockContractService },
                { provide: EthersService, useValue: mockEthersService },
            ],
        }).compile();

        service = module.get<DalService>(DalService);

        /* Initialize the service so relay, fdcHub and fdcVerification are set from ContractService */
        service.onModuleInit();
    });

    /* ------------------------------------------------------------------ */
    /*                          BASIC CHECKS                              */
    /* ------------------------------------------------------------------ */

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    /* ------------------------------------------------------------------ */
    /*                           CONSTRUCTOR                              */
    /* ------------------------------------------------------------------ */

    describe("constructor", () => {
        it("should throw when DAL_URLS is not configured", async () => {
            /* Create a separate config that returns empty string for DAL_URLS */
            const emptyConfigService = {
                get: jest.fn().mockImplementation((key: string) => {
                    if (key === "DAL_URLS") return "";
                    if (key === "DAL_API_KEY") return "";
                    return undefined;
                }),
            };

            /* The DalService constructor should throw synchronously during module compile */
            await expect(
                Test.createTestingModule({
                    providers: [
                        DalService,
                        { provide: ConfigService, useValue: emptyConfigService },
                        { provide: ContractService, useValue: mockContractService },
                        { provide: EthersService, useValue: mockEthersService },
                    ],
                }).compile()
            ).rejects.toThrow("DAL_URLS not configured");
        });

        it("should create axios clients for each configured DAL URL", () => {
            /* The constructor should call axios.create once per URL.
             * Since we have 2 URLs, expect at least 2 calls (plus the one from our
             * mockAxiosClient capture above). We check the calls include our URLs. */
            const createCalls = (axios.create as jest.Mock).mock.calls;
            const baseURLs = createCalls.map((call: any[]) => call[0]?.baseURL).filter(Boolean);
            expect(baseURLs).toContain("https://dal1.example.com");
            expect(baseURLs).toContain("https://dal2.example.com");
        });
    });

    /* ------------------------------------------------------------------ */
    /*                          onModuleInit                              */
    /* ------------------------------------------------------------------ */

    describe("onModuleInit", () => {
        it("should retrieve Relay, FdcHub and FdcVerification contracts from ContractService", () => {
            /* onModuleInit was already called in beforeEach; verify contracts were fetched */
            expect(mockContractService.get).toHaveBeenCalledWith("Relay");
            expect(mockContractService.get).toHaveBeenCalledWith("FdcHub");
            expect(mockContractService.get).toHaveBeenCalledWith("FdcVerification");
        });
    });

    /* ------------------------------------------------------------------ */
    /*                         roundFinalized                             */
    /* ------------------------------------------------------------------ */

    describe("roundFinalized", () => {
        it("should return true when round <= latestFinalizedRound", async () => {
            /* Set up DAL to report round 42 as latest, and relay says it IS finalized on chain */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: 42 } },
            });
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            const result = await service.roundFinalized(40);
            expect(result).toBe(true);
        });

        it("should return false when round > latestFinalizedRound", async () => {
            /* DAL reports round 42, relay confirms it's finalized on chain,
             * but we ask about round 50 which is beyond the latest finalized */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: 42 } },
            });
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            const result = await service.roundFinalized(50);
            expect(result).toBe(false);
        });

        it("should return false when an error occurs", async () => {
            /* Force the DAL GET request to reject, causing latestFinalizedRound to throw,
             * which roundFinalized catches and returns false */
            mockAxiosClient.get.mockRejectedValue(new Error("Network error"));

            const result = await service.roundFinalized(10);
            expect(result).toBe(false);
        });
    });

    /* ------------------------------------------------------------------ */
    /*                      latestFinalizedRound                          */
    /* ------------------------------------------------------------------ */

    describe("latestFinalizedRound", () => {
        it("should return the round from DAL when it is finalized on chain", async () => {
            /* DAL says latest round is 42, relay confirms merkle root is non-zero (finalized) */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: 42 } },
            });
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            const round = await service.latestFinalizedRound();
            expect(round).toBe(42);
        });

        it("should return round - 1 when the latest round is NOT finalized on chain", async () => {
            /* DAL says latest round is 42, but relay returns ZERO_BYTES32
             * meaning the round is not yet finalized on chain */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: 42 } },
            });
            mockRelay.merkleRoots.mockResolvedValue(ZERO_BYTES32);

            const round = await service.latestFinalizedRound();
            expect(round).toBe(41);
        });

        it("should throw when no DAL clients return valid data", async () => {
            /* All DAL clients reject, so latestFinalizedRoundOnDal throws directly */
            mockAxiosClient.get.mockRejectedValue(new Error("Connection refused"));

            await expect(service.latestFinalizedRound()).rejects.toThrow(
                "No data access layer clients available for obtaining latest round"
            );
        });
    });

    /* ------------------------------------------------------------------ */
    /*                          verifyProof                               */
    /* ------------------------------------------------------------------ */

    describe("verifyProof", () => {
        const PAYMENT_TYPE = "0x5061796d656e7400000000000000000000000000000000000000000000000000";
        const NONEXISTENCE_TYPE = "0x5265666572656e6365645061796d656e744e6f6e6578697374656e6365000000";
        const CONFIRMED_BLOCK_TYPE = "0x436f6e6669726d6564426c6f636b486569676874457869737473000000000000";
        const BALANCE_DEC_TYPE = "0x42616c616e636544656372656173696e675472616e73616374696f6e00000000";
        const ADDRESS_VALIDITY_TYPE = "0x4164647265737356616c69646974790000000000000000000000000000000000";

        it("should call verifyPayment for Payment attestation type", async () => {
            const proof = { merkleProof: ["0xp1"], data: { attestationType: PAYMENT_TYPE } };
            const result = await service.verifyProof(proof);
            expect(result).toBe(true);
            expect(mockFdcVerification.verifyPayment).toHaveBeenCalled();
        });

        it("should call verifyReferencedPaymentNonexistence for that attestation type", async () => {
            const proof = { merkleProof: ["0xp1"], data: { attestationType: NONEXISTENCE_TYPE } };
            const result = await service.verifyProof(proof);
            expect(result).toBe(true);
            expect(mockFdcVerification.verifyReferencedPaymentNonexistence).toHaveBeenCalled();
        });

        it("should call verifyConfirmedBlockHeightExists for that attestation type", async () => {
            const proof = { merkleProof: ["0xp1"], data: { attestationType: CONFIRMED_BLOCK_TYPE } };
            const result = await service.verifyProof(proof);
            expect(result).toBe(true);
            expect(mockFdcVerification.verifyConfirmedBlockHeightExists).toHaveBeenCalled();
        });

        it("should call verifyBalanceDecreasingTransaction for that attestation type", async () => {
            const proof = { merkleProof: ["0xp1"], data: { attestationType: BALANCE_DEC_TYPE } };
            const result = await service.verifyProof(proof);
            expect(result).toBe(true);
            expect(mockFdcVerification.verifyBalanceDecreasingTransaction).toHaveBeenCalled();
        });

        it("should call verifyAddressValidity for that attestation type", async () => {
            const proof = { merkleProof: ["0xp1"], data: { attestationType: ADDRESS_VALIDITY_TYPE } };
            const result = await service.verifyProof(proof);
            expect(result).toBe(true);
            expect(mockFdcVerification.verifyAddressValidity).toHaveBeenCalled();
        });

        it("should return false for unknown attestation type", async () => {
            const proof = { merkleProof: ["0xp1"], data: { attestationType: "0xunknown" } };
            const result = await service.verifyProof(proof);
            expect(result).toBe(false);
        });

        it("should return false when verification contract throws", async () => {
            mockFdcVerification.verifyPayment.mockRejectedValueOnce(new Error("revert"));
            const proof = { merkleProof: ["0xp1"], data: { attestationType: PAYMENT_TYPE } };
            const result = await service.verifyProof(proof);
            expect(result).toBe(false);
        });
    });

    /* ------------------------------------------------------------------ */
    /*                          obtainProof                               */
    /* ------------------------------------------------------------------ */

    describe("obtainProof", () => {
        const roundId = 42;
        const requestBytes = "0xdeadbeef";
        const PAYMENT_TYPE = "0x5061796d656e7400000000000000000000000000000000000000000000000000";

        it("should return NOT_FINALIZED when the round is not finalized on chain", async () => {
            /* Relay returns ZERO_BYTES32, meaning the round hasn't been finalized yet */
            mockRelay.merkleRoots.mockResolvedValue(ZERO_BYTES32);

            const result = await service.obtainProof(roundId, requestBytes);
            expect(result).toBe(AttestationNotProved.NOT_FINALIZED);
        });

        it("should return a valid proof when a client returns proof data that verifies on-chain", async () => {
            /* Round IS finalized on chain */
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            /* Client has the requested round */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: roundId } },
            });

            /* DAL client returns a valid proof object */
            const mockProofResponse = {
                data: {
                    response: { attestationType: PAYMENT_TYPE, sourceId: "0x02" },
                    proof: ["0xproof1", "0xproof2"],
                },
            };
            mockAxiosClient.post.mockResolvedValue(mockProofResponse);

            /* Verification succeeds */
            mockFdcVerification.verifyPayment.mockResolvedValue(true);

            const result = await service.obtainProof(roundId, requestBytes);

            /* The result should be an AttestationProof object */
            expect(result).toEqual({
                data: { attestationType: PAYMENT_TYPE, sourceId: "0x02" },
                merkleProof: ["0xproof1", "0xproof2"],
            });
        });

        it("should skip a proof that fails on-chain verification and try next client", async () => {
            /* Round IS finalized on chain */
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            /* Client has the requested round */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: roundId } },
            });

            /* DAL client returns a proof */
            const mockProofResponse = {
                data: {
                    response: { attestationType: PAYMENT_TYPE, sourceId: "0x02" },
                    proof: ["0xproof1"],
                },
            };
            mockAxiosClient.post.mockResolvedValue(mockProofResponse);

            /* First verification fails, second succeeds (two clients configured) */
            mockFdcVerification.verifyPayment.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

            const result = await service.obtainProof(roundId, requestBytes);

            /* The result should still be a valid proof (from second client) */
            expect(result).toEqual({
                data: { attestationType: PAYMENT_TYPE, sourceId: "0x02" },
                merkleProof: ["0xproof1"],
            });
            expect(mockFdcVerification.verifyPayment).toHaveBeenCalledTimes(2);
        });

        it("should skip clients whose latest round is less than the requested round", async () => {
            /* Round IS finalized on chain */
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            /* Client reports a round lower than requested — should be skipped */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: roundId - 1 } },
            });

            /* Even though post would return a proof, it should never be called
             * because all clients are skipped due to round mismatch */
            mockAxiosClient.post.mockResolvedValue({
                data: {
                    response: { attestationType: PAYMENT_TYPE },
                    proof: ["0xp1"],
                },
            });

            await expect(service.obtainProof(roundId, requestBytes)).rejects.toThrow(
                "There aren't any working attestation providers"
            );

            /* Post should never have been called since clients were skipped */
            expect(mockAxiosClient.post).not.toHaveBeenCalled();
        });

        it("should return DISPROVED when the client returns a 400 error", async () => {
            /* Round IS finalized on chain */
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            /* Client has the requested round */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: roundId } },
            });

            /* DAL client returns a 400 status, indicating the attestation was disproved */
            const error400 = {
                response: { status: 400, data: { error: "Request disproved" } },
                message: "Request failed with status code 400",
            };
            mockAxiosClient.post.mockRejectedValue(error400);

            const result = await service.obtainProof(roundId, requestBytes);
            expect(result).toBe(AttestationNotProved.DISPROVED);
        });

        it('should throw "There aren\'t any working attestation providers" when all clients fail with non-400 errors', async () => {
            /* Round IS finalized on chain */
            mockRelay.merkleRoots.mockResolvedValue(NON_ZERO_BYTES32);

            /* Client has the requested round */
            mockAxiosClient.get.mockResolvedValue({
                data: { latest_fdc: { voting_round_id: roundId } },
            });

            /* All DAL clients fail with a 500 error (not 400), so no proof and no disproval */
            const error500 = {
                response: { status: 500 },
                message: "Internal Server Error",
            };
            mockAxiosClient.post.mockRejectedValue(error500);

            await expect(service.obtainProof(roundId, requestBytes)).rejects.toThrow(
                "There aren't any working attestation providers"
            );
        });
    });

    /* ------------------------------------------------------------------ */
    /*                 submitRequestToFlareDataConnector                   */
    /* ------------------------------------------------------------------ */

    describe("submitRequestToFlareDataConnector", () => {
        const abiEncodedRequest = "0xabiEncodedRequest";

        it("should submit attestation request and return { round, data }", async () => {
            /* Mock the FdcHub and relay to return expected values:
             * - fdcHub.fdcRequestFeeConfigurations -> fee config address
             * - fdcHub.requestAttestation -> tx with receipt
             * - provider.getBlock -> block with timestamp
             * - relay.getVotingRoundId -> round 100 */
            const result = await service.submitRequestToFlareDataConnector(abiEncodedRequest);

            expect(result).toEqual({
                round: 100,
                data: abiEncodedRequest,
            });

            /* Verify the FdcHub was called with the correct request and fee value */
            expect(mockFdcHub.requestAttestation).toHaveBeenCalledWith(abiEncodedRequest, { value: 100n });
        });

        it("should throw when the transaction receipt is null", async () => {
            /* Override requestAttestation to return a tx whose wait() resolves to null */
            mockFdcHub.requestAttestation.mockResolvedValueOnce({
                wait: jest.fn().mockResolvedValue(null),
            });

            await expect(service.submitRequestToFlareDataConnector(abiEncodedRequest)).rejects.toThrow(
                "Transaction receipt is null"
            );
        });
    });

    /* ------------------------------------------------------------------ */
    /*                        attestationProved                           */
    /* ------------------------------------------------------------------ */

    describe("attestationProved", () => {
        it("should return true for a valid proof object", () => {
            /* A valid AttestationProof is a non-null object with data and merkleProof */
            const proof = {
                data: { attestationType: "0x01" },
                merkleProof: ["0xproof1"],
            };
            expect(service.attestationProved(proof)).toBe(true);
        });

        it("should return false for NOT_FINALIZED", () => {
            /* AttestationNotProved.NOT_FINALIZED is a string, not an object */
            expect(service.attestationProved(AttestationNotProved.NOT_FINALIZED)).toBe(false);
        });

        it("should return false for DISPROVED", () => {
            /* AttestationNotProved.DISPROVED is a string, not an object */
            expect(service.attestationProved(AttestationNotProved.DISPROVED)).toBe(false);
        });

        it("should return false for null", () => {
            expect(service.attestationProved(null)).toBe(false);
        });

        it("should return false for undefined", () => {
            expect(service.attestationProved(undefined)).toBe(false);
        });
    });
});
