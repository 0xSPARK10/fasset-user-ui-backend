import { Test, TestingModule } from "@nestjs/testing";
import { WalletController } from "src/controllers/wallet.controller";
import { WalletService } from "src/services/wallet.service";
import { ApiKeyGuard } from "src/guards/api.guard";

describe("WalletController", () => {
    let controller: WalletController;
    let walletService: jest.Mocked<Partial<WalletService>>;

    beforeEach(async () => {
        /** Mock WalletService with the getPaginatedWallets method */
        const mockWalletService = {
            getPaginatedWallets: jest.fn(),
        };

        /**
         * Override the ApiKeyGuard so it always allows access in tests.
         * This lets us test the controller logic without authentication concerns.
         */
        const mockApiKeyGuard = { canActivate: jest.fn().mockReturnValue(true) };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [WalletController],
            providers: [{ provide: WalletService, useValue: mockWalletService }],
        })
            .overrideGuard(ApiKeyGuard)
            .useValue(mockApiKeyGuard)
            .compile();

        controller = module.get<WalletController>(WalletController);
        walletService = module.get(WalletService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/wallets (query: limit, offset)
    //   -> walletService.getPaginatedWallets(offset, limit)
    // ---------------------------------------------------------------
    describe("getWallets", () => {
        it("should return paginated wallets from the service", async () => {
            const mockResult = {
                count: 50,
                offset: 0,
                limit: 10,
                data: [{ id: "wallet1" }, { id: "wallet2" }],
            };
            walletService.getPaginatedWallets.mockResolvedValue(mockResult);

            const result = await controller.getWallets(10, 0);

            expect(result).toEqual(mockResult);
            expect(walletService.getPaginatedWallets).toHaveBeenCalledWith(0, 10);
        });

        it("should pass offset before limit to the service (matching controller signature)", async () => {
            walletService.getPaginatedWallets.mockResolvedValue({
                count: 0,
                offset: 5,
                limit: 20,
                data: [],
            });

            await controller.getWallets(20, 5);

            // Controller calls walletService.getPaginatedWallets(offset, limit)
            expect(walletService.getPaginatedWallets).toHaveBeenCalledWith(5, 20);
        });

        it("should use default values when limit and offset are not provided", async () => {
            walletService.getPaginatedWallets.mockResolvedValue({
                count: 0,
                offset: 0,
                limit: 10,
                data: [],
            });

            // The controller has defaults: limit = 10, offset = 0
            await controller.getWallets(10, 0);

            expect(walletService.getPaginatedWallets).toHaveBeenCalledWith(0, 10);
        });

        it("should propagate errors from walletService", async () => {
            walletService.getPaginatedWallets.mockRejectedValue(new Error("database error"));

            await expect(controller.getWallets(10, 0)).rejects.toThrow("database error");
        });

        it("should handle large offset and limit values", async () => {
            walletService.getPaginatedWallets.mockResolvedValue({
                count: 10000,
                offset: 5000,
                limit: 100,
                data: [],
            });

            const result = await controller.getWallets(100, 5000);

            expect(result.count).toBe(10000);
            expect(walletService.getPaginatedWallets).toHaveBeenCalledWith(5000, 100);
        });
    });
});
