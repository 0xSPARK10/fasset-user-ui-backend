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
import { RedemptionController } from "src/controllers/redemption.controller";
import { UserService } from "src/services/user.service";

describe("RedemptionController", () => {
    let controller: RedemptionController;
    let userService: jest.Mocked<Partial<UserService>>;

    beforeEach(async () => {
        /** Mock all UserService methods that RedemptionController depends on */
        const mockUserService = {
            getRedemptionFee: jest.fn(),
            getRedemptionStatus: jest.fn(),
            redemptionDefaultStatus: jest.fn(),
            requestRedemption: jest.fn(),
            getRedemptionFeeData: jest.fn(),
            getRedemptionQueue: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [RedemptionController],
            providers: [{ provide: UserService, useValue: mockUserService }],
        }).compile();

        controller = module.get<RedemptionController>(RedemptionController);
        userService = module.get(UserService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/redemptionFee/:fasset -> userService.getRedemptionFee()
    // ---------------------------------------------------------------
    describe("getRedemptionFee", () => {
        it("should return the redemption fee for a given fasset", async () => {
            const mockFee = { fee: "0.001" } as any;
            userService.getRedemptionFee.mockResolvedValue(mockFee);

            const result = await controller.getRedemptionFee("FTestXRP");

            expect(result).toEqual(mockFee);
            expect(userService.getRedemptionFee).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException when service throws", () => {
            userService.getRedemptionFee.mockImplementation(() => {
                throw new Error("fee error");
            });

            expect(() => controller.getRedemptionFee("FTestXRP")).toThrow(HttpException);
        });

        it("should include INTERNAL_SERVER_ERROR status on error", () => {
            userService.getRedemptionFee.mockImplementation(() => {
                throw new Error("failure");
            });

            try {
                controller.getRedemptionFee("FTestXRP");
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });
    });

    // ---------------------------------------------------------------
    // GET /api/redemptionStatus/:fasset/:txhash
    //   -> userService.getRedemptionStatus()
    // ---------------------------------------------------------------
    describe("getRedemptionStatus", () => {
        it("should return redemption status for fasset and txhash", async () => {
            const mockStatus = { status: "completed", amount: "1000" } as any;
            userService.getRedemptionStatus.mockResolvedValue(mockStatus);

            const result = await controller.getRedemptionStatus("FTestXRP", "0xTxHash");

            expect(result).toEqual(mockStatus);
            expect(userService.getRedemptionStatus).toHaveBeenCalledWith("FTestXRP", "0xTxHash");
        });

        it("should pass both params correctly", async () => {
            userService.getRedemptionStatus.mockResolvedValue({} as any);

            await controller.getRedemptionStatus("FTestBTC", "0xAnotherHash");

            expect(userService.getRedemptionStatus).toHaveBeenCalledWith("FTestBTC", "0xAnotherHash");
        });

        it("should throw HttpException when service throws", () => {
            userService.getRedemptionStatus.mockImplementation(() => {
                throw new Error("redemption status error");
            });

            expect(() => controller.getRedemptionStatus("FTestXRP", "0xTxHash")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/redemptionDefaultStatus/:txhash
    //   -> userService.redemptionDefaultStatus()
    // ---------------------------------------------------------------
    describe("redemptionDefault", () => {
        it("should return redemption default status for a txhash", async () => {
            const mockDefault = { txHash: "0xHash", defaults: [] } as any;
            userService.redemptionDefaultStatus.mockResolvedValue(mockDefault);

            const result = await controller.redemptionDefault("0xHash");

            expect(result).toEqual(mockDefault);
            expect(userService.redemptionDefaultStatus).toHaveBeenCalledWith("0xHash");
        });

        it("should throw HttpException when service throws", () => {
            userService.redemptionDefaultStatus.mockImplementation(() => {
                throw new Error("default status error");
            });

            expect(() => controller.redemptionDefault("0xHash")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/requestRedemptionDefault/:fasset/:txhash/:amount/:userAddress
    //   -> userService.requestRedemption(fasset, txhash, amount, userAddress)
    // ---------------------------------------------------------------
    describe("requestRedemptionDefault", () => {
        it("should call requestRedemption with all four parameters", async () => {
            const mockRedemption = { requestId: "789", status: "requested" } as any;
            userService.requestRedemption.mockResolvedValue(mockRedemption);

            const result = await controller.requestRedemptionDefault(
                "FTestXRP",
                "0xTxHash",
                "500000",
                "0xUserAddress"
            );

            expect(result).toEqual(mockRedemption);
            expect(userService.requestRedemption).toHaveBeenCalledWith(
                "FTestXRP",
                "0xTxHash",
                "500000",
                "0xUserAddress"
            );
        });

        it("should pass parameters in the correct order", async () => {
            userService.requestRedemption.mockResolvedValue({} as any);

            await controller.requestRedemptionDefault("fassetA", "hashB", "amountC", "addressD");

            expect(userService.requestRedemption).toHaveBeenCalledWith("fassetA", "hashB", "amountC", "addressD");
        });

        it("should throw HttpException when service throws", () => {
            userService.requestRedemption.mockImplementation(() => {
                throw new Error("redemption request error");
            });

            expect(() =>
                controller.requestRedemptionDefault("FTestXRP", "0xTxHash", "500000", "0xUserAddress")
            ).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/redemptionFeeData -> userService.getRedemptionFeeData()
    // ---------------------------------------------------------------
    describe("getRedemptionFeeData", () => {
        it("should return redemption fee data from the service", async () => {
            const mockFeeData = [
                { fasset: "FTestXRP", fee: "0.001" },
                { fasset: "FTestBTC", fee: "0.0001" },
            ] as any;
            userService.getRedemptionFeeData.mockResolvedValue(mockFeeData);

            const result = await controller.getRedemptionFeeData();

            expect(result).toEqual(mockFeeData);
            expect(userService.getRedemptionFeeData).toHaveBeenCalledTimes(1);
        });

        it("should throw HttpException when service throws", () => {
            userService.getRedemptionFeeData.mockImplementation(() => {
                throw new Error("fee data error");
            });

            expect(() => controller.getRedemptionFeeData()).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/redemptionQueue/:fasset -> userService.getRedemptionQueue()
    // ---------------------------------------------------------------
    describe("getRedemptionQueue", () => {
        it("should return the redemption queue for a given fasset", async () => {
            const mockQueue = {
                maxLots: 10,
                maxLotsOneRedemption: 5,
                maxAmountOneRedemptionDrops: "5000000",
                maxAmountOneRedemptionXRP: "5.000000",
                maxAmountDrops: "10000000",
                maxAmountXRP: "10.000000",
            };
            userService.getRedemptionQueue.mockResolvedValue(mockQueue);

            const result = await controller.getRedemptionQueue("FTestXRP");

            expect(result).toEqual(mockQueue);
            expect(userService.getRedemptionQueue).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException when service throws", () => {
            userService.getRedemptionQueue.mockImplementation(() => {
                throw new Error("queue error");
            });

            expect(() => controller.getRedemptionQueue("FTestXRP")).toThrow(HttpException);
        });
    });
});
