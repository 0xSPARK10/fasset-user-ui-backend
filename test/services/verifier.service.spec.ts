/**
 * Unit tests for VerifierService.
 *
 * VerifierService is NOT @Injectable — it is instantiated directly with
 * `new VerifierService(chainId, urls, apiKeys)`. It wraps axios clients
 * (with retry logic) to communicate with blockchain verifier / indexer
 * endpoints. Chain-specific logic diverges for UTXO (BTC/DOGE) and XRP.
 *
 * All HTTP calls are mocked via the axios mock so no real network
 * requests are made during testing.
 */

/* ---- mock ethers before any imports ---- */
jest.mock("ethers", () => {
    class MockContractFactory {}
    return {
        ethers: { JsonRpcProvider: jest.fn(), Wallet: jest.fn() },
        keccak256: jest.fn().mockReturnValue("0xmockedhash"),
        toUtf8Bytes: jest.fn().mockReturnValue(new Uint8Array(0)),
        FetchRequest: jest.fn().mockImplementation(() => ({ setHeader: jest.fn() })),
        Contract: jest.fn(),
        Interface: jest.fn(),
        ContractFactory: MockContractFactory,
        encodeBytes32String: jest.fn().mockReturnValue("0x" + "0".repeat(64)),
    };
});

/* ---- mock axios ---- */
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn().mockReturnValue({
            get: jest.fn(),
            post: jest.fn(),
        }),
    },
}));

/* ---- mock axios-retry ---- */
jest.mock("axios-retry", () => ({
    __esModule: true,
    default: jest.fn(),
    isNetworkOrIdempotentRequestError: jest.fn(),
    exponentialDelay: jest.fn(),
}));

/* ---- mock logger ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

/* ---- mock the retry utility to avoid real delays in tests ---- */
jest.mock("../../src/utils/retry", () => ({
    retry: jest.fn().mockImplementation(async (fn: () => Promise<any>) => fn()),
}));

import { VerifierService, ChainId } from "../../src/services/verifier.service";
import { InternalServerErrorException } from "@nestjs/common";
import axios from "axios";

/* Obtain the mock axios client returned by axios.create() */
const mockAxiosClient = (axios.create as jest.Mock)() as {
    get: jest.Mock;
    post: jest.Mock;
};

/* -------------------------------------------------------------------------- */
/*                               TEST HELPERS                                 */
/* -------------------------------------------------------------------------- */

/**
 * Creates a VerifierService instance for the given chain.
 * Uses sensible default URLs and API keys.
 */
function createService(chainId: ChainId, urls = ["https://verifier.example.com"], apiKeys = ["test-key"]): VerifierService {
    return new VerifierService(chainId, urls, apiKeys);
}

/**
 * Returns a mock UTXO-style IndexerTransaction response (BTC / DOGE)
 * wrapped in an ApiWrapper with status "OK".
 */
function utxoTransactionResponse(overrides: Record<string, any> = {}) {
    return {
        data: {
            status: "OK",
            data: {
                transactionId: "txhash123",
                transactionType: "regular",
                paymentReference: "0xref",
                response: {
                    vin: [
                        {
                            prevout: {
                                scriptPubKey: { address: "addr1" },
                                value: 0.0005,
                            },
                        },
                    ],
                    vout: [
                        {
                            scriptPubKey: { address: "addr2" },
                            value: 0.0004,
                        },
                    ],
                },
                ...overrides,
            },
        },
    };
}

/**
 * Returns a mock XRP-style IndexerTransaction response wrapped in ApiWrapper.
 */
function xrpTransactionResponse(
    metaResult = "tesSUCCESS",
    overrides: Record<string, any> = {}
) {
    return {
        data: {
            status: "OK",
            data: {
                transactionId: "TXHASH123",
                transactionType: "Payment",
                paymentReference: "0xref",
                isNativePayment: true,
                response: {
                    result: {
                        Account: "rSender",
                        Destination: "rReceiver",
                        Amount: "1000000",
                        Fee: "12",
                        meta: {
                            TransactionResult: metaResult,
                            delivered_amount: "1000000",
                        },
                    },
                },
                ...overrides,
            },
        },
    };
}

