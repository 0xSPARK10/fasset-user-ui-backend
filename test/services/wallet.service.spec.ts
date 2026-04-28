/**
 * Unit tests for WalletService.
 *
 * WalletService depends on MikroORM EntityManager and provides a
 * paginated wallet listing via getPaginatedWallets(). We mock the
 * EntityManager.findAndCount method.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { EntityManager } from "@mikro-orm/core";
import { WalletService } from "../../src/services/wallet.service";
import { Wallet } from "../../src/entities/Wallet";

describe("WalletService", () => {
    let service: WalletService;
    let em: jest.Mocked<EntityManager>;

    const mockWallets = [
        { id: 1, address: "0xWallet1", chainType: 1, walletType: 1 },
        { id: 2, address: "0xWallet2", chainType: 1, walletType: 2 },
        { id: 3, address: "rXRPWallet1", chainType: 2, walletType: 4 },
    ];

    beforeEach(async () => {
        const mockEntityManager = {
            findAndCount: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [WalletService, { provide: EntityManager, useValue: mockEntityManager }],
        }).compile();

        service = module.get<WalletService>(WalletService);
        em = module.get(EntityManager);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("getPaginatedWallets", () => {
        it("should return paginated wallet data with correct structure", async () => {
            em.findAndCount.mockResolvedValue([mockWallets, 3]);

            const result = await service.getPaginatedWallets(0, 10);

            expect(result).toEqual({
                count: 3,
                offset: 0,
                limit: 10,
                data: mockWallets,
            });
        });

        it("should call em.findAndCount with correct offset and limit", async () => {
            em.findAndCount.mockResolvedValue([[], 0]);

            await service.getPaginatedWallets(5, 20);

            expect(em.findAndCount).toHaveBeenCalledWith(Wallet, {}, { offset: 5, limit: 20 });
        });

        it("should handle offset greater than total count", async () => {
            em.findAndCount.mockResolvedValue([[], 3]);

            const result = await service.getPaginatedWallets(10, 5);

            expect(result).toEqual({
                count: 3,
                offset: 10,
                limit: 5,
                data: [],
            });
        });

        it("should return empty data array when no wallets exist", async () => {
            em.findAndCount.mockResolvedValue([[], 0]);

            const result = await service.getPaginatedWallets(0, 10);

            expect(result).toEqual({
                count: 0,
                offset: 0,
                limit: 10,
                data: [],
            });
        });

        it("should pass through different pagination parameters correctly", async () => {
            em.findAndCount.mockResolvedValue([mockWallets.slice(0, 2), 3]);

            const result = await service.getPaginatedWallets(0, 2);

            expect(result.count).toBe(3);
            expect(result.data).toHaveLength(2);
            expect(result.limit).toBe(2);
        });

        it("should handle limit of 1 correctly", async () => {
            em.findAndCount.mockResolvedValue([[mockWallets[0]], 3]);

            const result = await service.getPaginatedWallets(0, 1);

            expect(result.count).toBe(3);
            expect(result.data).toHaveLength(1);
            expect(result.limit).toBe(1);
        });
    });
});
