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
        Interface: jest.fn(),
        ContractFactory: MockContractFactory,
    };
});

import { Test, TestingModule } from "@nestjs/testing";
import { HttpException, HttpStatus } from "@nestjs/common";
import { RewardsController } from "src/controllers/rewards.controller";
import { RewardsService } from "src/services/rewarding.service";

describe("RewardsController", () => {
    let controller: RewardsController;
    let rewardsService: jest.Mocked<Partial<RewardsService>>;

    beforeEach(async () => {
        /** Mock RewardsService with the getRewardsForUser method */
        const mockRewardsService = {
            getRewardsForUser: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [RewardsController],
            providers: [{ provide: RewardsService, useValue: mockRewardsService }],
        }).compile();

        controller = module.get<RewardsController>(RewardsController);
        rewardsService = module.get(RewardsService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/rewards/:address -> rewardsService.getRewardsForUser()
    // ---------------------------------------------------------------
    describe("getRewards", () => {
        it("should return rewards data for the given address", async () => {
            const mockRewards = {
                claimedRflr: "100.000000",
                claimedUsd: "2.500000",
                claimableRflr: "50.000000",
                claimableUsd: "1.250000",
                points: "0",
                share: "0.0500",
                numTickets: 10,
                prevBiweeklyPlace: 25,
                prevBiweeklyRflr: "200.000000",
                prevBiweeklyRflrUSD: "5.000000",
                participated: true,
                rewardsDistributed: true,
            };
            rewardsService.getRewardsForUser.mockResolvedValue(mockRewards);

            const result = await controller.getRewards("0xUserAddress");

            expect(result).toEqual(mockRewards);
            expect(rewardsService.getRewardsForUser).toHaveBeenCalledWith("0xUserAddress");
        });

        it("should pass the address parameter correctly", async () => {
            rewardsService.getRewardsForUser.mockResolvedValue({});

            await controller.getRewards("0xDAF667A846eBE962D2F7eCD459B3be157eBf52BB");

            expect(rewardsService.getRewardsForUser).toHaveBeenCalledWith(
                "0xDAF667A846eBE962D2F7eCD459B3be157eBf52BB"
            );
        });

        it("should throw HttpException when service throws synchronously", () => {
            rewardsService.getRewardsForUser.mockImplementation(() => {
                throw new Error("rewards error");
            });

            expect(() => controller.getRewards("0xUserAddress")).toThrow(HttpException);
        });

        it("should include INTERNAL_SERVER_ERROR status on error", () => {
            rewardsService.getRewardsForUser.mockImplementation(() => {
                throw new Error("failure");
            });

            try {
                controller.getRewards("0xUserAddress");
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });

        it("should include the original error message in the HttpException response", () => {
            rewardsService.getRewardsForUser.mockImplementation(() => {
                throw new Error("contract call failed");
            });

            try {
                controller.getRewards("0xUserAddress");
            } catch (error) {
                const response = error.getResponse();
                expect(response.error).toContain("contract call failed");
            }
        });

        it("should handle when service returns partial rewards data", async () => {
            const partialRewards = {
                claimedRflr: "0",
                claimedUsd: "0",
                claimableRflr: "0",
                claimableUsd: "0",
                points: "0",
                share: "0.0000",
                numTickets: 0,
                prevBiweeklyPlace: 500,
                prevBiweeklyRflr: "0",
                prevBiweeklyRflrUSD: "0",
                participated: false,
                rewardsDistributed: true,
            };
            rewardsService.getRewardsForUser.mockResolvedValue(partialRewards);

            const result = await controller.getRewards("0xNewUser");

            expect(result).toEqual(partialRewards);
            expect(result.numTickets).toBe(0);
            expect(result.participated).toBe(false);
        });
    });
});
