import { BadRequestException, HttpStatus } from "@nestjs/common";
import { OFTController } from "src/oft/oft.controller";
import { OFTService } from "src/oft/oft.service";

describe("OFTController", () => {
    let controller: OFTController;
    let getOFTHistory: jest.Mock;
    let getOFTShortHistory: jest.Mock;

    beforeEach(() => {
        getOFTHistory = jest.fn().mockResolvedValue([]);
        getOFTShortHistory = jest.fn().mockResolvedValue([]);
        controller = new OFTController({ getOFTHistory, getOFTShortHistory } as unknown as OFTService);
    });

    it("preserves existing history behavior when xrpAddress is omitted", async () => {
        await expect(controller.getUserProgress("0xConnectedEvmAddress")).resolves.toEqual([]);

        expect(getOFTHistory).toHaveBeenCalledWith("0xConnectedEvmAddress", undefined);
    });

    it("forwards a checksum-valid XRP classic address unchanged", async () => {
        const xrpAddress = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

        await expect(controller.getUserProgress("0xConnectedEvmAddress", xrpAddress)).resolves.toEqual([]);

        expect(getOFTHistory).toHaveBeenCalledWith("0xConnectedEvmAddress", xrpAddress);
    });

    it.each([
        ["an empty value", ""],
        ["a malformed address", "rNotAClassicAddress"],
        ["an invalid checksum", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTj"],
        ["an X-address", "XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi"],
    ])("rejects %s without querying history", (_description, xrpAddress) => {
        try {
            controller.getUserProgress("0xConnectedEvmAddress", xrpAddress);
            fail("Expected an invalid classic address to be rejected");
        } catch (error) {
            expect(error).toBeInstanceOf(BadRequestException);
            expect((error as BadRequestException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
            expect((error as BadRequestException).message).toBe("xrpAddress must be a valid XRP classic address");
        }

        expect(getOFTHistory).not.toHaveBeenCalled();
    });

    describe("short history", () => {
        it("returns short history when xrpAddress is omitted", async () => {
            const history = [{ action: "REDEEM", guid: "0xGuid" }];
            getOFTShortHistory.mockResolvedValue(history);

            await expect(controller.getShortHistory("0xConnectedEvmAddress")).resolves.toBe(history);

            expect(getOFTShortHistory).toHaveBeenCalledWith("0xConnectedEvmAddress", undefined);
        });

        it("forwards a checksum-valid XRP classic address unchanged", async () => {
            const xrpAddress = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

            await expect(controller.getShortHistory("0xConnectedEvmAddress", xrpAddress)).resolves.toEqual([]);

            expect(getOFTShortHistory).toHaveBeenCalledWith("0xConnectedEvmAddress", xrpAddress);
        });

        it.each(["", "rNotAClassicAddress", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTj", "XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi"])(
            "rejects invalid XRP address %j without querying history",
            (xrpAddress) => {
                expect(() => controller.getShortHistory("0xConnectedEvmAddress", xrpAddress)).toThrow(
                    new BadRequestException("xrpAddress must be a valid XRP classic address")
                );
                expect(getOFTShortHistory).not.toHaveBeenCalled();
            }
        );
    });
});
