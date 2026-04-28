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
import { BalanceController } from "src/controllers/balance.controller";
import { UserService } from "src/services/user.service";

describe("BalanceController", () => {
    let controller: BalanceController;
    let userService: jest.Mocked<Partial<UserService>>;

    beforeEach(async () => {
        /** Mock the UserService methods that BalanceController depends on */
        const mockUserService = {
            getUnderlyingBalance: jest.fn(),
            getNativeBalances: jest.fn(),
            getPoolBalances: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [BalanceController],
            providers: [{ provide: UserService, useValue: mockUserService }],
        }).compile();

        controller = module.get<BalanceController>(BalanceController);
        userService = module.get(UserService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/balance/underlying/:fasset/:address
    //   -> userService.getUnderlyingBalance(fasset, address, [...], [...])
    // ---------------------------------------------------------------
    describe("getUnderlyingBalance", () => {
        it("should call userService.getUnderlyingBalance with parsed address lists", async () => {
            const mockBalance = { balance: "1000", accountInfo: { depositAuth: false, destTagReq: false } } as any;
            userService.getUnderlyingBalance.mockResolvedValue(mockBalance);

            const result = await controller.getUnderlyingBalance(
                "FTestXRP",
                "rAddress123",
                "addr1,addr2",
                "change1,change2"
            );

            expect(result).toEqual(mockBalance);
            expect(userService.getUnderlyingBalance).toHaveBeenCalledWith(
                "FTestXRP",
                "rAddress123",
                ["addr1", "addr2"],
                ["change1", "change2"]
            );
        });

        it("should pass empty arrays when query params are not provided", async () => {
            const mockBalance = { balance: "500" } as any;
            userService.getUnderlyingBalance.mockResolvedValue(mockBalance);

            const result = await controller.getUnderlyingBalance("FTestXRP", "rAddress123", undefined, undefined);

            expect(result).toEqual(mockBalance);
            expect(userService.getUnderlyingBalance).toHaveBeenCalledWith(
                "FTestXRP",
                "rAddress123",
                [],
                []
            );
        });

        it("should pass empty arrays when query params are empty strings", async () => {
            const mockBalance = { balance: "0" } as any;
            userService.getUnderlyingBalance.mockResolvedValue(mockBalance);

            const result = await controller.getUnderlyingBalance("FTestXRP", "rAddress123", "", "");

            // Controller filters out empty strings, resulting in empty arrays
            expect(userService.getUnderlyingBalance).toHaveBeenCalledWith(
                "FTestXRP",
                "rAddress123",
                [],
                []
            );
        });

        it("should throw HttpException when service throws synchronously", () => {
            userService.getUnderlyingBalance.mockImplementation(() => {
                throw new Error("balance error");
            });

            expect(() =>
                controller.getUnderlyingBalance("FTestXRP", "rAddr", undefined, undefined)
            ).toThrow(HttpException);
        });

        it("should include INTERNAL_SERVER_ERROR status on error", () => {
            userService.getUnderlyingBalance.mockImplementation(() => {
                throw new Error("failure");
            });

            try {
                controller.getUnderlyingBalance("FTestXRP", "rAddr", undefined, undefined);
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });
    });

    // ---------------------------------------------------------------
    // GET /api/balance/native/:address -> userService.getNativeBalances()
    // ---------------------------------------------------------------
    describe("getNativeBalances", () => {
        it("should return native balances for the given address", async () => {
            const mockBalances = [
                { symbol: "CFLR", balance: "10000000000000000000" },
                { symbol: "FTestXRP", balance: "5000000000000000000" },
            ] as any;
            userService.getNativeBalances.mockResolvedValue(mockBalances);

            const result = await controller.getNativeBalances("0xUserAddress");

            expect(result).toEqual(mockBalances);
            expect(userService.getNativeBalances).toHaveBeenCalledWith("0xUserAddress");
        });

        it("should throw HttpException when service throws", () => {
            userService.getNativeBalances.mockImplementation(() => {
                throw new Error("native error");
            });

            expect(() => controller.getNativeBalances("0xUserAddress")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/balance/pool/:userAddress -> userService.getPoolBalances()
    // ---------------------------------------------------------------
    describe("getPoolBalances", () => {
        it("should return pool balances for the given user address", async () => {
            const mockBalance = { balance: "2500" } as any;
            userService.getPoolBalances.mockResolvedValue(mockBalance);

            const result = await controller.getPoolBalances("0xUserAddress");

            expect(result).toEqual(mockBalance);
            expect(userService.getPoolBalances).toHaveBeenCalledWith("0xUserAddress");
        });

        it("should throw HttpException when service throws", () => {
            userService.getPoolBalances.mockImplementation(() => {
                throw new Error("pool balance error");
            });

            expect(() => controller.getPoolBalances("0xUserAddress")).toThrow(HttpException);
        });
    });

    // ---------------------------------------------------------------
    // GET /api/balance/xpub/:fasset/:xpub -> returns mock balance data
    // ---------------------------------------------------------------
    describe("getXpubBalance", () => {
        it("should return a hardcoded response with zero balance and default account info", async () => {
            const result = await controller.getXpubBalance("FTestBTC", "xpub12345");

            expect(result).toEqual({
                balance: "0",
                accountInfo: {
                    depositAuth: false,
                    destTagReq: false,
                },
            });
        });

        it("should return the same response regardless of fasset parameter", async () => {
            const resultXRP = await controller.getXpubBalance("FTestXRP", "xpub_abc");
            const resultBTC = await controller.getXpubBalance("FTestBTC", "xpub_def");

            expect(resultXRP).toEqual(resultBTC);
            expect(resultXRP.balance).toBe("0");
        });

        it("should not call any service methods since it returns static data", async () => {
            await controller.getXpubBalance("FTestBTC", "xpub12345");

            expect(userService.getUnderlyingBalance).not.toHaveBeenCalled();
            expect(userService.getNativeBalances).not.toHaveBeenCalled();
            expect(userService.getPoolBalances).not.toHaveBeenCalled();
        });
    });
});
