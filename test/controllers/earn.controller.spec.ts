/* ---- mock heavy transitive dependencies before any imports ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { Test, TestingModule } from "@nestjs/testing";
import { HttpException, HttpStatus } from "@nestjs/common";
import { EarnController } from "src/controllers/earn.controller";
import { EarnService } from "src/services/earn.service";

describe("EarnController", () => {
    let controller: EarnController;
    let earnService: jest.Mocked<Partial<EarnService>>;

    beforeEach(async () => {
        /** Mock EarnService with the getEcosystemList method */
        const mockEarnService = {
            getEcosystemList: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [EarnController],
            providers: [{ provide: EarnService, useValue: mockEarnService }],
        }).compile();

        controller = module.get<EarnController>(EarnController);
        earnService = module.get(EarnService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/earn -> earnService.getEcosystemList()
    // ---------------------------------------------------------------
    describe("getEarnList", () => {
        it("should return the ecosystem list from the service", () => {
            const mockList = {
                "Enosys DEX": {
                    type: "dex",
                    pairs: ["FTestXRP/CFLR"],
                    coin_type: "fasset",
                    url: "https://enosys.global",
                    yt_url: "",
                    description: "DEX trading",
                },
                "BlazeSwap": {
                    type: "dex",
                    pairs: ["FTestBTC/CFLR"],
                    coin_type: "fasset",
                    url: "https://blazeswap.xyz",
                    yt_url: "",
                    description: "AMM DEX",
                },
            } as any;
            earnService.getEcosystemList.mockReturnValue(mockList);

            const result = controller.getEarnList();

            expect(result).toEqual(mockList);
            expect(earnService.getEcosystemList).toHaveBeenCalledTimes(1);
        });

        it("should return an empty object when no ecosystem apps are available", () => {
            earnService.getEcosystemList.mockReturnValue({});

            const result = controller.getEarnList();

            expect(result).toEqual({});
        });

        it("should throw HttpException when service throws", () => {
            earnService.getEcosystemList.mockImplementation(() => {
                throw new Error("earn service error");
            });

            expect(() => controller.getEarnList()).toThrow(HttpException);
        });

        it("should include INTERNAL_SERVER_ERROR status on error", () => {
            earnService.getEcosystemList.mockImplementation(() => {
                throw new Error("failure");
            });

            try {
                controller.getEarnList();
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });

        it("should include the original error message in the HttpException response", () => {
            earnService.getEcosystemList.mockImplementation(() => {
                throw new Error("specific earn failure");
            });

            try {
                controller.getEarnList();
            } catch (error) {
                const response = error.getResponse();
                expect(response.error).toContain("specific earn failure");
            }
        });
    });
});