/* -------------------------------------------------------------------------- */
/*                                  TESTS                                     */
/* -------------------------------------------------------------------------- */

describe("VerifierService", () => {
    /* Reset all mock call counts between tests */
    beforeEach(() => {
        jest.clearAllMocks();
    });

    /* ---------------------------------------------------------------------- */
    /*                          CONSTRUCTOR TESTS                             */
    /* ---------------------------------------------------------------------- */

    describe("constructor", () => {
        it("should create an instance for an XRP chain", () => {
            const service = createService(ChainId.testXRP);
            expect(service).toBeDefined();
        });

        it("should create an instance for a UTXO chain (BTC)", () => {
            const service = createService(ChainId.testBTC);
            expect(service).toBeDefined();
        });

        it("should create an instance for a UTXO chain (DOGE)", () => {
            const service = createService(ChainId.testDOGE);
            expect(service).toBeDefined();
        });

        it("should throw if no URLs are provided", () => {
            expect(() => new VerifierService(ChainId.BTC, [], [])).toThrow(
                "Verifier URLs not configured",
            );
        });

        it("should call axios.create for each URL supplied", () => {
            const urls = ["https://v1.example.com", "https://v2.example.com"];
            createService(ChainId.BTC, urls, ["key1", "key2"]);

            /* axios.create is also called once globally for mockAxiosClient,
               so we check that it was called at least twice for the two URLs */
            expect(axios.create).toHaveBeenCalledWith(
                expect.objectContaining({ baseURL: urls[0] }),
            );
            expect(axios.create).toHaveBeenCalledWith(
                expect.objectContaining({ baseURL: urls[1] }),
            );
        });

        it("should NOT have console.log calls in the constructor", () => {
            /* The stale console.log statements should have been removed */
            const consoleSpy = jest.spyOn(console, "log").mockImplementation();
            createService(ChainId.testBTC);
            expect(consoleSpy).not.toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                     getPaymentEncodedRequest                           */
    /* ---------------------------------------------------------------------- */

    describe("getPaymentEncodedRequest", () => {
        it("should POST to /Payment/prepareRequest and return the abiEncodedRequest", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.post.mockResolvedValueOnce({
                data: { abiEncodedRequest: "0xencoded123" },
            });

            const result = await service.getPaymentEncodedRequest("txhash");
            expect(result).toBe("0xencoded123");

            /* Verify the correct endpoint was called */
            expect(mockAxiosClient.post).toHaveBeenCalledWith(
                "/Payment/prepareRequest",
                expect.objectContaining({
                    requestBody: expect.objectContaining({
                        transactionId: "0xtxhash",
                    }),
                }),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });

        it("should throw InternalServerErrorException when the response is null", async () => {
            const service = createService(ChainId.testBTC);

            /* Simulate all clients failing — postWithClients returns null */
            mockAxiosClient.post.mockRejectedValueOnce(new Error("network error"));

            await expect(service.getPaymentEncodedRequest("txhash")).rejects.toThrow(
                InternalServerErrorException,
            );
        });

        it("should prefix the transaction hash with 0x if not already present", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.post.mockResolvedValueOnce({
                data: { abiEncodedRequest: "0xresult" },
            });

            await service.getPaymentEncodedRequest("noprefixhash");

            expect(mockAxiosClient.post).toHaveBeenCalledWith(
                "/Payment/prepareRequest",
                expect.objectContaining({
                    requestBody: expect.objectContaining({
                        transactionId: "0xnoprefixhash",
                    }),
                }),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });

        it("should not double-prefix a hash that already starts with 0x", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.post.mockResolvedValueOnce({
                data: { abiEncodedRequest: "0xresult" },
            });

            await service.getPaymentEncodedRequest("0xalreadyprefixed");

            expect(mockAxiosClient.post).toHaveBeenCalledWith(
                "/Payment/prepareRequest",
                expect.objectContaining({
                    requestBody: expect.objectContaining({
                        transactionId: "0xalreadyprefixed",
                    }),
                }),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });
    });

    /* ---------------------------------------------------------------------- */
    /*               getPaymentNonexistenceEncodedRequest                     */
    /* ---------------------------------------------------------------------- */

    describe("getPaymentNonexistenceEncodedRequest", () => {
        const defaultArgs = [
            "100",   // minimalBlockNumber
            "200",   // deadlineBlockNumber
            "99999", // deadlineTimestamp
            "rAddr", // destinationAddress
            "5000",  // amount
            "0xpaymentref", // paymentReference
        ] as const;

        it("should POST to /ReferencedPaymentNonexistence/prepareRequest and return abiEncodedRequest", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.post.mockResolvedValueOnce({
                data: { abiEncodedRequest: "0xnonexistence_encoded" },
            });

            const result = await service.getPaymentNonexistenceEncodedRequest(...defaultArgs);
            expect(result).toBe("0xnonexistence_encoded");

            expect(mockAxiosClient.post).toHaveBeenCalledWith(
                "/ReferencedPaymentNonexistence/prepareRequest",
                expect.objectContaining({
                    requestBody: expect.objectContaining({
                        minimalBlockNumber: "100",
                        deadlineBlockNumber: "200",
                        deadlineTimestamp: "99999",
                        standardPaymentReference: "0xpaymentref",
                    }),
                }),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });

        it("should return 'INVALID' when the response status contains the INVALID string", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.post.mockResolvedValueOnce({
                data: {
                    status: "INVALID: REFERENCED TRANSACTION EXISTS",
                    abiEncodedRequest: null,
                },
            });

            const result = await service.getPaymentNonexistenceEncodedRequest(...defaultArgs);
            expect(result).toBe("INVALID");
        });

        it("should throw InternalServerErrorException when the response is null (all clients fail)", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.post.mockRejectedValueOnce(new Error("timeout"));

            await expect(
                service.getPaymentNonexistenceEncodedRequest(...defaultArgs),
            ).rejects.toThrow(InternalServerErrorException);
        });

        it("should throw InternalServerErrorException when abiEncodedRequest is missing and status is not INVALID", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.post.mockResolvedValueOnce({
                data: { status: "OK", abiEncodedRequest: null },
            });

            await expect(
                service.getPaymentNonexistenceEncodedRequest(...defaultArgs),
            ).rejects.toThrow(InternalServerErrorException);
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                     getLastFinalizedBlockNumber                        */
    /* ---------------------------------------------------------------------- */

    describe("getLastFinalizedBlockNumber", () => {
        it("should GET /api/indexer/block-height-indexed and return the block number", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: { status: "OK", data: 12345 },
            });

            const result = await service.getLastFinalizedBlockNumber();
            expect(result).toBe(12345);

            expect(mockAxiosClient.get).toHaveBeenCalledWith(
                "/api/indexer/block-height-indexed",
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });

        it("should throw InternalServerErrorException when response is null", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockRejectedValueOnce(new Error("failure"));

            await expect(service.getLastFinalizedBlockNumber()).rejects.toThrow(
                InternalServerErrorException,
            );
        });

        it("should throw InternalServerErrorException when status is not OK", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: { status: "ERROR", errorMessage: "Service unavailable" },
            });

            await expect(service.getLastFinalizedBlockNumber()).rejects.toThrow(
                InternalServerErrorException,
            );
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                              getBlock                                  */
    /* ---------------------------------------------------------------------- */

    describe("getBlock", () => {
        it("should GET the correct endpoint and return an IBlock", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        blockHash: "0xblockhash",
                        blockNumber: 42,
                        timestamp: 1700000000,
                    },
                },
            });

            const block = await service.getBlock(42);

            expect(block).toEqual({
                hash: "0xblockhash",
                number: 42,
                timestamp: 1700000000,
            });

            expect(mockAxiosClient.get).toHaveBeenCalledWith(
                "/api/indexer/confirmed-block-at/42",
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });

        it("should throw InternalServerErrorException when the response is null", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockRejectedValueOnce(new Error("fail"));

            await expect(service.getBlock(42)).rejects.toThrow(
                InternalServerErrorException,
            );
        });

        it("should return null when block is not found", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: { status: "ERROR", errorMessage: "Block not found" },
            });

            const block = await service.getBlock(99999);
            expect(block).toBeNull();
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                           getTransaction                               */
    /* ---------------------------------------------------------------------- */

    describe("getTransaction", () => {
        it("should return an ITransaction for a UTXO chain", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(utxoTransactionResponse());

            const tx = await service.getTransaction("txhash123");

            expect(tx).not.toBeNull();
            expect(tx!.hash).toBe("txhash123");
            expect(tx!.reference).toBe("0xref");
            /* UTXO chains always return TX_SUCCESS (1) */
            expect(tx!.status).toBe(1);
        });

        it("should return an ITransaction for an XRP chain", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tesSUCCESS"));

            const tx = await service.getTransaction("txhash123");

            expect(tx).not.toBeNull();
            /* XRP hashes are normalized to uppercase */
            expect(tx!.hash).toBe("TXHASH123");
            expect(tx!.status).toBe(1);
        });

        it("should return null when the response has no data", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockRejectedValueOnce(new Error("fail"));

            const tx = await service.getTransaction("missing");
            expect(tx).toBeNull();
        });

        it("should return null when response.data is falsy", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: { status: "OK", data: null },
            });

            const tx = await service.getTransaction("missing");
            expect(tx).toBeNull();
        });

        it("should return null when status is not OK and errorMessage contains 'not found'", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: { status: "ERROR", errorMessage: "Transaction not found" },
            });

            const tx = await service.getTransaction("missing");
            expect(tx).toBeNull();
        });

        it("should normalize XRP transaction hash to uppercase", async () => {
            const service = createService(ChainId.XRP);

            mockAxiosClient.get.mockResolvedValueOnce(
                xrpTransactionResponse("tesSUCCESS", {
                    transactionId: "lowercasehash",
                }),
            );

            const tx = await service.getTransaction("lowercasehash");

            expect(tx).not.toBeNull();
            expect(tx!.hash).toBe("LOWERCASEHASH");
        });

        it("should NOT uppercase hash for UTXO chains", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(
                utxoTransactionResponse({ transactionId: "abcdef" }),
            );

            const tx = await service.getTransaction("abcdef");

            expect(tx).not.toBeNull();
            expect(tx!.hash).toBe("abcdef");
        });

        it("should prefix transaction hash with 0x in the request URL", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(utxoTransactionResponse());

            await service.getTransaction("noprefixhash");

            expect(mockAxiosClient.get).toHaveBeenCalledWith(
                "/api/indexer/transaction/0xnoprefixhash?returnResponse=true",
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                     getTransactionsByReference                         */
    /* ---------------------------------------------------------------------- */

    describe("getTransactionsByReference", () => {
        it("should return an array of ITransaction objects for UTXO chains", async () => {
            const service = createService(ChainId.testBTC);

            /* First page returns two transactions, second page is empty (stops pagination) */
            mockAxiosClient.get
                .mockResolvedValueOnce({
                    data: {
                        status: "OK",
                        data: {
                            items: [
                                utxoTransactionResponse().data.data,
                                utxoTransactionResponse({ transactionId: "tx2" }).data.data,
                            ],
                        },
                    },
                })
                .mockResolvedValueOnce({
                    data: { status: "OK", data: { items: [] } },
                });

            const txs = await service.getTransactionsByReference("0xref123");

            expect(txs).toHaveLength(2);
            expect(txs[0].hash).toBe("txhash123");
            expect(txs[1].hash).toBe("tx2");
        });

        it("should throw when the response data is null (all clients fail)", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockRejectedValueOnce(new Error("fail"));

            await expect(
                service.getTransactionsByReference("0xref"),
            ).rejects.toThrow();
        });

        it("should throw when response status is not OK", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: { status: "ERROR", errorMessage: "bad request" },
            });

            await expect(
                service.getTransactionsByReference("0xref"),
            ).rejects.toThrow("Cannot retrieve transaction by reference");
        });

        it("should call the correct indexer endpoint with the reference and pagination params", async () => {
            const service = createService(ChainId.testBTC);

            /* Empty items page to stop pagination immediately */
            mockAxiosClient.get.mockResolvedValueOnce({
                data: { status: "OK", data: { items: [] } },
            });

            await service.getTransactionsByReference("0xpayref");

            expect(mockAxiosClient.get).toHaveBeenCalledWith(
                "/api/indexer/transaction?paymentReference=0xpayref&returnResponse=true&limit=100&offset=0",
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });

        it("should paginate when first page returns exactly 100 items", async () => {
            const service = createService(ChainId.testBTC);

            /* First page: 100 items (full page) */
            const fullPage = Array.from({ length: 100 }, (_, i) =>
                utxoTransactionResponse({ transactionId: `tx${i}` }).data.data,
            );

            /* Second page: 1 item (not empty, so pagination continues) */
            const lastPage = [utxoTransactionResponse({ transactionId: "txlast" }).data.data];

            /* Third page: empty (stops pagination) */
            mockAxiosClient.get
                .mockResolvedValueOnce({ data: { status: "OK", data: { items: fullPage } } })
                .mockResolvedValueOnce({ data: { status: "OK", data: { items: lastPage } } })
                .mockResolvedValueOnce({ data: { status: "OK", data: { items: [] } } });

            const txs = await service.getTransactionsByReference("0xref");

            /* Should have 101 total results */
            expect(txs).toHaveLength(101);

            /* Verify three GET calls were made with different offsets */
            expect(mockAxiosClient.get).toHaveBeenCalledTimes(3);
            expect(mockAxiosClient.get).toHaveBeenCalledWith(
                expect.stringContaining("offset=0"),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
            expect(mockAxiosClient.get).toHaveBeenCalledWith(
                expect.stringContaining("offset=100"),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
            expect(mockAxiosClient.get).toHaveBeenCalledWith(
                expect.stringContaining("offset=200"),
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            );
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                   UTXO Transaction Conversion                         */
    /* ---------------------------------------------------------------------- */

    describe("UTXO transaction conversion (BTC / DOGE)", () => {
        it("should parse vin into inputs with address and BigInt value in satoshis", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(utxoTransactionResponse());

            const tx = await service.getTransaction("txhash123");

            expect(tx).not.toBeNull();
            /* Input: addr1 with value 0.0005 BTC = 50000 satoshis */
            expect(tx!.inputs).toEqual([["addr1", BigInt(50000)]]);
        });

        it("should parse vout into outputs with address and BigInt value in satoshis", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(utxoTransactionResponse());

            const tx = await service.getTransaction("txhash123");

            expect(tx).not.toBeNull();
            /* Output: addr2 with value 0.0004 BTC = 40000 satoshis */
            expect(tx!.outputs).toEqual([["addr2", BigInt(40000)]]);
        });

        it("should handle coinbase transactions with empty input", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(
                utxoTransactionResponse({ transactionType: "coinbase" }),
            );

            const tx = await service.getTransaction("cbtx");

            expect(tx).not.toBeNull();
            /* Coinbase inputs produce a single ["", 0n] entry */
            expect(tx!.inputs).toEqual([["", BigInt(0)]]);
        });

        it("should handle missing vin with default empty input", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "txempty",
                        transactionType: "regular",
                        paymentReference: "0xref",
                        response: {
                            vin: [],
                            vout: [{ scriptPubKey: { address: "addr2" }, value: 0.000001 }],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("txempty");

            expect(tx).not.toBeNull();
            /* Empty vin array should produce [["", 0n]] */
            expect(tx!.inputs).toEqual([["", BigInt(0)]]);
        });

        it("should handle missing vout with default empty output", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "txempty",
                        transactionType: "regular",
                        paymentReference: "0xref",
                        response: {
                            vin: [{ prevout: { scriptPubKey: { address: "a" }, value: 0.00000001 } }],
                            vout: [],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("txempty");

            expect(tx).not.toBeNull();
            /* Empty vout array should produce [["", 0n]] */
            expect(tx!.outputs).toEqual([["", BigInt(0)]]);
        });

        it("should handle multiple vin and vout entries", async () => {
            const service = createService(ChainId.testDOGE);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "txmulti",
                        transactionType: "regular",
                        paymentReference: "0xref",
                        response: {
                            vin: [
                                { prevout: { scriptPubKey: { address: "a1" }, value: 0.000001 } },
                                { prevout: { scriptPubKey: { address: "a2" }, value: 0.000002 } },
                            ],
                            vout: [
                                { scriptPubKey: { address: "b1" }, value: 0.0000015 },
                                { scriptPubKey: { address: "b2" }, value: 0.0000012 },
                                { scriptPubKey: { address: "b3" }, value: 0.0000003 },
                            ],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("txmulti");

            expect(tx).not.toBeNull();
            expect(tx!.inputs).toEqual([
                ["a1", BigInt(100)],
                ["a2", BigInt(200)],
            ]);
            expect(tx!.outputs).toEqual([
                ["b1", BigInt(150)],
                ["b2", BigInt(120)],
                ["b3", BigInt(30)],
            ]);
        });

        it("should use ZERO_BYTES32 when paymentReference is absent", async () => {
            const service = createService(ChainId.testBTC);
            const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "txnoref",
                        transactionType: "regular",
                        response: {
                            vin: [{ prevout: { scriptPubKey: { address: "a" }, value: 0.00000001 } }],
                            vout: [{ scriptPubKey: { address: "b" }, value: 0.00000001 }],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("txnoref");

            expect(tx).not.toBeNull();
            expect(tx!.reference).toBe(ZERO_BYTES32);
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                   toBnValue (satoshi conversion)                       */
    /* ---------------------------------------------------------------------- */

    describe("toBnValue (UTXO satoshi conversion)", () => {
        it("should convert floating-point BTC values to satoshis correctly", async () => {
            const service = createService(ChainId.testBTC);

            /* 1.5 BTC should become 150000000 satoshis */
            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "txfloat",
                        transactionType: "regular",
                        paymentReference: "0xref",
                        response: {
                            vin: [{ prevout: { scriptPubKey: { address: "a" }, value: 1.5 } }],
                            vout: [{ scriptPubKey: { address: "b" }, value: 0.12345678 }],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("txfloat");

            expect(tx).not.toBeNull();
            expect(tx!.inputs).toEqual([["a", BigInt(150000000)]]);
            /* 0.12345678 * 1e8 = 12345678 satoshis */
            expect(tx!.outputs).toEqual([["b", BigInt(12345678)]]);
        });

        it("should handle very small BTC values without precision loss", async () => {
            const service = createService(ChainId.testBTC);

            /* 0.00000001 BTC = 1 satoshi (the smallest unit) */
            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "txsmall",
                        transactionType: "regular",
                        paymentReference: "0xref",
                        response: {
                            vin: [{ prevout: { scriptPubKey: { address: "a" }, value: 0.00000001 } }],
                            vout: [{ scriptPubKey: { address: "b" }, value: 0.00000001 }],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("txsmall");

            expect(tx).not.toBeNull();
            expect(tx!.inputs).toEqual([["a", BigInt(1)]]);
            expect(tx!.outputs).toEqual([["b", BigInt(1)]]);
        });

        it("should handle zero values", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "txzero",
                        transactionType: "regular",
                        paymentReference: "0xref",
                        response: {
                            vin: [{ prevout: { scriptPubKey: { address: "a" }, value: 0 } }],
                            vout: [{ scriptPubKey: { address: "b" }, value: 0 }],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("txzero");

            expect(tx).not.toBeNull();
            expect(tx!.inputs).toEqual([["a", BigInt(0)]]);
            expect(tx!.outputs).toEqual([["b", BigInt(0)]]);
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                    XRP Transaction Conversion                          */
    /* ---------------------------------------------------------------------- */

    describe("XRP transaction conversion", () => {
        it("should compute inputs as Account amount + Fee for native payments", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tesSUCCESS"));

            const tx = await service.getTransaction("TXHASH");

            expect(tx).not.toBeNull();
            /* Input = Amount (1000000) + Fee (12) = 1000012 */
            expect(tx!.inputs).toEqual([["rSender", BigInt(1000012)]]);
        });

        it("should compute outputs as Destination with delivered_amount for successful native payments", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tesSUCCESS"));

            const tx = await service.getTransaction("TXHASH");

            expect(tx).not.toBeNull();
            /* Output = delivered_amount = 1000000 */
            expect(tx!.outputs).toEqual([["rReceiver", BigInt(1000000)]]);
        });

        it("should compute inputs as only Fee for non-native payments", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(
                xrpTransactionResponse("tesSUCCESS", {
                    isNativePayment: false,
                }),
            );

            const tx = await service.getTransaction("TXHASH");

            expect(tx).not.toBeNull();
            /* Non-native input = only Fee (12) */
            expect(tx!.inputs).toEqual([["rSender", BigInt(12)]]);
        });

        it("should return empty output for failed native payments", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tecCLAIM"));

            const tx = await service.getTransaction("TXHASH");

            expect(tx).not.toBeNull();
            /* Failed XRP tx outputs are [["", 0n]] */
            expect(tx!.outputs).toEqual([["", BigInt(0)]]);
        });

        it("should return empty output for non-native successful payments", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(
                xrpTransactionResponse("tesSUCCESS", {
                    isNativePayment: false,
                }),
            );

            const tx = await service.getTransaction("TXHASH");

            expect(tx).not.toBeNull();
            /* Non-native, even if successful, produces empty output */
            expect(tx!.outputs).toEqual([["", BigInt(0)]]);
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                           successStatus                                */
    /* ---------------------------------------------------------------------- */

    describe("successStatus (via getTransaction)", () => {
        /* UTXO chains always return TX_SUCCESS regardless of content */
        it("should always return TX_SUCCESS (1) for UTXO chains", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(utxoTransactionResponse());

            const tx = await service.getTransaction("txhash");
            expect(tx!.status).toBe(1);
        });

        it("should always return TX_SUCCESS (1) for DOGE chain", async () => {
            const service = createService(ChainId.DOGE);

            mockAxiosClient.get.mockResolvedValueOnce(utxoTransactionResponse());

            const tx = await service.getTransaction("txhash");
            expect(tx!.status).toBe(1);
        });

        /* XRP: tesSUCCESS maps to TX_SUCCESS (1) */
        it("should return TX_SUCCESS (1) for XRP tesSUCCESS", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tesSUCCESS"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(1);
        });

        /* XRP: tecDST_TAG_NEEDED maps to TX_BLOCKED (3) */
        it("should return TX_BLOCKED (3) for XRP tecDST_TAG_NEEDED", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tecDST_TAG_NEEDED"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(3);
        });

        /* XRP: tecNO_DST maps to TX_BLOCKED (3) */
        it("should return TX_BLOCKED (3) for XRP tecNO_DST", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tecNO_DST"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(3);
        });

        /* XRP: tecNO_DST_INSUF_XRP maps to TX_BLOCKED (3) */
        it("should return TX_BLOCKED (3) for XRP tecNO_DST_INSUF_XRP", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tecNO_DST_INSUF_XRP"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(3);
        });

        /* XRP: tecNO_PERMISSION maps to TX_BLOCKED (3) */
        it("should return TX_BLOCKED (3) for XRP tecNO_PERMISSION", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tecNO_PERMISSION"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(3);
        });

        /* XRP: other tec* codes map to TX_FAILED (2) */
        it("should return TX_FAILED (2) for XRP tecCLAIM (generic tec)", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tecCLAIM"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(2);
        });

        it("should return TX_FAILED (2) for XRP tecPATH_DRY (generic tec)", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tecPATH_DRY"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(2);
        });

        /* XRP: non-tes, non-tec results map to TX_FAILED (2) */
        it("should return TX_FAILED (2) for XRP tefPAST_SEQ", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("tefPAST_SEQ"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(2);
        });

        it("should return TX_FAILED (2) for XRP temBAD_AMOUNT", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce(xrpTransactionResponse("temBAD_AMOUNT"));

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(2);
        });

        it("should return TX_FAILED (2) when TransactionResult is undefined", async () => {
            const service = createService(ChainId.testXRP);

            /* Create a response with no TransactionResult in meta */
            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "TXHASH",
                        transactionType: "Payment",
                        paymentReference: "0xref",
                        isNativePayment: true,
                        response: {
                            result: {
                                Account: "rSender",
                                Destination: "rReceiver",
                                Amount: "1000000",
                                Fee: "12",
                                meta: {},
                            },
                        },
                    },
                },
            });

            const tx = await service.getTransaction("TXHASH");
            expect(tx!.status).toBe(2);
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                        XRP with metaData field                         */
    /* ---------------------------------------------------------------------- */

    describe("XRP metaData fallback", () => {
        it("should use metaData field when meta is absent", async () => {
            const service = createService(ChainId.testXRP);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "TXMETADATA",
                        transactionType: "Payment",
                        paymentReference: "0xref",
                        isNativePayment: true,
                        response: {
                            result: {
                                Account: "rSender",
                                Destination: "rReceiver",
                                Amount: "2000000",
                                Fee: "10",
                                /* meta absent, metaData present */
                                metaData: {
                                    TransactionResult: "tesSUCCESS",
                                    delivered_amount: "2000000",
                                },
                            },
                        },
                    },
                },
            });

            const tx = await service.getTransaction("TXMETADATA");

            expect(tx).not.toBeNull();
            expect(tx!.status).toBe(1);
            expect(tx!.outputs).toEqual([["rReceiver", BigInt(2000000)]]);
        });
    });

    /* ---------------------------------------------------------------------- */
    /*                        Reference prefix0x handling                     */
    /* ---------------------------------------------------------------------- */

    describe("payment reference normalization", () => {
        it("should prefix paymentReference with 0x if not already present", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce({
                data: {
                    status: "OK",
                    data: {
                        transactionId: "tx1",
                        transactionType: "regular",
                        paymentReference: "abcdef",
                        response: {
                            vin: [{ prevout: { scriptPubKey: { address: "a" }, value: 0.00000001 } }],
                            vout: [{ scriptPubKey: { address: "b" }, value: 0.00000001 }],
                        },
                    },
                },
            });

            const tx = await service.getTransaction("tx1");

            expect(tx).not.toBeNull();
            expect(tx!.reference).toBe("0xabcdef");
        });

        it("should not double-prefix paymentReference already starting with 0x", async () => {
            const service = createService(ChainId.testBTC);

            mockAxiosClient.get.mockResolvedValueOnce(
                utxoTransactionResponse({ paymentReference: "0xalready" }),
            );

            const tx = await service.getTransaction("tx1");

            expect(tx).not.toBeNull();
            expect(tx!.reference).toBe("0xalready");
        });
    });
});
