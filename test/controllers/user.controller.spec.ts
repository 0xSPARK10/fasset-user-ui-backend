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
import { UserController } from "src/controllers/user.controller";
import { UserService } from "src/services/user.service";
import { PoolService } from "src/services/pool.service";
import { HistoryService } from "src/services/userHistory.service";

describe("UserController", () => {
    let controller: UserController;
    let userService: jest.Mocked<Partial<UserService>>;
    let poolService: jest.Mocked<Partial<PoolService>>;
    let historyService: jest.Mocked<Partial<HistoryService>>;

    beforeEach(async () => {
        /** Create mock objects for all three dependencies of UserController */
        const mockUserService = {
            listAvailableFassets: jest.fn(),
            getBestAgent: jest.fn(),
            getAssetManagerAddress: jest.fn(),
            getExecutorAddress: jest.fn(),
            getLifetimeClaimed: jest.fn(),
            getTimeData: jest.fn(),
            checkStateFassets: jest.fn(),
            getAssetPrice: jest.fn(),
            mintingUnderlyingTransactionExists: jest.fn(),
        };

        const mockPoolService = {
            getAgentsLatest: jest.fn(),
        };

        const mockHistoryService = {
            getProgress: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [UserController],
            providers: [
                { provide: UserService, useValue: mockUserService },
                { provide: PoolService, useValue: mockPoolService },
                { provide: HistoryService, useValue: mockHistoryService },
            ],
        }).compile();

        controller = module.get<UserController>(UserController);
        userService = module.get(UserService);
        poolService = module.get(PoolService);
        historyService = module.get(HistoryService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/fassets -> userService.listAvailableFassets()
    // ---------------------------------------------------------------
    describe("listAvailableFassets", () => {
        it("should return available fassets from the user service", () => {
            const result = { fassets: ["FTestXRP", "FTestBTC"] } as any;
            userService.listAvailableFassets.mockReturnValue(result);

            expect(controller.listAvailableFassets()).toEqual(result);
            expect(userService.listAvailableFassets).toHaveBeenCalledTimes(1);
        });

        it("should throw HttpException when userService.listAvailableFassets throws", () => {
            userService.listAvailableFassets.mockImplementation(() => {
                throw new Error("service failure");
            });

            expect(() => controller.listAvailableFassets()).toThrow(HttpException);
        });

        it("should return INTERNAL_SERVER_ERROR status when service throws", () => {
            userService.listAvailableFassets.mockImplementation(() => {
                throw new Error("unexpected");
            });

            try {
                controller.listAvailableFassets();
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });
    });

    // ---------------------------------------------------------------
    // GET /api/agent/:fasset/:lots -> userService.getBestAgent()
    // ---------------------------------------------------------------
    describe("getBestAgent", () => {
        it("should call userService.getBestAgent with correct params and return result", async () => {
            const mockResult = { agentVault: "0xAgent", feeBIPS: 100 } as any;
            userService.getBestAgent.mockResolvedValue(mockResult);

            const result = await controller.getBestAgent("FTestXRP", 5);

            expect(result).toEqual(mockResult);
            expect(userService.getBestAgent).toHaveBeenCalledWith("FTestXRP", 5);
        });

        it("should throw HttpException when userService.getBestAgent throws synchronously", () => {
            userService.getBestAgent.mockImplementation(() => {
                throw new Error("agent error");
            });

            expect(() => controller.getBestAgent("FTestXRP", 5)).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/agents/:fasset -> poolService.getAgentsLatest()
    // ---------------------------------------------------------------
    describe("getAllAgents", () => {
        it("should call poolService.getAgentsLatest with the fasset param", async () => {
            const mockAgents = [{ agentVault: "0x1" }, { agentVault: "0x2" }] as any;
            poolService.getAgentsLatest.mockResolvedValue(mockAgents);

            const result = await controller.getAllAgents("FTestXRP");

            expect(result).toEqual(mockAgents);
            expect(poolService.getAgentsLatest).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException when poolService throws synchronously", () => {
            poolService.getAgentsLatest.mockImplementation(() => {
                throw new Error("pool error");
            });

            expect(() => controller.getAllAgents("FTestXRP")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/assetManagerAddress/:fasset -> userService.getAssetManagerAddress()
    // ---------------------------------------------------------------
    describe("getAssetManagerAddress", () => {
        it("should return the asset manager address for a given fasset", async () => {
            const mockAddress = { address: "0xAssetManager" } as any;
            userService.getAssetManagerAddress.mockResolvedValue(mockAddress);

            const result = await controller.getAssetManagerAddress("FTestXRP");

            expect(result).toEqual(mockAddress);
            expect(userService.getAssetManagerAddress).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException on generic error", () => {
            userService.getAssetManagerAddress.mockImplementation(() => {
                throw new Error("generic error");
            });

            expect(() => controller.getAssetManagerAddress("FTestXRP")).toThrow(HttpException);
        });

        it("should re-throw LotsException when the service throws LotsException", () => {
            // Import and simulate a LotsException
            const { LotsException } = require("src/exceptions/lots.exception");
            userService.getAssetManagerAddress.mockImplementation(() => {
                throw new LotsException("lots error");
            });

            try {
                controller.getAssetManagerAddress("FTestXRP");
                fail("Should have thrown");
            } catch (error) {
                expect(error).toBeInstanceOf(LotsException);
                expect(error.message).toBe("lots error");
            }
        });
    });

    // ---------------------------------------------------------------
    // GET /api/executor/:fasset -> userService.getExecutorAddress()
    // ---------------------------------------------------------------
    describe("getExecutor", () => {
        it("should return executor address for a fasset", async () => {
            const mockExecutor = { address: "0xExecutor", fee: "100" } as any;
            userService.getExecutorAddress.mockResolvedValue(mockExecutor);

            const result = await controller.getExecutor("FTestXRP");

            expect(result).toEqual(mockExecutor);
            expect(userService.getExecutorAddress).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException when service throws", () => {
            userService.getExecutorAddress.mockImplementation(() => {
                throw new Error("executor error");
            });

            expect(() => controller.getExecutor("FTestXRP")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/userProgress/:address -> historyService.getProgress()
    // ---------------------------------------------------------------
    describe("getUserProgress", () => {
        it("should call historyService.getProgress with the user address", async () => {
            const mockProgress = [{ status: "minting", txHash: "0xabc" }] as any;
            historyService.getProgress.mockResolvedValue(mockProgress);

            const result = await controller.getUserProgress("0xUserAddress");

            expect(result).toEqual(mockProgress);
            expect(historyService.getProgress).toHaveBeenCalledWith("0xUserAddress");
        });

        it("should throw HttpException when historyService throws", () => {
            historyService.getProgress.mockImplementation(() => {
                throw new Error("history error");
            });

            expect(() => controller.getUserProgress("0xUserAddress")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/lifetimeClaimed/:address -> userService.getLifetimeClaimed()
    // ---------------------------------------------------------------
    describe("getLifetimeClaimed", () => {
        it("should return lifetime claimed data for an address", async () => {
            const mockData = { claimed: "1000" };
            userService.getLifetimeClaimed.mockResolvedValue(mockData);

            const result = await controller.getLifetimeClaimed("0xUserAddress");

            expect(result).toEqual(mockData);
            expect(userService.getLifetimeClaimed).toHaveBeenCalledWith("0xUserAddress");
        });

        it("should throw HttpException when service throws", () => {
            userService.getLifetimeClaimed.mockImplementation(() => {
                throw new Error("claimed error");
            });

            expect(() => controller.getLifetimeClaimed("0xUserAddress")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/timeData/:time -> userService.getTimeData()
    // ---------------------------------------------------------------
    describe("getTimeData", () => {
        it("should return time data for the given time string", async () => {
            const mockTimeData = { currentBlockTimestamp: 12345, currentBlock: 100 } as any;
            userService.getTimeData.mockResolvedValue(mockTimeData);

            const result = await controller.getTimeData("1700000000");

            expect(result).toEqual(mockTimeData);
            expect(userService.getTimeData).toHaveBeenCalledWith("1700000000");
        });

        it("should throw HttpException when service throws", () => {
            userService.getTimeData.mockImplementation(() => {
                throw new Error("time error");
            });

            expect(() => controller.getTimeData("1700000000")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/fassetState -> userService.checkStateFassets()
    // ---------------------------------------------------------------
    describe("getFassetState", () => {
        it("should return fasset state from the service", async () => {
            const mockState = { FTestXRP: "active", FTestBTC: "paused" };
            userService.checkStateFassets.mockResolvedValue(mockState);

            const result = await controller.getFassetState();

            expect(result).toEqual(mockState);
            expect(userService.checkStateFassets).toHaveBeenCalledTimes(1);
        });

        it("should throw HttpException when service throws", () => {
            userService.checkStateFassets.mockImplementation(() => {
                throw new Error("state error");
            });

            expect(() => controller.getFassetState()).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/fassetPrice/:fasset -> userService.getAssetPrice()
    // ---------------------------------------------------------------
    describe("getFassetPrice", () => {
        it("should return asset price for the given fasset", async () => {
            const mockPrice = { price: "0.50", timestamp: 1700000000 } as any;
            userService.getAssetPrice.mockResolvedValue(mockPrice);

            const result = await controller.getFassetPrice("FTestXRP");

            expect(result).toEqual(mockPrice);
            expect(userService.getAssetPrice).toHaveBeenCalledWith("FTestXRP");
        });

        it("should throw HttpException when service throws", () => {
            userService.getAssetPrice.mockImplementation(() => {
                throw new Error("price error");
            });

            expect(() => controller.getFassetPrice("FTestXRP")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/underlyingStatus/:fasset/:paymentReference
    //   -> userService.mintingUnderlyingTransactionExists()
    // ---------------------------------------------------------------
    describe("getUnderlyingStatus", () => {
        it("should return boolean indicating underlying transaction existence", async () => {
            userService.mintingUnderlyingTransactionExists.mockResolvedValue(true);

            const result = await controller.getUnderlyingStatus("FTestXRP", "0xPaymentRef");

            expect(result).toBe(true);
            expect(userService.mintingUnderlyingTransactionExists).toHaveBeenCalledWith("FTestXRP", "0xPaymentRef");
        });

        it("should return false when no underlying transaction exists", async () => {
            userService.mintingUnderlyingTransactionExists.mockResolvedValue(false);

            const result = await controller.getUnderlyingStatus("FTestXRP", "0xPaymentRef");

            expect(result).toBe(false);
        });

        it("should throw HttpException when service throws", () => {
            userService.mintingUnderlyingTransactionExists.mockImplementation(() => {
                throw new Error("underlying error");
            });

            expect(() => controller.getUnderlyingStatus("FTestXRP", "0xPaymentRef")).toThrow(HttpException);
        });
    });
});
