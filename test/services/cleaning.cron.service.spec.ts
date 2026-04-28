/**
 * Unit tests for CleaningService.
 *
 * CleaningService runs scheduled cron jobs to delete old and expired
 * entities from the database. We mock MikroORM and its forked
 * EntityManager to verify correct entity types and timestamp filters.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { MikroORM, EntityManager } from "@mikro-orm/core";
import { CleaningService } from "../../src/services/cleaning.cron.service";
import { Minting } from "../../src/entities/Minting";
import { Redemption } from "../../src/entities/Redemption";
import { FullRedemption } from "../../src/entities/RedemptionWhole";
import { RedemptionDefault } from "../../src/entities/RedemptionDefault";
import { IncompleteRedemption } from "../../src/entities/RedemptionIncomplete";
import { GuidRedemption } from "../../src/entities/OFTRedemptionGUID";
import { OFTReceived } from "../../src/entities/OFTReceived";
import { OFTSent } from "../../src/entities/OFTSent";
import { CollateralReservationEvent } from "../../src/entities/CollateralReservation";
import { OFTRedemption } from "../../src/entities/OFTRedemption";

/* ---- mock logger to suppress output in tests ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    },
}));

describe("CleaningService", () => {
    let service: CleaningService;
    let mockEm: { nativeDelete: jest.Mock };

    beforeEach(async () => {
        mockEm = {
            nativeDelete: jest.fn().mockResolvedValue(0),
        };

        const mockOrm = {
            em: {
                fork: jest.fn().mockReturnValue(mockEm),
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [CleaningService, { provide: MikroORM, useValue: mockOrm }],
        }).compile();

        service = module.get<CleaningService>(CleaningService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("deleteOldMintingsREdemptions", () => {
        it("should call nativeDelete for all 10 entity types", async () => {
            await service.deleteOldMintingsREdemptions();

            expect(mockEm.nativeDelete).toHaveBeenCalledTimes(10);
        });

        it("should delete Minting entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const mintingCall = mockEm.nativeDelete.mock.calls.find((call) => call[0] === Minting);
            expect(mintingCall).toBeDefined();
            expect(mintingCall[1]).toHaveProperty("timestamp");
            expect(mintingCall[1].timestamp).toHaveProperty("$lt");
            // Verify the timestamp is roughly 7 days ago (within 5 seconds tolerance)
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
            const expectedThreshold = Date.now() - sevenDaysMs;
            expect(Math.abs(mintingCall[1].timestamp.$lt - expectedThreshold)).toBeLessThan(5000);
        });

        it("should delete Redemption entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === Redemption);
            expect(call).toBeDefined();
            expect(call[1].timestamp).toHaveProperty("$lt");
        });

        it("should delete FullRedemption entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === FullRedemption);
            expect(call).toBeDefined();
        });

        it("should delete RedemptionDefault entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === RedemptionDefault);
            expect(call).toBeDefined();
        });

        it("should delete IncompleteRedemption entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === IncompleteRedemption);
            expect(call).toBeDefined();
        });

        it("should delete GuidRedemption entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === GuidRedemption);
            expect(call).toBeDefined();
        });

        it("should delete OFTReceived entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === OFTReceived);
            expect(call).toBeDefined();
        });

        it("should delete OFTSent entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === OFTSent);
            expect(call).toBeDefined();
        });

        it("should delete CollateralReservationEvent entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === CollateralReservationEvent);
            expect(call).toBeDefined();
        });

        it("should delete OFTRedemption entities older than 7 days", async () => {
            await service.deleteOldMintingsREdemptions();

            const call = mockEm.nativeDelete.mock.calls.find((call) => call[0] === OFTRedemption);
            expect(call).toBeDefined();
        });

        it("should use the same 7-day threshold for all entity types", async () => {
            await service.deleteOldMintingsREdemptions();

            const timestamps = mockEm.nativeDelete.mock.calls.map((call) => call[1].timestamp.$lt);
            // All timestamps should be identical (same weekTimeStamp used for all)
            const uniqueTimestamps = new Set(timestamps);
            expect(uniqueTimestamps.size).toBe(1);
        });

        it("should handle nativeDelete errors gracefully and not throw", async () => {
            mockEm.nativeDelete.mockRejectedValueOnce(new Error("DB connection lost"));

            await expect(service.deleteOldMintingsREdemptions()).resolves.toBeUndefined();
        });
    });

    describe("deleteExpiredUnprocessedMintingsREdemptions", () => {
        it("should call nativeDelete once for unprocessed Minting entities", async () => {
            await service.deleteExpiredUnprocessedMintingsREdemptions();

            expect(mockEm.nativeDelete).toHaveBeenCalledTimes(1);
        });

        it("should delete unprocessed Minting entities older than 1 day", async () => {
            await service.deleteExpiredUnprocessedMintingsREdemptions();

            expect(mockEm.nativeDelete).toHaveBeenCalledWith(Minting, expect.objectContaining({ processed: false }));

            const call = mockEm.nativeDelete.mock.calls[0];
            const filter = call[1];
            expect(filter.timestamp).toHaveProperty("$lt");

            // Verify the timestamp is roughly 1 day ago (within 5 seconds tolerance)
            const oneDayMs = 24 * 60 * 60 * 1000;
            const expectedThreshold = Date.now() - oneDayMs;
            expect(Math.abs(filter.timestamp.$lt - expectedThreshold)).toBeLessThan(5000);
        });

        it("should use Minting entity class in the delete call", async () => {
            await service.deleteExpiredUnprocessedMintingsREdemptions();

            expect(mockEm.nativeDelete.mock.calls[0][0]).toBe(Minting);
        });

        it("should filter by processed: false", async () => {
            await service.deleteExpiredUnprocessedMintingsREdemptions();

            const filter = mockEm.nativeDelete.mock.calls[0][1];
            expect(filter.processed).toBe(false);
        });
    });
});
