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
import { MintController } from "src/controllers/mint.controller";
import { UserService } from "src/services/user.service";

describe("MintController", () => {
    let controller: MintController;
    let userService: jest.Mocked<Partial<UserService>>;

    beforeEach(async () => {
        /** Mock all UserService methods that MintController depends on */
        const mockUserService = {
            getMaxLots: jest.fn(),
            getLotSize: jest.fn(),
            getCREventFromTxHash: jest.fn(),
            getCrStatus: jest.fn(),
            requestMinting: jest.fn(),
            mintingStatus: jest.fn(),
            getCRTFee: jest.fn(),
            estimateFeeForBlocks: jest.fn(),
            submitTx: jest.fn(),
            getEcosystemInfo: jest.fn(),
            getMintingEnabled: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [MintController],
            providers: [{ provide: UserService, useValue: mockUserService }],
        }).compile();

        controller = module.get<MintController>(MintController);
        userService = module.get(UserService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/maxLots/:fasset -> userService.getMaxLots()
    // ---------------------------------------------------------------
    describe("getMaxLots", () => {
        it("should return max lots for a fasset", async () => {
            const mockResult = { maxLots: 100 } as any;
            userService.getMaxLots.mockResolvedValue(mockResult);

            const result = await controller.getMaxLots("FTestXRP");

            expect(result).toEqual(mockResult);
            expect(userService.getMaxLots).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException when service throws", () => {
            userService.getMaxLots.mockImplementation(() => {
                throw new Error("max lots error");
            });

            expect(() => controller.getMaxLots("FTestXRP")).toThrow(HttpException);
        });

        it("should return INTERNAL_SERVER_ERROR status code on error", () => {
            userService.getMaxLots.mockImplementation(() => {
                throw new Error("failure");
            });

            try {
                controller.getMaxLots("FTestXRP");
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });
    });

    // ---------------------------------------------------------------
    // GET /api/lotSize/:fasset -> userService.getLotSize()
    // ---------------------------------------------------------------
    describe("getLotSize", () => {
        it("should return lot size for a fasset", async () => {
            const mockResult = { lotSize: "20000000" } as any;
            userService.getLotSize.mockResolvedValue(mockResult);

            const result = await controller.getLotSize("FTestXRP");

            expect(result).toEqual(mockResult);
            expect(userService.getLotSize).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException when service throws", () => {
            userService.getLotSize.mockImplementation(() => {
                throw new Error("lot size error");
            });

            expect(() => controller.getLotSize("FTestXRP")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/getCrEvent/:fasset/:txhash
    //   -> userService.getCREventFromTxHash(fasset, txhash, false)
    // ---------------------------------------------------------------
    describe("getEvents", () => {
        it("should call getCREventFromTxHash with fasset, txhash, and false", async () => {
            const mockEvent = {
                collateralReservationId: "123",
                paymentAddress: "rAddr",
                paymentReference: "0xRef",
            } as any;
            userService.getCREventFromTxHash.mockResolvedValue(mockEvent);

            const result = await controller.getEvents("FTestXRP", "0xTxHash");

            expect(result).toEqual(mockEvent);
            expect(userService.getCREventFromTxHash).toHaveBeenCalledWith("FTestXRP", "0xTxHash", false);
        });

        it("should always pass false as the third argument", async () => {
            userService.getCREventFromTxHash.mockResolvedValue({} as any);

            await controller.getEvents("FTestBTC", "0xHash");

            expect(userService.getCREventFromTxHash).toHaveBeenCalledWith("FTestBTC", "0xHash", false);
        });

        it("should throw HttpException when service throws", () => {
            userService.getCREventFromTxHash.mockImplementation(() => {
                throw new Error("cr event error");
            });

            expect(() => controller.getEvents("FTestXRP", "0xTxHash")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/getCrStatus/:crId -> userService.getCrStatus()
    // ---------------------------------------------------------------
    describe("getCREventDB", () => {
        it("should return CR status for the given crId", async () => {
            const mockStatus = { status: "completed" } as any;
            userService.getCrStatus.mockResolvedValue(mockStatus);

            const result = await controller.getCREventDB("456");

            expect(result).toEqual(mockStatus);
            expect(userService.getCrStatus).toHaveBeenCalledWith("456");
        });

        it("should return null when no CR status is found", async () => {
            userService.getCrStatus.mockResolvedValue(null);

            const result = await controller.getCREventDB("999");

            expect(result).toBeNull();
        });

        it("should throw HttpException when service throws", () => {
            userService.getCrStatus.mockImplementation(() => {
                throw new Error("cr status error");
            });

            expect(() => controller.getCREventDB("456")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // POST /api/mint -> userService.requestMinting(body)
    // ---------------------------------------------------------------
    describe("requestMinting", () => {
        it("should call userService.requestMinting with the request body", async () => {
            const requestBody = {
                fasset: "FTestXRP",
                collateralReservationId: "123",
                txHash: "0xTxHash",
            } as any;
            userService.requestMinting.mockResolvedValue(undefined);

            const result = await controller.requestMinting(requestBody);

            expect(result).toBeUndefined();
            expect(userService.requestMinting).toHaveBeenCalledWith(requestBody);
        });

        it("should throw HttpException when service throws", () => {
            userService.requestMinting.mockImplementation(() => {
                throw new Error("minting error");
            });

            expect(() =>
                controller.requestMinting({ fasset: "FTestXRP" } as any)
            ).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/mint/:txhash -> userService.mintingStatus()
    // ---------------------------------------------------------------
    describe("mintingStatus", () => {
        it("should return minting status for the given tx hash", async () => {
            const mockStatus = { status: "pending", txHash: "0xHash" } as any;
            userService.mintingStatus.mockResolvedValue(mockStatus);

            const result = await controller.mintingStatus("0xHash");

            expect(result).toEqual(mockStatus);
            expect(userService.mintingStatus).toHaveBeenCalledWith("0xHash");
        });

        it("should throw HttpException when service throws", () => {
            userService.mintingStatus.mockImplementation(() => {
                throw new Error("minting status error");
            });

            expect(() => controller.mintingStatus("0xHash")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/collateralReservationFee/:fasset/:lots
    //   -> userService.getCRTFee()
    // ---------------------------------------------------------------
    describe("getCRTFee", () => {
        it("should return collateral reservation fee for fasset and lots", async () => {
            const mockFee = { fee: "50000000000000000" } as any;
            userService.getCRTFee.mockResolvedValue(mockFee);

            const result = await controller.getCRTFee("FTestXRP", 3);

            expect(result).toEqual(mockFee);
            expect(userService.getCRTFee).toHaveBeenCalledWith("FTestXRP", 3);
        });

        it("should throw HttpException when service throws", () => {
            userService.getCRTFee.mockImplementation(() => {
                throw new Error("fee error");
            });

            expect(() => controller.getCRTFee("FTestXRP", 3)).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/estimateFee/:fasset -> userService.estimateFeeForBlocks()
    // ---------------------------------------------------------------
    describe("getFeeEstimate", () => {
        it("should return fee estimate for a fasset", async () => {
            const mockEstimate = { low: "10", medium: "20", high: "30" } as any;
            userService.estimateFeeForBlocks.mockResolvedValue(mockEstimate);

            const result = await controller.getFeeEstimate("FTestBTC");

            expect(result).toEqual(mockEstimate);
            expect(userService.estimateFeeForBlocks).toHaveBeenCalledWith("FTestBTC");
        });

        it("should throw HttpException when service throws", () => {
            userService.estimateFeeForBlocks.mockImplementation(() => {
                throw new Error("estimate error");
            });

            expect(() => controller.getFeeEstimate("FTestBTC")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/submitTx/:fasset/:hex -> userService.submitTx()
    // ---------------------------------------------------------------
    describe("submitTx", () => {
        it("should submit a transaction and return the response", async () => {
            const mockResponse = { txId: "0xSubmitted" } as any;
            userService.submitTx.mockResolvedValue(mockResponse);

            const result = await controller.submitTx("FTestXRP", "AABBCCDD");

            expect(result).toEqual(mockResponse);
            expect(userService.submitTx).toHaveBeenCalledWith("FTestXRP", "AABBCCDD");
        });

        it("should throw HttpException when service throws", () => {
            userService.submitTx.mockImplementation(() => {
                throw new Error("submit error");
            });

            expect(() => controller.submitTx("FTestXRP", "AABB")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/ecosystemInfo -> userService.getEcosystemInfo()
    // ---------------------------------------------------------------
    describe("getEcosystemData", () => {
        it("should return ecosystem info from the service", async () => {
            const mockInfo = {
                totalMinted: "1000000",
                totalCollateral: "5000000",
            } as any;
            userService.getEcosystemInfo.mockResolvedValue(mockInfo);

            const result = await controller.getEcosystemData();

            expect(result).toEqual(mockInfo);
            expect(userService.getEcosystemInfo).toHaveBeenCalledTimes(1);
        });

        it("should throw HttpException when service throws", () => {
            userService.getEcosystemInfo.mockImplementation(() => {
                throw new Error("ecosystem error");
            });

            expect(() => controller.getEcosystemData()).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/mintEnabled -> userService.getMintingEnabled()
    // ---------------------------------------------------------------
    describe("getMintingEnabled", () => {
        it("should return minting enabled status for all fassets", async () => {
            const mockStatus = [
                { fasset: "FTestXRP", enabled: true },
                { fasset: "FTestBTC", enabled: false },
            ] as any;
            userService.getMintingEnabled.mockResolvedValue(mockStatus);

            const result = await controller.getMintingEnabled();

            expect(result).toEqual(mockStatus);
            expect(userService.getMintingEnabled).toHaveBeenCalledTimes(1);
        });

        it("should throw HttpException when service throws", () => {
            userService.getMintingEnabled.mockImplementation(() => {
                throw new Error("mint enabled error");
            });

            expect(() => controller.getMintingEnabled()).toThrow(HttpException);
        });
    });
});
