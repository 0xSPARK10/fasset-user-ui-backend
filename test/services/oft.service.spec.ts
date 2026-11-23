import { OFTService } from "../../src/oft/oft.service";
import { OFTSent } from "../../src/entities/OFTSent";
import { OFTReceived } from "../../src/entities/OFTReceived";
import { OFTRedemption } from "../../src/entities/OFTRedemption";
import { OFTRedemptionFailed } from "../../src/entities/OFTRedemptionFailed";
import { OFTComposerFeeCollected } from "../../src/entities/OFTComposerFeeCollected";
import { IncompleteRedemption } from "../../src/entities/RedemptionIncomplete";
import { RedemptionAmountIncompleteEvent } from "../../src/entities/RedemptionAmountIncompleteEvent";
import { RedemptionDefault } from "../../src/entities/RedemptionDefault";
import { RedemptionDefaultEvent } from "../../src/entities/RedemptionDefaultEvent";
import { Collateral } from "../../src/entities/Collaterals";
import { Pool } from "../../src/entities/Pool";
import { DirectMinting, DirectMintingStatus } from "../../src/entities/DirectMinting";
import { DirectMintingExecutedEvent } from "../../src/entities/DirectMintingExecutedEvent";
import { DirectMintingExecutedToSmartAccountEvent } from "../../src/entities/DirectMintingExecutedToSmartAccountEvent";
import { IndexerState } from "../../src/entities/IndexerState";
import { OFT_FIRST_TRUSTED_BLOCK_STATE, OFT_LAST_BLOCK_STATE } from "../../src/oft/oft.event.reader.service";
import { logger } from "../../src/logger/winston.logger";

