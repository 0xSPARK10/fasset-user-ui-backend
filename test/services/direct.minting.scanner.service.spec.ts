import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { DirectMinting } from "../../src/entities/DirectMinting";
import { DirectMintingRecoveryPayment } from "../../src/entities/DirectMintingRecoveryPayment";
import { DirectMintingScannerService } from "../../src/services/direct.minting.scanner.service";
import { SmartAccountsService } from "../../src/services/smart.accounts.service";
import { logger } from "../../src/logger/winston.logger";

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

const mockSmartAccountsClient = (axios.create as jest.Mock)() as { get: jest.Mock };

describe("DirectMintingScannerService MBE-02 candidates", () => {
    const fasset = "FTestXRP";
    const coreVaultAddress = "rCoreVault";
    const discoveryTimestamp = 1_725_000_000_000;

    let em: any;
    let verifier: any;
    let assetManager: any;
    let contractService: any;
    let configValues: Record<string, string>;
    let ormEm: any;
    let service: DirectMintingScannerService;

    const attemptEm = () => ({
        count: jest.fn().mockResolvedValue(0),
        persistAndFlush: jest.fn().mockResolvedValue(undefined),
    });

    const candidateTransaction = (overrides: Record<string, any> = {}) => ({
        transactionId: "A".repeat(64),
        sourceAddress: "rUser",
        destinationAddress: coreVaultAddress,
        amount: "10000000",
        destinationTag: null,
        decodedMemo: {
            type: "SMART_ACCOUNT",
            walletId: 1,
            executorFeeUBA: 750000n,
            userOpHash: `0x${"ab".repeat(32)}`,
        },
        status: "SUCCESS",
        ...overrides,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(Date, "now").mockReturnValue(discoveryTimestamp);

        em = {
            findOne: jest.fn().mockResolvedValue({ name: `directMintingLastXrpBlock_${fasset}`, lastBlock: 100 }),
            count: jest.fn().mockResolvedValue(0),
            persistAndFlush: jest.fn().mockResolvedValue(undefined),
            upsert: jest.fn().mockResolvedValue(undefined),
        };
        verifier = {
            getLastFinalizedBlockNumber: jest.fn().mockResolvedValue(101),
            getTransactionsByBlockRange: jest.fn().mockResolvedValue([candidateTransaction()]),
        };
        assetManager = {
            getDirectMintingFeeBIPS: jest.fn().mockResolvedValue(100n),
            getDirectMintingMinimumFeeUBA: jest.fn().mockResolvedValue(50000n),
            getDirectMintingExecutorFeeUBA: jest.fn().mockResolvedValue(100000n),
        };
        contractService = {
            getMintingTagManagerContract: jest.fn(),
        };
        configValues = { NETWORK: "coston2", APP_TYPE: "dev", SMART_ACCOUNTS_API_URL: "https://smart-accounts.example" };
        const configService = { get: jest.fn((key: string) => configValues[key]) } as unknown as ConfigService;
        mockSmartAccountsClient.get.mockResolvedValue({
            data: { type: "BRIDGE", status: "created", action: { destination_eid: 30101, destination_kind: "ETHEREUM" } },
        });
        ormEm = { fork: jest.fn().mockReturnValue(em) };

        service = new DirectMintingScannerService(
            { em: ormEm } as any,
            { getVerifier: jest.fn().mockReturnValue(verifier) } as any,
            contractService,
            {} as any,
            configService,
            new SmartAccountsService(configService)
        );
        (service as any).em = em;
        (service as any).paymentAddresses.set(fasset, coreVaultAddress);
        (service as any).assetManagerMap.set(fasset, assetManager);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("0xE0 recovery payments", () => {
        /** Models a recovery payment independently of the original bridge's gross amount. */
        const recoveryTransaction = (overrides: Record<string, any> = {}) => candidateTransaction({
            transactionId: `0X${"B".repeat(64)}`,
            amount: "50000",
            decodedMemo: {
                type: "RECOVERY",
                walletId: 1,
                executorFeeUBA: 0n,
                originalTxHash: `0X${"A".repeat(64)}`,
            },
            ...overrides,
        });

        it("records the original target separately and gives recovery precedence over a destination tag", async () => {
            verifier.getTransactionsByBlockRange.mockResolvedValueOnce([recoveryTransaction({ destinationTag: "123" })]);

            await (service as any).scanForFasset(fasset);

            expect(em.upsert).toHaveBeenCalledWith(
                DirectMintingRecoveryPayment,
                expect.objectContaining({
                    txhash: `0x${"b".repeat(64)}`,
                    originalTxHash: `0x${"a".repeat(64)}`,
                    userAddress: "rUser",
                    fasset,
                    timestamp: discoveryTimestamp,
                    processed: false,
                }),
                { onConflictFields: ["fasset", "txhash"], onConflictAction: "ignore" }
            );
            expect(em.count).not.toHaveBeenCalled();
            expect(em.persistAndFlush).toHaveBeenCalledTimes(1);
            expect(em.persistAndFlush).toHaveBeenCalledWith(expect.objectContaining({ lastBlock: 102 }));
            expect(contractService.getMintingTagManagerContract).not.toHaveBeenCalled();
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
        });

        it.each([
            { status: "FAILED" },
            { destinationAddress: "rOtherVault" },
        ])("ignores a recovery payment that fails the existing payment filters (%p)", async (overrides) => {
            verifier.getTransactionsByBlockRange.mockResolvedValueOnce([recoveryTransaction(overrides)]);

            await (service as any).scanForFasset(fasset);

            expect(em.upsert).not.toHaveBeenCalled();
            expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
        });

        it.each([
            { NETWORK: "songbird" },
            { APP_TYPE: "prod" },
        ])("does not capture recovery payments outside the configured OFT source (%p)", async (config) => {
            Object.assign(configValues, config);
            verifier.getTransactionsByBlockRange.mockResolvedValueOnce([recoveryTransaction()]);

            await (service as any).scanForFasset(fasset);

            expect(em.upsert).not.toHaveBeenCalled();
        });

        it("retries the same block range after a failed recovery insert", async () => {
            const state = { name: `directMintingLastXrpBlock_${fasset}`, lastBlock: 100 };
            em.findOne.mockResolvedValue(state);
            verifier.getTransactionsByBlockRange.mockResolvedValue([recoveryTransaction()]);
            em.upsert.mockRejectedValueOnce(new Error("recovery write failed"));

            await expect((service as any).scanForFasset(fasset)).rejects.toThrow("recovery write failed");

            expect(state.lastBlock).toBe(100);
            expect(em.persistAndFlush).not.toHaveBeenCalled();

            await (service as any).scanForFasset(fasset);

            expect(verifier.getTransactionsByBlockRange.mock.calls).toEqual([[100, 101], [100, 101]]);
            expect(em.upsert).toHaveBeenCalledTimes(2);
            expect(state.lastBlock).toBe(102);
        });

        it("uses conflict-ignore on a replay without overwriting a previously processed recovery", async () => {
            const state = { name: `directMintingLastXrpBlock_${fasset}`, lastBlock: 100 };
            em.findOne.mockResolvedValue(state);
            verifier.getTransactionsByBlockRange.mockResolvedValue([recoveryTransaction()]);
            const processed = { processed: true, timestamp: discoveryTimestamp - 1000 };
            em.upsert.mockResolvedValue(processed);

            await (service as any).scanForFasset(fasset);
            state.lastBlock = 100;
            await (service as any).scanForFasset(fasset);

            expect(em.upsert).toHaveBeenCalledTimes(2);
            expect(em.upsert.mock.calls.every(([, , options]: any[]) => options.onConflictAction === "ignore")).toBe(true);
            expect(processed).toEqual({ processed: true, timestamp: discoveryTimestamp - 1000 });
        });
    });

    it("persists a configured 0xFE source as an estimated candidate", async () => {
        verifier.getTransactionsByBlockRange.mockResolvedValueOnce([candidateTransaction({ destinationTag: "123" })]);

        await (service as any).scanForFasset(fasset);

        expect(em.count).toHaveBeenCalledWith(DirectMinting, {
            fasset,
            txhash: `0x${"a".repeat(64)}`,
        });
        const candidate = em.persistAndFlush.mock.calls[0][0] as DirectMinting;
        expect(candidate).toBeInstanceOf(DirectMinting);
        expect(candidate).toMatchObject({
            mintType: "oft_candidate",
            targetAddress: null,
            tagId: "123",
            timestamp: discoveryTimestamp,
            mintingFeeUBA: "100000",
            executorFeeUBA: "750000",
            destinationEid: 30101,
            destinationKind: "ETHEREUM",
            smartStatusLastCheckedAt: discoveryTimestamp,
        });
        expect(mockSmartAccountsClient.get).toHaveBeenCalledWith(`/api/v3/direct_mint/shortStatus/0x${"A".repeat(64)}`);
        expect(contractService.getMintingTagManagerContract).not.toHaveBeenCalled();
    });

    it("fetches destination metadata before the first candidate insert without applying remote status", async () => {
        mockSmartAccountsClient.get.mockImplementationOnce(async () => {
            expect(em.persistAndFlush).not.toHaveBeenCalled();
            return { data: { type: "BRIDGE", status: "awaiting_recovery", action: { destination_eid: 30110, destination_kind: "HYPER_EVM" } } };
        });

        await (service as any).scanForFasset(fasset);

        expect(em.persistAndFlush.mock.calls[0][0]).toMatchObject({
            destinationEid: 30110,
            destinationKind: "HYPER_EVM",
            status: "INPROGRESS",
            processed: false,
        });
    });

    it.each([
        ["404", { isAxiosError: true, response: { status: 404 } }],
        ["500", { isAxiosError: true, response: { status: 500 } }],
        ["timeout", { isAxiosError: true, code: "ECONNABORTED" }],
    ])("still persists a tagged candidate without a fallback after a %s status failure", async (_description, error) => {
        verifier.getTransactionsByBlockRange.mockResolvedValueOnce([candidateTransaction({ destinationTag: "123" })]);
        mockSmartAccountsClient.get.mockRejectedValueOnce(error);

        await (service as any).scanForFasset(fasset);

        expect(em.persistAndFlush.mock.calls[0][0]).toMatchObject({
            mintType: "oft_candidate",
            destinationEid: null,
            destinationKind: null,
            smartStatusLastCheckedAt: discoveryTimestamp,
        });
        expect(mockSmartAccountsClient.get).toHaveBeenCalledTimes(1);
        expect(contractService.getMintingTagManagerContract).not.toHaveBeenCalled();
        expect(em.persistAndFlush).toHaveBeenLastCalledWith(expect.objectContaining({ lastBlock: 102 }));
    });

    it.each([
        null,
        "malformed",
        { type: "BRIDGE", status: "created" },
        { type: "BRIDGE", status: "created", action: null },
        { type: "CUSTOM", status: "created", action: null },
        { type: "BRIDGE", action: { destination_eid: "30101" } },
        { type: "BRIDGE", action: { destination_eid: 30101.5 } },
        { type: "BRIDGE", action: { destination_eid: 0 } },
        { type: "BRIDGE", action: { destination_eid: -1 } },
        { type: "CUSTOM", action: { destination_eid: 30101, destination_kind: "ETHEREUM" } },
    ])("persists a candidate when status has no usable destination (%p)", async (data) => {
        mockSmartAccountsClient.get.mockResolvedValueOnce({ data });

        await (service as any).scanForFasset(fasset);

        expect(em.persistAndFlush.mock.calls[0][0]).toMatchObject({
            mintType: "oft_candidate",
            destinationEid: null,
            destinationKind: null,
            smartStatusLastCheckedAt: discoveryTimestamp,
        });
    });

    it.each([undefined, null, "", " ", 30101, {}])("saves a valid EID independently of a missing or malformed destination kind (%p)", async (kind) => {
        mockSmartAccountsClient.get.mockResolvedValueOnce({
            data: { type: "BRIDGE", status: "created", action: { destination_eid: 30101, destination_kind: kind } },
        });

        await (service as any).scanForFasset(fasset);

        expect(em.persistAndFlush.mock.calls[0][0]).toMatchObject({
            destinationEid: 30101,
            destinationKind: null,
        });
    });

    it.each(["ETHEREUM", "HYPER_EVM", "HYPER_CORE", "BASE", "BSC", "KATANA", "MONAD"])(
        "saves the API destination kind independently of a malformed EID (%s)",
        async (kind) => {
            mockSmartAccountsClient.get.mockResolvedValueOnce({
                data: { type: "BRIDGE", status: "created", action: { destination_eid: "invalid", destination_kind: kind } },
            });

            await (service as any).scanForFasset(fasset);

            expect(em.persistAndFlush.mock.calls[0][0]).toMatchObject({
                destinationEid: null,
                destinationKind: kind,
            });
        }
    );

    it("does not create an OFT candidate on an unsupported network", async () => {
        configValues.NETWORK = "songbird";

        await (service as any).scanForFasset(fasset);

        const storedDirectMintings = em.persistAndFlush.mock.calls
            .map(([entity]: [unknown]) => entity)
            .filter((entity: unknown) => entity instanceof DirectMinting);
        expect(storedDirectMintings).toHaveLength(0);
        expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
    });

    it("does not create an OFT candidate for the wrong configured fasset", async () => {
        const otherFasset = "FXRP";
        (service as any).paymentAddresses.set(otherFasset, coreVaultAddress);
        (service as any).assetManagerMap.set(otherFasset, assetManager);

        await (service as any).scanForFasset(otherFasset);

        const storedDirectMintings = em.persistAndFlush.mock.calls
            .map(([entity]: [unknown]) => entity)
            .filter((entity: unknown) => entity instanceof DirectMinting);
        expect(storedDirectMintings).toHaveLength(0);
        expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
    });

    it("keeps persisting legacy direct mintings outside the OFT candidate flow", async () => {
        configValues.NETWORK = "songbird";
        verifier.getTransactionsByBlockRange.mockResolvedValueOnce([
            candidateTransaction({
                decodedMemo: {
                    type: "DIRECT_MINTING",
                    recipient: "0x1111111111111111111111111111111111111111",
                },
            }),
        ]);

        await (service as any).scanForFasset(fasset);

        const directMinting = em.persistAndFlush.mock.calls[0][0] as DirectMinting;
        expect(directMinting).toMatchObject({
            mintType: "address",
            targetAddress: "0x1111111111111111111111111111111111111111",
            executorFeeUBA: "100000",
        });
        expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
    });

    it("skips an existing composite identity without overwriting it", async () => {
        em.count.mockResolvedValueOnce(1);

        await (service as any).scanForFasset(fasset);

        expect(em.count).toHaveBeenCalledWith(DirectMinting, {
            fasset,
            txhash: `0x${"a".repeat(64)}`,
        });
        const storedDirectMintings = em.persistAndFlush.mock.calls
            .map(([entity]: [unknown]) => entity)
            .filter((entity: unknown) => entity instanceof DirectMinting);
        expect(storedDirectMintings).toHaveLength(0);
        expect(mockSmartAccountsClient.get).not.toHaveBeenCalled();
    });

    it("falls back a failed tagged candidate and continues processing later transactions", async () => {
        const state = { name: `directMintingLastXrpBlock_${fasset}`, lastBlock: 100 };
        em.findOne.mockResolvedValueOnce(state);
        const candidateEm = attemptEm();
        candidateEm.persistAndFlush.mockRejectedValueOnce(new Error("candidate write failed"));
        const fallbackEm = attemptEm();
        ormEm.fork.mockReturnValueOnce(candidateEm).mockReturnValueOnce(fallbackEm);
        const tagRecipient = "0x2222222222222222222222222222222222222222";
        contractService.getMintingTagManagerContract.mockReturnValue({
            mintingRecipient: jest.fn().mockResolvedValue(tagRecipient),
        });
        verifier.getTransactionsByBlockRange.mockResolvedValueOnce([
            candidateTransaction({ destinationTag: "123" }),
            candidateTransaction({
                transactionId: "B".repeat(64),
                decodedMemo: {
                    type: "DIRECT_MINTING",
                    recipient: "0x1111111111111111111111111111111111111111",
                },
            }),
        ]);

        await (service as any).scanForFasset(fasset);

        const fallback = fallbackEm.persistAndFlush.mock.calls[0][0] as DirectMinting;
        expect(fallback).toMatchObject({
            mintType: "tag",
            tagId: "123",
            targetAddress: tagRecipient,
            executorFeeUBA: "100000",
        });
        const laterDirectMint = em.persistAndFlush.mock.calls
            .map(([entity]: [unknown]) => entity)
            .find((entity: unknown) => entity instanceof DirectMinting) as DirectMinting;
        expect(laterDirectMint).toMatchObject({
            txhash: `0x${"b".repeat(64)}`,
            mintType: "address",
        });
        expect(state.lastBlock).toBe(102);
    });

    it("drops a failed tagless candidate and advances the cursor", async () => {
        const state = { name: `directMintingLastXrpBlock_${fasset}`, lastBlock: 100 };
        em.findOne.mockResolvedValueOnce(state);
        const candidateEm = attemptEm();
        candidateEm.persistAndFlush.mockRejectedValueOnce(new Error("candidate write failed"));
        ormEm.fork.mockReturnValueOnce(candidateEm);

        await (service as any).scanForFasset(fasset);

        expect(state.lastBlock).toBe(102);
        expect(em.persistAndFlush).toHaveBeenCalledWith(state);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Dropping tagless OFT candidate"));
    });

    it("drops a tagged candidate when its legacy fallback also fails", async () => {
        const state = { name: `directMintingLastXrpBlock_${fasset}`, lastBlock: 100 };
        em.findOne.mockResolvedValueOnce(state);
        verifier.getTransactionsByBlockRange.mockResolvedValueOnce([candidateTransaction({ destinationTag: "123" })]);
        const candidateEm = attemptEm();
        candidateEm.persistAndFlush.mockRejectedValueOnce(new Error("candidate write failed"));
        const fallbackEm = attemptEm();
        fallbackEm.persistAndFlush.mockRejectedValueOnce(new Error("fallback write failed"));
        ormEm.fork.mockReturnValueOnce(candidateEm).mockReturnValueOnce(fallbackEm);

        await (service as any).scanForFasset(fasset);

        expect(state.lastBlock).toBe(102);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("legacy tag fallback failed"), expect.any(Error));
    });

    it("does not create a fallback when the failed candidate insert actually committed", async () => {
        const state = { name: `directMintingLastXrpBlock_${fasset}`, lastBlock: 100 };
        em.findOne.mockResolvedValueOnce(state);
        verifier.getTransactionsByBlockRange.mockResolvedValueOnce([candidateTransaction({ destinationTag: "123" })]);
        const candidateEm = attemptEm();
        candidateEm.persistAndFlush.mockRejectedValueOnce(new Error("ambiguous commit result"));
        const fallbackEm = attemptEm();
        fallbackEm.count.mockResolvedValueOnce(1);
        ormEm.fork.mockReturnValueOnce(candidateEm).mockReturnValueOnce(fallbackEm);

        await (service as any).scanForFasset(fasset);

        expect(fallbackEm.persistAndFlush).not.toHaveBeenCalled();
        expect(state.lastBlock).toBe(102);
    });
});
