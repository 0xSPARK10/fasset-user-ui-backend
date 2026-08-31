import { ethers, Interface } from "ethers";
import { OFTRedemption } from "../../src/entities/OFTRedemption";
import { OFTEventReaderService } from "../../src/oft/oft.event.reader.service";
import {
    AM_REDEMPTION_REQUESTED_EVENT,
    AM_SYSTEM_REDEMPTION_FEE_PAID_EVENT,
    FAssetRedeemComposerEvents,
    OFTLogs,
} from "../../src/oft/utils/constants";

jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

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

function makeLog(iface: Interface, eventName: string, args: unknown[]): ethers.Log {
    const encoded = iface.encodeEventLog(eventName, args);
    return {
        address: "0x3333333333333333333333333333333333333333",
        blockHash: `0x${"55".repeat(32)}`,
        blockNumber: 100,
        data: encoded.data,
        index: 0,
        removed: false,
        topics: encoded.topics,
        transactionHash: TX_HASH,
        transactionIndex: 0,
    } as unknown as ethers.Log;
}

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
