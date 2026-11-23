import { ethers, Interface } from "ethers";
import { IndexerState } from "../../src/entities/IndexerState";
import { OFTSent } from "../../src/entities/OFTSent";
import { OFTRedemption } from "../../src/entities/OFTRedemption";
import {
    OFTEventReaderService,
    OFT_FIRST_TRUSTED_BLOCK_STATE,
    OFT_LAST_BLOCK_STATE,
} from "../../src/oft/oft.event.reader.service";
import {
    AM_REDEMPTION_REQUESTED_EVENT,
    AM_SYSTEM_REDEMPTION_FEE_PAID_EVENT,
    EndpointV2Events,
    FAssetRedeemComposerEvents,
    OFTAdapterEvents,
    OFTLogs,
} from "../../src/oft/utils/constants";

jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const HYPE_COMPOSER = "0x1111111111111111111111111111111111111111";
const EVM_RECIPIENT = "0x2222222222222222222222222222222222222222";
const FROM_ADDRESS = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"44".repeat(32)}`;
const GUID_A = `0x${"aa".repeat(32)}`;
const GUID_B = `0x${"bb".repeat(32)}`;

function emptyLogs(): OFTLogs {
    return {
        oftSent: [],
        oftReceived: [],
        fAssetRedeemed: [],
        redemptionRequested: [],
        redemptionWithTagRequested: [],
        systemRedemptionFeePaid: [],
        packetSent: [],
        composeDelivered: [],
        fAssetRedeemFailed: [],
        composerFeeCollected: [],
    };
}

function makeLog(iface: Interface, eventName: string, args: unknown[], transactionHash = TX_HASH): ethers.Log {
    const encoded = iface.encodeEventLog(eventName, args);
    return {
        address: FROM_ADDRESS,
        blockHash: `0x${"55".repeat(32)}`,
        blockNumber: 100,
        data: encoded.data,
        index: 0,
        removed: false,
        topics: encoded.topics,
        transactionHash,
        transactionIndex: 0,
    } as unknown as ethers.Log;
}

function packetPayload(guid: string, recipient: string): string {
    return ethers.hexlify(
        ethers.concat([
            "0x01",
            ethers.zeroPadValue(ethers.toBeHex(1), 8),
            ethers.zeroPadValue(ethers.toBeHex(14), 4),
            ethers.zeroPadValue(FROM_ADDRESS, 32),
            ethers.zeroPadValue(ethers.toBeHex(30_101), 4),
            ethers.zeroPadValue(EVM_RECIPIENT, 32),
            guid,
            ethers.zeroPadValue(recipient, 32),
        ])
    );
}

function makeService() {
    const states = new Map<string, IndexerState>();
    const txEm = {
        findOne: jest.fn(async (_entity: unknown, where: { name: string }) => states.get(where.name) ?? null),
        persistAndFlush: jest.fn(async (entity: IndexerState) => {
            if (entity instanceof IndexerState) states.set(entity.name, entity);
        }),
    };
    const transactionHost = {
        transactional: jest.fn(async (callback: (em: typeof txEm) => unknown) => callback(txEm)),
    };
    const orm = {
        em: {
            fork: jest.fn(() => transactionHost),
        },
    };
    const service = new OFTEventReaderService({ get: jest.fn() } as any, orm as any);
    (service as any).em = txEm;
    (service as any).fasset = "FTestXRP";
    (service as any).oftConfig = { HypeComposerAddress: HYPE_COMPOSER.toLowerCase() };
    return { service, states, txEm };
}

describe("OFTEventReaderService MBE-04 integrity", () => {
    it("initializes the next-unread cursor and immutable first-trusted block together", async () => {
        const { service, states } = makeService();

        await expect((service as any).initializeIndexerState(500)).resolves.toBe(500);
        expect(states.get(OFT_LAST_BLOCK_STATE)?.lastBlock).toBe(500);
        expect(states.get(OFT_FIRST_TRUSTED_BLOCK_STATE)?.lastBlock).toBe(500);

        states.get(OFT_LAST_BLOCK_STATE)!.lastBlock = 600;
        await expect((service as any).initializeIndexerState(700)).resolves.toBe(600);
        expect(states.get(OFT_FIRST_TRUSTED_BLOCK_STATE)?.lastBlock).toBe(500);
    });

    it("advances the cursor to rangeEnd + 1 only after every save stage succeeds", async () => {
        const { service, states, txEm } = makeService();
        states.set(OFT_LAST_BLOCK_STATE, new IndexerState(OFT_LAST_BLOCK_STATE, 100));
        const logs = emptyLogs();
        jest.spyOn(service, "saveOFTSentEvents").mockResolvedValue();
        jest.spyOn(service, "saveOFTReceivedEvents").mockResolvedValue();
        jest.spyOn(service, "saveOFTRedemptions").mockResolvedValue();
        jest.spyOn(service, "saveOFTRedemptionFailedEvents").mockResolvedValue();

        await service.persistRange(logs, 100, 129);

        expect(service.saveOFTSentEvents).toHaveBeenCalledWith(logs, txEm);
        expect(service.saveOFTReceivedEvents).toHaveBeenCalledWith(logs.oftReceived, txEm);
        expect(service.saveOFTRedemptions).toHaveBeenCalledWith(logs, txEm);
        expect(service.saveOFTRedemptionFailedEvents).toHaveBeenCalledWith(logs.fAssetRedeemFailed, txEm);
        expect(states.get(OFT_LAST_BLOCK_STATE)?.lastBlock).toBe(130);

        await expect(service.persistRange(logs, 100, 129)).rejects.toThrow("Unexpected OFT cursor");
        expect(service.saveOFTSentEvents).toHaveBeenCalledTimes(1);
    });

    it.each([
        "saveOFTSentEvents",
        "saveOFTReceivedEvents",
        "saveOFTRedemptions",
        "saveOFTRedemptionFailedEvents",
    ] as const)("does not mutate the cursor when %s fails", async (failingStage) => {
        const { service, states } = makeService();
        const cursor = new IndexerState(OFT_LAST_BLOCK_STATE, 100);
        states.set(OFT_LAST_BLOCK_STATE, cursor);
        const logs = emptyLogs();
        jest.spyOn(service, "saveOFTSentEvents").mockResolvedValue();
        jest.spyOn(service, "saveOFTReceivedEvents").mockResolvedValue();
        jest.spyOn(service, "saveOFTRedemptions").mockResolvedValue();
        jest.spyOn(service, "saveOFTRedemptionFailedEvents").mockResolvedValue();
        (service[failingStage] as unknown as jest.Mock).mockRejectedValueOnce(new Error("write failed"));

        await expect(service.persistRange(logs, 100, 129)).rejects.toThrow("write failed");

        expect(cursor.lastBlock).toBe(100);
    });

    it("matches multiple same-transaction PacketSent events by guid and stores ABI amount order", async () => {
        const { service } = makeService();
        const logs = emptyLogs();
        logs.packetSent = [
            makeLog(EndpointV2Events, "PacketSent", [packetPayload(GUID_B, EVM_RECIPIENT), "0x", FROM_ADDRESS]),
            makeLog(EndpointV2Events, "PacketSent", [packetPayload(GUID_A, HYPE_COMPOSER), "0x", FROM_ADDRESS]),
        ];
        logs.oftSent = [
            makeLog(OFTAdapterEvents, "OFTSent", [GUID_A, 30_101, FROM_ADDRESS, 1_000n, 900n]),
            makeLog(OFTAdapterEvents, "OFTSent", [GUID_B, 30_101, FROM_ADDRESS, 2_000n, 1_800n]),
        ];
        const persisted: OFTSent[] = [];
        const em = {
            persistAndFlush: jest.fn(async (entity: OFTSent) => persisted.push(entity)),
        };

        await service.saveOFTSentEvents(logs, em as any);

        expect(persisted).toHaveLength(2);
        expect(persisted[0]).toEqual(
            expect.objectContaining({ guid: GUID_A, amountSentLD: "1000", amountReceivedLD: "900", toHypercore: true })
        );
        expect(persisted[1]).toEqual(
            expect.objectContaining({ guid: GUID_B, amountSentLD: "2000", amountReceivedLD: "1800", toHypercore: false })
        );
    });

    it("propagates a missing PacketSent companion instead of advancing past the OFTSent", async () => {
        const { service } = makeService();
        const logs = emptyLogs();
        logs.oftSent = [makeLog(OFTAdapterEvents, "OFTSent", [GUID_A, 30_101, FROM_ADDRESS, 1_000n, 900n])];
        const em = { persistAndFlush: jest.fn() };

        await expect(service.saveOFTSentEvents(logs, em as any)).rejects.toThrow(`Missing PacketSent event for OFTSent guid ${GUID_A}`);
        expect(em.persistAndFlush).not.toHaveBeenCalled();
    });
});

describe("OFTEventReaderService system redemption fees", () => {
    it("matches fees to each request independently of fee event order", async () => {
        const service = new OFTEventReaderService({ get: jest.fn() } as any, {} as any);
        const agentA = "0x6666666666666666666666666666666666666666";
        const agentB = "0x7777777777777777777777777777777777777777";
        const agentC = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const redeemer = "0x8888888888888888888888888888888888888888";
        const redeemerAccount = "0x9999999999999999999999999999999999999999";
        const executor = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const logs = emptyLogs();
        logs.fAssetRedeemed = [
            makeLog(FAssetRedeemComposerEvents, "FAssetRedeemed", [
                GUID_A,
                101,
                redeemer,
                redeemerAccount,
                2_500n,
                "rPaymentAddress",
                false,
                0,
                executor,
                0,
                2_500n,
                3,
            ]),
        ];
        logs.redemptionRequested = [
            makeLog(AM_REDEMPTION_REQUESTED_EVENT, "RedemptionRequested", [
                agentA,
                redeemerAccount,
                1,
                "rPaymentAddressA",
                900,
                10,
                1,
                2,
                3,
                GUID_A,
                executor,
                0,
            ]),
            makeLog(AM_REDEMPTION_REQUESTED_EVENT, "RedemptionRequested", [
                agentB,
                redeemerAccount,
                2,
                "rPaymentAddressB",
                1_080,
                20,
                1,
                2,
                3,
                GUID_B,
                executor,
                0,
            ]),
            makeLog(AM_REDEMPTION_REQUESTED_EVENT, "RedemptionRequested", [
                agentC,
                redeemerAccount,
                3,
                "rPaymentAddressC",
                500,
                5,
                1,
                2,
                3,
                `0x${"cc".repeat(32)}`,
                executor,
                0,
            ]),
        ];
        logs.systemRedemptionFeePaid = [
            makeLog(AM_SYSTEM_REDEMPTION_FEE_PAID_EVENT, "SystemRedemptionFeePaid", [agentB, 2, 20]),
            makeLog(AM_SYSTEM_REDEMPTION_FEE_PAID_EVENT, "SystemRedemptionFeePaid", [agentA, 1, 10]),
        ];
        const persisted: OFTRedemption[] = [];
        (service as any).em = {
            persistAndFlush: jest.fn(async (entity: unknown) => {
                if (entity instanceof OFTRedemption) persisted.push(entity);
            }),
        };
        (service as any).fasset = "FTestXRP";

        await service.saveOFTRedemptions(logs);

        expect(persisted.map((redemption) => [redemption.requestId, redemption.systemRedemptionFeeUBA])).toEqual([
            ["1", "10"],
            ["2", "20"],
            ["3", "0"],
        ]);
    });
});
