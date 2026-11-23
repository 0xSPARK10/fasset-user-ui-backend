import { BadRequestException, HttpStatus } from "@nestjs/common";
import { OFTHistory, Progress } from "src/interfaces/requestResponse";
import { OFTFullHistoryController } from "src/oft/oft.full-history.controller";
import { OFTService } from "src/oft/oft.service";
import { HistoryService } from "src/services/userHistory.service";

describe("OFTFullHistoryController", () => {
    let controller: OFTFullHistoryController;
    let getProgress: jest.Mock;
    let getOFTHistory: jest.Mock;

    const address = "0xConnectedEvmAddress";
    const mint: Progress = {
        action: "MINT",
        timestamp: 300,
        amount: "1.00",
        fasset: "FTestXRP",
        status: false,
        defaulted: false,
        txhash: "0xMintHash",
        directMinting: true,
        directMintingStatus: "DELAYED",
        delayTimestamp: 1726126000,
        evm_txhash: null,
    };
    const sent: OFTHistory = {
        action: "SEND",
        timestamp: 400,
        amount: "2.00",
        fasset: "FTestXRP",
        status: true,
        txhash: "0xSentHash",
        eid: 30101,
        toHypercore: false,
    };

    beforeEach(() => {
        getProgress = jest.fn().mockResolvedValue([]);
        getOFTHistory = jest.fn().mockResolvedValue([]);
        controller = new OFTFullHistoryController({ getProgress } as unknown as HistoryService, { getOFTHistory } as unknown as OFTService);
    });

    it.each([undefined, "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"])("forwards both address selectors unchanged with xrpAddress %j", async (xrpAddress) => {
        await expect(controller.getFullHistory(address, xrpAddress)).resolves.toEqual([]);

        expect(getProgress).toHaveBeenCalledWith(address, xrpAddress);
        expect(getOFTHistory).toHaveBeenCalledWith(address, xrpAddress);
    });

    it.each(["", "rNotAClassicAddress", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTj", "XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi"])(
        "rejects invalid XRP address %j before querying either source",
        async (xrpAddress) => {
            const result = controller.getFullHistory(address, xrpAddress);

            await expect(result).rejects.toBeInstanceOf(BadRequestException);
            await expect(result).rejects.toMatchObject({
                status: HttpStatus.BAD_REQUEST,
                message: "xrpAddress must be a valid XRP classic address",
            });
            expect(getProgress).not.toHaveBeenCalled();
            expect(getOFTHistory).not.toHaveBeenCalled();
        }
    );

    it("merges interleaved timestamps newest first and preserves early bridge destination metadata without changing entries or source arrays", async () => {
        const redeem: Progress = {
            action: "REDEEM",
            timestamp: 100,
            amount: "3.00",
            fasset: "FTestXRP",
            status: false,
            defaulted: false,
            txhash: "0xRedeemHash",
            ticketID: "1",
            redeemWithTag: true,
            destinationTag: "42",
            remainingAmount: "500000",
        };
        const bridge: OFTHistory = {
            ...sent,
            action: "DIRECT_MINT_BRIDGE",
            timestamp: 200,
            txhash: "ABC123",
            xrplTxHash: "ABC123",
            evmTxHash: null,
            eid: 30110,
            destinationKind: "HYPER_EVM",
            toHypercore: null,
            amountEstimated: true,
            oftSent: null,
        };
        const userProgress = [mint, redeem];
        const oftHistory = [sent, bridge];
        getProgress.mockResolvedValue(userProgress);
        getOFTHistory.mockResolvedValue(oftHistory);

        const result = await controller.getFullHistory(address);
        const expected = [sent, mint, bridge, redeem];

        expect(result).toEqual(expected);
        expected.forEach((entry, index) => expect(result[index]).toBe(entry));
        expect(userProgress).toEqual([mint, redeem]);
        expect(oftHistory).toEqual([sent, bridge]);
    });

    it.each([
        [8, "AWAITING_RECOVERY"],
        [30, "AWAITING_RECOVERY"],
        [8, "RECOVERY_PENDING"],
        [30, "RECOVERY_PENDING"],
    ] as const)("retains a %i-day-old bridge in %s alongside recent entries", async (ageDays, status) => {
        const now = Date.now();
        const recentMint = { ...mint, timestamp: now - 1000 };
        const recentSent = { ...sent, timestamp: now };
        const bridge: OFTHistory = {
            ...sent,
            action: "DIRECT_MINT_BRIDGE",
            timestamp: now - ageDays * 24 * 60 * 60 * 1000,
            status: false,
            directMinting: true,
            directMintingStatus: status,
            eid: null,
            toHypercore: null,
            amountEstimated: true,
            oftSent: null,
        };
        getProgress.mockResolvedValue([recentMint]);
        getOFTHistory.mockResolvedValue([bridge, recentSent]);

        await expect(controller.getFullHistory(address, "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh")).resolves.toEqual([recentSent, recentMint, bridge]);
    });

    it("retains overlapping redemption tickets and source order for equal timestamps", async () => {
        const firstTicket: Progress = { ...mint, action: "REDEEM", txhash: "0xRedeemHash", ticketID: "1" };
        const secondTicket: Progress = { ...firstTicket, ticketID: "2" };
        const firstOftTicket: OFTHistory = { ...sent, ...firstTicket, guid: "0xGuid" };
        const secondOftTicket: OFTHistory = { ...firstOftTicket, ticketID: "2" };
        getProgress.mockResolvedValue([firstTicket, secondTicket]);
        getOFTHistory.mockResolvedValue([firstOftTicket, secondOftTicket]);

        await expect(controller.getFullHistory(address)).resolves.toEqual([firstTicket, secondTicket, firstOftTicket, secondOftTicket]);
    });

    it.each([
        { name: "user progress", userProgress: [mint], oftHistory: [] },
        { name: "OFT history", userProgress: [], oftHistory: [sent] },
    ])("returns $name when the other source is empty", async ({ userProgress, oftHistory }) => {
        getProgress.mockResolvedValue(userProgress);
        getOFTHistory.mockResolvedValue(oftHistory);

        await expect(controller.getFullHistory(address)).resolves.toEqual([...userProgress, ...oftHistory]);
    });

    it.each(["user progress", "OFT history"])("propagates a failure from %s", async (source) => {
        const error = new Error("History unavailable");
        (source === "user progress" ? getProgress : getOFTHistory).mockRejectedValue(error);

        await expect(controller.getFullHistory(address)).rejects.toBe(error);
    });
});
