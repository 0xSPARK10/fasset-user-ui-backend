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
import { PoolController } from "src/controllers/pool.controller";
import { UserService } from "src/services/user.service";
import { PoolService } from "src/services/pool.service";

describe("PoolController", () => {
    let controller: PoolController;
    let userService: jest.Mocked<Partial<UserService>>;
    let poolService: jest.Mocked<Partial<PoolService>>;

    beforeEach(async () => {
        /** Mock UserService methods that PoolController depends on */
        const mockUserService = {
            getMaxWithdraw: jest.fn(),
            getMaxCPTWithdraw: jest.fn(),
        };

        /** Mock PoolService methods that PoolController depends on */
        const mockPoolService = {
            getPools: jest.fn(),
            getAgents: jest.fn(),
            getPoolsSpecific: jest.fn(),
            getAgentSpecific: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [PoolController],
            providers: [
                { provide: UserService, useValue: mockUserService },
                { provide: PoolService, useValue: mockPoolService },
            ],
        }).compile();

        controller = module.get<PoolController>(PoolController);
        userService = module.get(UserService);
        poolService = module.get(PoolService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/pools/:address (query: fasset[])
    //   -> poolService.getPools(fassetArray, address)
    // ---------------------------------------------------------------
    describe("getPools", () => {
        it("should call poolService.getPools with fasset array and address", async () => {
            const mockPools = [{ poolAddress: "0xPool1" }] as any;
            poolService.getPools.mockResolvedValue(mockPools);

            const result = await controller.getPools(["FTestXRP", "FTestBTC"], "0xUserAddress");

            expect(result).toEqual(mockPools);
            expect(poolService.getPools).toHaveBeenCalledWith(["FTestXRP", "FTestBTC"], "0xUserAddress");
        });

        it("should wrap a single fasset string into an array", async () => {
            poolService.getPools.mockResolvedValue([] as any);

            // When fasset is a single string (not array), controller wraps it
            await controller.getPools("FTestXRP" as any, "0xUser");

            expect(poolService.getPools).toHaveBeenCalledWith(["FTestXRP"], "0xUser");
        });

        it("should keep arrays intact when fasset is already an array", async () => {
            poolService.getPools.mockResolvedValue([] as any);

            await controller.getPools(["FTestXRP"], "0xUser");

            expect(poolService.getPools).toHaveBeenCalledWith(["FTestXRP"], "0xUser");
        });

        it("should throw HttpException when service throws", () => {
            poolService.getPools.mockImplementation(() => {
                throw new Error("pools error");
            });

            expect(() => controller.getPools(["FTestXRP"], "0xUser")).toThrow(HttpException);
        });

        it("should include INTERNAL_SERVER_ERROR status on error", () => {
            poolService.getPools.mockImplementation(() => {
                throw new Error("failure");
            });

            try {
                controller.getPools(["FTestXRP"], "0xUser");
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });
    });

    // ---------------------------------------------------------------
    // GET /api/maxWithdraw/:fasset/:poolAddress/:userAddress/:value
    //   -> userService.getMaxWithdraw(fasset, poolAddress, userAddress, value)
    // ---------------------------------------------------------------
    describe("getMaxWithdraw", () => {
        it("should call userService.getMaxWithdraw with all four parameters", async () => {
            const mockResult = { maxWithdraw: "500000" } as any;
            userService.getMaxWithdraw.mockResolvedValue(mockResult);

            const result = await controller.getMaxWithdraw("FTestXRP", "0xPool", "0xUser", 100);

            expect(result).toEqual(mockResult);
            expect(userService.getMaxWithdraw).toHaveBeenCalledWith("FTestXRP", "0xPool", "0xUser", 100);
        });

        it("should pass parameters in the correct order", async () => {
            userService.getMaxWithdraw.mockResolvedValue({} as any);

            await controller.getMaxWithdraw("fassetA", "poolB", "userC", 42);

            expect(userService.getMaxWithdraw).toHaveBeenCalledWith("fassetA", "poolB", "userC", 42);
        });

        it("should throw HttpException when service throws", () => {
            userService.getMaxWithdraw.mockImplementation(() => {
                throw new Error("max withdraw error");
            });

            expect(() => controller.getMaxWithdraw("FTestXRP", "0xPool", "0xUser", 100)).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/pools (query: fasset[])
    //   -> poolService.getAgents(fassetArray)
    // ---------------------------------------------------------------
    describe("getAgents", () => {
        it("should call poolService.getAgents with the fasset array", async () => {
            const mockAgents = [{ agentVault: "0xAgent1" }, { agentVault: "0xAgent2" }] as any;
            poolService.getAgents.mockResolvedValue(mockAgents);

            const result = await controller.getAgents(["FTestXRP", "FTestBTC"]);

            expect(result).toEqual(mockAgents);
            expect(poolService.getAgents).toHaveBeenCalledWith(["FTestXRP", "FTestBTC"]);
        });

        it("should wrap a single fasset string into an array", async () => {
            poolService.getAgents.mockResolvedValue([] as any);

            await controller.getAgents("FTestXRP" as any);

            expect(poolService.getAgents).toHaveBeenCalledWith(["FTestXRP"]);
        });

        it("should throw HttpException when service throws", () => {
            poolService.getAgents.mockImplementation(() => {
                throw new Error("agents error");
            });

            expect(() => controller.getAgents(["FTestXRP"])).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/maxPoolWith/:fasset/:poolAddress
    //   -> userService.getMaxCPTWithdraw(fasset, poolAddress)
    // ---------------------------------------------------------------
    describe("getMaxWith", () => {
        it("should return max CPT withdraw for fasset and pool address", async () => {
            const mockResult = { maxWithdraw: "750000" } as any;
            userService.getMaxCPTWithdraw.mockResolvedValue(mockResult);

            const result = await controller.getMaxWith("FTestXRP", "0xPoolAddress");

            expect(result).toEqual(mockResult);
            expect(userService.getMaxCPTWithdraw).toHaveBeenCalledWith("FTestXRP", "0xPoolAddress");
        });

        it("should throw HttpException when service throws", () => {
            userService.getMaxCPTWithdraw.mockImplementation(() => {
                throw new Error("max cpt error");
            });

            expect(() => controller.getMaxWith("FTestXRP", "0xPoolAddress")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/pools/:fasset/:address/:poolAddress
    //   -> poolService.getPoolsSpecific(fasset, address, poolAddress)
    // ---------------------------------------------------------------
    describe("getPoolsSpecific", () => {
        it("should call poolService.getPoolsSpecific with all three parameters", async () => {
            const mockPool = { poolAddress: "0xPool", userShare: "1000" } as any;
            poolService.getPoolsSpecific.mockResolvedValue(mockPool);

            const result = await controller.getPoolsSpecific("FTestXRP", "0xUserAddr", "0xPoolAddr");

            expect(result).toEqual(mockPool);
            expect(poolService.getPoolsSpecific).toHaveBeenCalledWith("FTestXRP", "0xUserAddr", "0xPoolAddr");
        });

        it("should throw HttpException when service throws", () => {
            poolService.getPoolsSpecific.mockImplementation(() => {
                throw new Error("specific pool error");
            });

            expect(() => controller.getPoolsSpecific("FTestXRP", "0xUser", "0xPool")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/pools/:fasset/:poolAddress
    //   -> poolService.getAgentSpecific(fasset, poolAddress)
    // ---------------------------------------------------------------
    describe("getAgentSpecific", () => {
        it("should call poolService.getAgentSpecific with fasset and pool address", async () => {
            const mockAgent = { agentVault: "0xAgent", poolAddress: "0xPool" } as any;
            poolService.getAgentSpecific.mockResolvedValue(mockAgent);

            const result = await controller.getAgentSpecific("FTestXRP", "0xPoolAddress");

            expect(result).toEqual(mockAgent);
            expect(poolService.getAgentSpecific).toHaveBeenCalledWith("FTestXRP", "0xPoolAddress");
        });

        it("should throw HttpException when service throws", () => {
            poolService.getAgentSpecific.mockImplementation(() => {
                throw new Error("agent specific error");
            });

            expect(() => controller.getAgentSpecific("FTestXRP", "0xPoolAddress")).toThrow(HttpException);
        });
    });
});