jest.mock("src/logger/winston.logger", () => ({
    logger: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

describe("OFTService", () => {
    let service: OFTService;
    let find: jest.Mock;
    let configGet: jest.Mock;
    let responses: Map<unknown, unknown[]>;

    const xrplHash = (character: string): string => `0x${character.repeat(64)}`;

    const candidate = (overrides: Partial<DirectMinting> = {}): DirectMinting =>
        ({
            id: 1,
            txhash: xrplHash("a"),
            userAddress: "rExactXrpAddress",
            targetAddress: null,
            mintType: "oft_candidate",
            tagId: null,
            amount: "10000000",
            mintingFeeUBA: "100000",
            executorFeeUBA: "200000",
            mintedAmountUBA: null,
            status: DirectMintingStatus.INPROGRESS,
            delayTimestamp: null,
            timestamp: 1_726_125_839_877,
            smartStatusLastCheckedAt: null,
            destinationEid: null,
            destinationKind: null,
            fasset: "FTestXRP",
            processed: false,
            evm_txhash: null,
            ...overrides,
        }) as DirectMinting;

    const smartExecution = (transactionId: string, txhash: string | undefined, blockNumber: number | null, id = 1): DirectMintingExecutedToSmartAccountEvent =>
        ({
            id,
            transactionId,
            txhash,
            blockNumber,
            fasset: "FTestXRP",
        }) as DirectMintingExecutedToSmartAccountEvent;

    const ordinaryExecution = (transactionId: string, txhash: string | undefined, blockNumber: number | null, id = 1): DirectMintingExecutedEvent =>
        ({
            id,
            transactionId,
            txhash,
            blockNumber,
            fasset: "FTestXRP",
        }) as DirectMintingExecutedEvent;

    const sent = (id: number, txhash: string, guid: string, overrides: Partial<OFTSent> = {}): OFTSent =>
        ({
            id,
            guid,
            dstEid: 30101,
            fromAddress: "0xConnectedEvmAddress",
            amountSentLD: "10000000",
            amountReceivedLD: "9900000",
            toHypercore: false,
            fasset: "FTestXRP",
            timestamp: 1_726_125_840_000,
            txhash,
            ...overrides,
        }) as OFTSent;

    const redemption = {
        agentVault: "0xAgentVault",
        redeemer: "0xRedeemer",
        requestId: "1",
        paymentAddress: "rPaymentAddress",
        valueUBA: "1000000",
        feeUBA: "10000",
        systemRedemptionFeeUBA: "0",
        paymentReference: "0xPaymentReference",
        timestamp: Date.now(),
        txhash: "0xRedemptionHash",
        fasset: "FTestXRP",
        guid: "0xGuid",
        personalRedeemerAddress: "0xPersonalRedeemer",
        srcEid: 101,
        defaulted: true,
        blocked: false,
        processed: true,
    };

    beforeEach(() => {
        responses = new Map<unknown, unknown[]>([
            [OFTSent, []],
            [OFTReceived, []],
            [OFTRedemption, [redemption]],
            [OFTRedemptionFailed, []],
            [OFTComposerFeeCollected, []],
            [IncompleteRedemption, []],
            [RedemptionAmountIncompleteEvent, []],
            [
                RedemptionDefaultEvent,
                [
                    {
                        agentVault: "0xAgentVault",
                        requestId: "1",
                        redeemedVaultCollateralWei: "1500000",
                        redeemedPoolCollateralWei: "2000000000000000000",
                    },
                ],
            ],
            [Collateral, [{ tokenFtsoSymbol: "USDT", decimals: 6 }]],
            [Pool, [{ vaultAddress: "0xAgentVault", vaultCollateralToken: "USDT" }]],
            [DirectMinting, []],
            [DirectMintingExecutedEvent, []],
            [DirectMintingExecutedToSmartAccountEvent, []],
            [IndexerState, []],
        ]);
        find = jest.fn().mockImplementation((entity) => Promise.resolve(responses.get(entity) ?? []));
        configGet = jest.fn().mockImplementation((key: string) => (key === "APP_TYPE" ? "dev" : undefined));
        service = new OFTService({ find } as any, {} as any, { get: configGet } as any);
        (logger.error as jest.Mock).mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should build default collateral data from RedemptionDefaultEvent", async () => {
        const history = await service.getOFTHistory("0xRedeemer");

        expect(find).toHaveBeenCalledWith(RedemptionDefaultEvent, { requestId: { $in: ["1"] } });
        expect(find).toHaveBeenCalledWith(Pool, { vaultAddress: { $in: ["0xAgentVault"] } });
        expect(find.mock.calls.some(([entity]) => entity === RedemptionDefault)).toBe(false);
        expect(history).toHaveLength(1);
        expect(history[0]).toEqual(
            expect.objectContaining({
                action: "REDEEM",
                guid: redemption.guid,
                defaulted: true,
                underlyingPaid: "0",
                vaultToken: "USDT0",
                vaultTokenValueRedeemed: "1.5",
                poolTokenValueRedeemed: "2",
            })
        );
    });

    it("should preserve zero collateral fallbacks when pool metadata is unavailable", async () => {
        responses.set(Pool, []);

        const history = await service.getOFTHistory("0xRedeemer");

        expect(history[0]).toEqual(
            expect.objectContaining({
                underlyingPaid: "0",
                vaultToken: "USDT0",
                vaultTokenValueRedeemed: "0",
                poolTokenValueRedeemed: "0",
            })
        );
    });

    describe("short history", () => {
        it("retains bridge and redemption details in timestamp order, including tickets sharing a GUID", async () => {
            const now = redemption.timestamp;
            responses.set(OFTSent, [sent(1, "0xSendHash", "0xSendGuid", { timestamp: now })]);
            responses.set(OFTReceived, [new OFTReceived("0xReceiveGuid", 30101, "0xConnectedEvmAddress", "1000000", "FTestXRP", now, "0xReceiveHash")]);
            responses.set(OFTRedemption, [
                { ...redemption, timestamp: now - 3000, defaulted: false, processed: false },
                { ...redemption, requestId: "2", timestamp: now - 3000, defaulted: false, processed: false },
            ]);
            responses.set(OFTRedemptionFailed, [
                new OFTRedemptionFailed(
                    "0xConnectedEvmAddress",
                    "1000000",
                    now - 2000,
                    "0xFailedHash",
                    "FTestXRP",
                    "0xFailedGuid",
                    "0xPersonalRedeemer",
                    30101
                ),
            ]);
            responses.set(DirectMinting, [candidate({ timestamp: now - 1000 })]);

            const history = await service.getOFTShortHistory("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(history.map((row) => row.action)).toEqual(["DIRECT_MINT_BRIDGE", "REDEEMFAIL", "REDEEM", "REDEEM"]);
            expect(history.map((row) => row.timestamp)).toEqual([now - 1000, now - 2000, now - 3000, now - 3000]);
            expect(history[0]).toEqual(expect.objectContaining({ amount: "9.70", amountEstimated: true, status: false, oftSent: null }));
            expect(history[1]).toEqual(expect.objectContaining({ guid: "0xFailedGuid", txhash: "0xFailedHash", amount: "1.00" }));
            expect(history.slice(2)).toEqual([
                expect.objectContaining({ ticketID: "1", guid: redemption.guid, status: false, underlyingPaid: "0.99" }),
                expect.objectContaining({ ticketID: "2", guid: redemption.guid, status: false, underlyingPaid: "0.99" }),
            ]);

            const fullHistory = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(fullHistory.map((row) => row.action)).toEqual(expect.arrayContaining(["SEND", "RECEIVE", "REDEEM", "REDEEMFAIL", "DIRECT_MINT_BRIDGE"]));
            expect(fullHistory.find((row) => row.action === "REDEEMFAIL").guid).toBe("0xFailedGuid");
        });

        it("preserves the matched OFTSent details on an executed direct-mint bridge", async () => {
            const evmTxHash = `0x${"c".repeat(64)}`;
            const directMint = candidate({
                status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT,
                processed: true,
                evm_txhash: evmTxHash,
                destinationEid: 30110,
                destinationKind: "HYPER_CORE",
            });
            responses.set(OFTRedemption, []);
            responses.set(DirectMinting, [directMint]);
            responses.set(DirectMintingExecutedToSmartAccountEvent, [smartExecution(directMint.txhash, evmTxHash, 100)]);
            responses.set(OFTSent, [sent(1, evmTxHash, "0xBridgeGuid", { toHypercore: true })]);

            const history = await service.getOFTShortHistory("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(history).toHaveLength(1);
            expect(history[0]).toEqual(
                expect.objectContaining({
                    action: "DIRECT_MINT_BRIDGE",
                    amount: "10.00",
                    amountEstimated: false,
                    status: true,
                    eid: 30101,
                    destinationKind: "HYPER_CORE",
                    toHypercore: true,
                    oftSent: expect.objectContaining({ guid: "0xBridgeGuid", txhash: evmTxHash }),
                })
            );
        });

        it("returns redemptions without querying bridge candidates when xrpAddress is omitted", async () => {
            const now = 1_800_000_000_000;
            jest.spyOn(Date, "now").mockReturnValue(now);
            responses.set(DirectMinting, [candidate()]);

            const history = await service.getOFTShortHistory("0xRedeemer");

            expect(history).toEqual([expect.objectContaining({ action: "REDEEM", guid: redemption.guid })]);
            expect(find.mock.calls.some(([entity]) => entity === DirectMinting)).toBe(false);
            expect(find).toHaveBeenCalledWith(OFTRedemption, {
                redeemer: "0xRedeemer",
                timestamp: { $gte: now - 7 * 24 * 60 * 60 * 1000 },
            });
        });

        it("returns an empty array when no operations exist", async () => {
            responses.set(OFTRedemption, []);

            await expect(service.getOFTShortHistory("0xConnectedEvmAddress", "rExactXrpAddress")).resolves.toEqual([]);
        });
    });

    describe("direct mint bridge candidates", () => {
        beforeEach(() => {
            responses.set(OFTRedemption, []);
            responses.set(OFTRedemptionFailed, []);
        });

        it.each([
            DirectMintingStatus.INPROGRESS,
            DirectMintingStatus.DELAYED,
            DirectMintingStatus.AWAITING_RECOVERY,
            DirectMintingStatus.RECOVERY_PENDING,
        ])(
            "returns saved destination metadata in both history variants before execution (%s)",
            async (status) => {
                responses.set(DirectMinting, [candidate({ status, destinationEid: 30110, destinationKind: "HYPER_EVM" })]);

                const histories = [
                    await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress"),
                    await service.getOFTShortHistory("0xConnectedEvmAddress", "rExactXrpAddress"),
                ];

                for (const history of histories) {
                    expect(history).toEqual([
                        expect.objectContaining({
                            action: "DIRECT_MINT_BRIDGE",
                            eid: 30110,
                            destinationKind: "HYPER_EVM",
                            status: false,
                            directMintingStatus: status,
                            amountEstimated: true,
                            evmTxHash: null,
                            oftSent: null,
                            toHypercore: null,
                        }),
                    ]);
                }
            }
        );

        it("keeps one full seven-day cutoff and does not query candidates without an XRP address", async () => {
            const now = 1_800_000_000_000;
            jest.spyOn(Date, "now").mockReturnValue(now);
            const cutoff = now - 7 * 24 * 60 * 60 * 1000;

            await service.getOFTHistory("0xConnectedEvmAddress");

            expect(find.mock.calls.some(([entity]) => entity === DirectMinting)).toBe(false);
            expect(find).toHaveBeenCalledWith(OFTSent, {
                fromAddress: "0xConnectedEvmAddress",
                timestamp: { $gte: cutoff },
            });
            expect(find).toHaveBeenCalledWith(OFTReceived, {
                toAddress: "0xConnectedEvmAddress",
                timestamp: { $gte: cutoff },
            });
            expect(find).toHaveBeenCalledWith(OFTRedemption, {
                redeemer: "0xConnectedEvmAddress",
                timestamp: { $gte: cutoff },
            });
            expect(find).toHaveBeenCalledWith(OFTRedemptionFailed, {
                redeemer: "0xConnectedEvmAddress",
                timestamp: { $gte: cutoff },
            });
        });

        it("queries the exact XRP address and exempts both recovery states from the seven-day cutoff", async () => {
            const now = 1_800_000_000_000;
            jest.spyOn(Date, "now").mockReturnValue(now);
            const cutoff = now - 7 * 24 * 60 * 60 * 1000;
            responses.set(DirectMinting, [
                candidate({ id: 1, txhash: xrplHash("a"), status: DirectMintingStatus.INPROGRESS }),
                candidate({ id: 2, txhash: xrplHash("b"), status: DirectMintingStatus.DELAYED, delayTimestamp: 1_800_000_100 }),
                candidate({ id: 3, txhash: xrplHash("c"), status: DirectMintingStatus.AWAITING_RECOVERY }),
                candidate({
                    id: 4,
                    txhash: xrplHash("d"),
                    status: DirectMintingStatus.MINTING_PAYMENT_TOO_SMALL_FOR_FEE,
                    processed: true,
                    evm_txhash: "0xTooSmallEvent",
                }),
            ]);

            const history = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");
            const bridgeRows = history.filter((row) => row.action === "DIRECT_MINT_BRIDGE");

            expect(find).toHaveBeenCalledWith(DirectMinting, {
                userAddress: "rExactXrpAddress",
                fasset: "FTestXRP",
                mintType: "oft_candidate",
                $or: [
                    { timestamp: { $gte: cutoff } },
                    { status: { $in: [DirectMintingStatus.AWAITING_RECOVERY, DirectMintingStatus.RECOVERY_PENDING] } },
                ],
            });
            expect(bridgeRows).toHaveLength(4);
            expect(bridgeRows.map((row) => row.directMintingStatus)).toEqual(
                expect.arrayContaining([
                    DirectMintingStatus.INPROGRESS,
                    DirectMintingStatus.DELAYED,
                    DirectMintingStatus.AWAITING_RECOVERY,
                    DirectMintingStatus.MINTING_PAYMENT_TOO_SMALL_FOR_FEE,
                ])
            );
            expect(bridgeRows).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        action: "DIRECT_MINT_BRIDGE",
                        timestamp: 1_726_125_839_877,
                        amount: "9.70",
                        amountEstimated: true,
                        fasset: "FTestXRP",
                        status: false,
                        directMinting: true,
                        directMintingStatus: DirectMintingStatus.DELAYED,
                        delayTimestamp: 1_800_000_100,
                        txhash: "B".repeat(64),
                        xrplTxHash: "B".repeat(64),
                        evmTxHash: null,
                        eid: null,
                        toHypercore: null,
                        oftSent: null,
                    }),
                    expect.objectContaining({
                        directMintingStatus: DirectMintingStatus.MINTING_PAYMENT_TOO_SMALL_FOR_FEE,
                        status: true,
                        evmTxHash: "0xTooSmallEvent",
                    }),
                ])
            );
            expect(logger.error).not.toHaveBeenCalled();
        });

        it.each(["getOFTHistory", "getOFTShortHistory"] as const)("retains both recovery states beyond seven days in %s", async (method) => {
            const now = 1_800_000_000_000;
            jest.spyOn(Date, "now").mockReturnValue(now);
            const dayMs = 24 * 60 * 60 * 1000;
            const oldest = candidate({ status: DirectMintingStatus.AWAITING_RECOVERY, timestamp: now - 30 * dayMs });
            const older = candidate({ id: 2, txhash: xrplHash("b"), status: DirectMintingStatus.RECOVERY_PENDING, timestamp: now - 8 * dayMs });
            const recent = candidate({ id: 3, txhash: xrplHash("c"), timestamp: now - dayMs });
            responses.set(DirectMinting, [oldest, recent, older]);

            const history = await service[method]("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(find).toHaveBeenCalledWith(DirectMinting, {
                userAddress: "rExactXrpAddress",
                fasset: "FTestXRP",
                mintType: "oft_candidate",
                $or: [
                    { timestamp: { $gte: now - 7 * dayMs } },
                    { status: { $in: [DirectMintingStatus.AWAITING_RECOVERY, DirectMintingStatus.RECOVERY_PENDING] } },
                ],
            });
            expect(history).toEqual([
                expect.objectContaining({ timestamp: recent.timestamp, directMintingStatus: DirectMintingStatus.INPROGRESS }),
                expect.objectContaining({
                    action: "DIRECT_MINT_BRIDGE",
                    timestamp: older.timestamp,
                    directMintingStatus: DirectMintingStatus.RECOVERY_PENDING,
                    amountEstimated: true,
                    status: false,
                    oftSent: null,
                }),
                expect.objectContaining({
                    action: "DIRECT_MINT_BRIDGE",
                    timestamp: oldest.timestamp,
                    directMintingStatus: DirectMintingStatus.AWAITING_RECOVERY,
                    amountEstimated: true,
                    status: false,
                    oftSent: null,
                }),
            ]);
        });

        it.each(["getOFTHistory", "getOFTShortHistory"] as const)("retains recovered mintings without OFTSent after the indexer advances in %s", async (method) => {
            const evmTxHash = `0x${"c".repeat(64)}`;
            const timestamp = Date.now();
            const recovered = candidate({ status: DirectMintingStatus.RECOVERED, processed: true, evm_txhash: evmTxHash, timestamp });
            const executed = candidate({ id: 2, txhash: xrplHash("b"), status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT, processed: true, timestamp });
            responses.set(DirectMinting, [recovered, executed]);
            responses.set(DirectMintingExecutedToSmartAccountEvent, [smartExecution(executed.txhash, `0x${"d".repeat(64)}`, 100)]);
            responses.set(IndexerState, [new IndexerState(OFT_LAST_BLOCK_STATE, 200), new IndexerState(OFT_FIRST_TRUSTED_BLOCK_STATE, 50)]);

            const history = await service[method]("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(history).toEqual([
                expect.objectContaining({
                    action: "DIRECT_MINT_BRIDGE",
                    directMintingStatus: DirectMintingStatus.RECOVERED,
                    status: true,
                    amount: "9.70",
                    amountEstimated: true,
                    timestamp: Number(recovered.timestamp),
                    txhash: "A".repeat(64),
                    evmTxHash,
                    eid: null,
                    destinationKind: null,
                    toHypercore: null,
                    oftSent: null,
                }),
            ]);
            expect(logger.error).not.toHaveBeenCalled();
        });

        it("selects the lowest-id normalized OFTSent and removes only that event from generic SEND history", async () => {
            const evmTxHash = `0x${"Ab".repeat(32)}`;
            const directMint = candidate({
                status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT,
                processed: true,
                evm_txhash: evmTxHash,
            });
            const lowestId = sent(2, evmTxHash.toLowerCase(), "0xLowestGuid", {
                amountSentLD: "1234567",
                amountReceivedLD: "1200000",
                toHypercore: true,
            });
            const otherSend = sent(7, evmTxHash.toLowerCase(), "0xOtherGuid", {
                dstEid: 40200,
                amountSentLD: "2000000",
            });
            responses.set(DirectMinting, [directMint]);
            responses.set(DirectMintingExecutedToSmartAccountEvent, [smartExecution(directMint.txhash.toUpperCase(), evmTxHash, 100)]);
            responses.set(OFTSent, [lowestId, otherSend]);
            find.mockImplementation((entity, where) => {
                if (entity === OFTSent && where?.fasset === "FTestXRP") return Promise.resolve([lowestId, otherSend]);
                return Promise.resolve(responses.get(entity) ?? []);
            });

            const history = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");
            const bridgeRow = history.find((row) => row.action === "DIRECT_MINT_BRIDGE");
            const sendRows = history.filter((row) => row.action === "SEND");
            const matchingFindCall = find.mock.calls.find(([entity, where]) => entity === OFTSent && where?.fasset === "FTestXRP");

            expect(bridgeRow).toEqual(
                expect.objectContaining({
                    amount: "1.23",
                    amountEstimated: false,
                    status: true,
                    directMinting: true,
                    directMintingStatus: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT,
                    delayTimestamp: null,
                    txhash: "A".repeat(64),
                    xrplTxHash: "A".repeat(64),
                    evmTxHash,
                    eid: 30101,
                    toHypercore: true,
                    oftSent: {
                        guid: "0xLowestGuid",
                        dstEid: 30101,
                        fromAddress: "0xConnectedEvmAddress",
                        amountSentLD: "1234567",
                        amountReceivedLD: "1200000",
                        txhash: evmTxHash.toLowerCase(),
                    },
                })
            );
            expect(sendRows).toEqual([expect.objectContaining({ amount: "2.00", eid: 40200 })]);
            expect(matchingFindCall?.[2]).toEqual({ orderBy: { id: "ASC" } });
            expect(Object.values(matchingFindCall?.[1] ?? {})).toContainEqual({ $in: [evmTxHash.toLowerCase()] });
            expect(logger.error).not.toHaveBeenCalled();
        });

        it("retains a no-match execution at the cursor and omits one the cursor has passed", async () => {
            const atCursor = candidate({
                id: 1,
                txhash: xrplHash("a"),
                status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT,
                processed: true,
            });
            const behindCursor = candidate({
                id: 2,
                txhash: xrplHash("b"),
                status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT,
                processed: true,
            });
            responses.set(DirectMinting, [atCursor, behindCursor]);
            responses.set(DirectMintingExecutedToSmartAccountEvent, [
                smartExecution(atCursor.txhash, `0x${"c".repeat(64)}`, 101, 1),
                smartExecution(behindCursor.txhash, `0x${"d".repeat(64)}`, 100, 2),
            ]);
            responses.set(IndexerState, [new IndexerState(OFT_LAST_BLOCK_STATE, 101), new IndexerState(OFT_FIRST_TRUSTED_BLOCK_STATE, 50)]);

            const history = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");
            const bridgeRows = history.filter((row) => row.action === "DIRECT_MINT_BRIDGE");

            expect(bridgeRows).toHaveLength(1);
            expect(bridgeRows[0]).toEqual(
                expect.objectContaining({
                    txhash: "A".repeat(64),
                    xrplTxHash: "A".repeat(64),
                    evmTxHash: `0x${"c".repeat(64)}`,
                    amountEstimated: true,
                    status: true,
                    eid: null,
                    toHypercore: null,
                    oftSent: null,
                })
            );
            expect(logger.error).not.toHaveBeenCalled();
        });

        it("retains and alerts when absence falls outside trusted OFT coverage", async () => {
            const directMint = candidate({ status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT, processed: true });
            responses.set(DirectMinting, [directMint]);
            responses.set(DirectMintingExecutedToSmartAccountEvent, [smartExecution(directMint.txhash, `0x${"e".repeat(64)}`, 40)]);
            responses.set(IndexerState, [new IndexerState(OFT_LAST_BLOCK_STATE, 200), new IndexerState(OFT_FIRST_TRUSTED_BLOCK_STATE, 50)]);

            let history = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(history.filter((row) => row.action === "DIRECT_MINT_BRIDGE")).toHaveLength(1);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"reason":"execution_before_first_trusted_block"'));

            (logger.error as jest.Mock).mockClear();
            responses.set(IndexerState, []);
            history = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(history.filter((row) => row.action === "DIRECT_MINT_BRIDGE")).toHaveLength(1);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"reason":"missing_indexer_state"'));
        });

        it("keeps incomplete executions provisional and alerts without attempting an OFTSent join", async () => {
            const smartCandidate = candidate({
                id: 1,
                txhash: xrplHash("a"),
                status: DirectMintingStatus.EXECUTED_TO_SMART_ACCOUNT,
                processed: true,
            });
            const ordinaryCandidate = candidate({
                id: 2,
                txhash: xrplHash("b"),
                status: DirectMintingStatus.EXECUTED,
                processed: true,
            });
            responses.set(DirectMinting, [smartCandidate, ordinaryCandidate]);
            responses.set(DirectMintingExecutedToSmartAccountEvent, [smartExecution(smartCandidate.txhash, `0x${"f".repeat(64)}`, null)]);

            const history = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");
            const bridgeRows = history.filter((row) => row.action === "DIRECT_MINT_BRIDGE");
            const matchingOftQueries = find.mock.calls.filter(([entity, where]) => entity === OFTSent && where?.fasset === "FTestXRP");

            expect(bridgeRows).toHaveLength(2);
            expect(matchingOftQueries).toHaveLength(0);
            expect(logger.error).toHaveBeenCalledTimes(2);
            for (const [message] of (logger.error as jest.Mock).mock.calls) {
                expect(message).toContain('"code":"OFT_HISTORY_MISSING_EXECUTION_METADATA"');
            }
        });

        it("applies the watermark to ordinary execution without consuming a generic OFTSent", async () => {
            const omitted = candidate({ id: 1, txhash: xrplHash("a"), status: DirectMintingStatus.EXECUTED, processed: true });
            const retained = candidate({ id: 2, txhash: xrplHash("b"), status: DirectMintingStatus.EXECUTED, processed: true });
            const ordinaryTxHash = `0x${"1".repeat(64)}`;
            const genericSend = sent(3, ordinaryTxHash, "0xOrdinaryTxSend");
            responses.set(DirectMinting, [omitted, retained]);
            responses.set(DirectMintingExecutedEvent, [
                ordinaryExecution(omitted.txhash, ordinaryTxHash, 100, 1),
                ordinaryExecution(retained.txhash, `0x${"2".repeat(64)}`, 101, 2),
            ]);
            responses.set(IndexerState, [new IndexerState(OFT_LAST_BLOCK_STATE, 101), new IndexerState(OFT_FIRST_TRUSTED_BLOCK_STATE, 50)]);
            responses.set(OFTSent, [genericSend]);

            const history = await service.getOFTHistory("0xConnectedEvmAddress", "rExactXrpAddress");

            expect(history.filter((row) => row.action === "SEND")).toHaveLength(1);
            expect(history.filter((row) => row.action === "DIRECT_MINT_BRIDGE")).toEqual([expect.objectContaining({ txhash: "B".repeat(64), oftSent: null })]);
            expect(find.mock.calls.filter(([entity, where]) => entity === OFTSent && where?.fasset === "FTestXRP")).toHaveLength(0);
            expect(logger.error).not.toHaveBeenCalled();
        });
    });

    it("adds the system and composer fees to gross redemption history without changing the underlying payment", async () => {
        responses.set(OFTRedemption, [{ ...redemption, defaulted: false, systemRedemptionFeeUBA: "100000" }]);
        responses.set(OFTComposerFeeCollected, [{ guid: redemption.guid, composerFee: "50000" }]);

        const history = await service.getOFTHistory("0xRedeemer");

        expect(history[0]).toEqual(
            expect.objectContaining({
                action: "REDEEM",
                amount: "1.15",
                underlyingPaid: "0.99",
            })
        );
    });
});
