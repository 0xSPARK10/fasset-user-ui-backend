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
    let responses: Map<unknown, unknown[]>;

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
        ]);
        find = jest.fn().mockImplementation((entity) => Promise.resolve(responses.get(entity) ?? []));
        service = new OFTService({ find } as any, {} as any);
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
