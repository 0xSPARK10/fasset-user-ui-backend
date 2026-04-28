/* ---- mock heavy transitive dependencies before any imports ---- */
jest.mock("src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { Test, TestingModule } from "@nestjs/testing";
import { HttpException, HttpStatus } from "@nestjs/common";
import { VersionController } from "src/controllers/version.controller";
import { VersionService } from "src/services/version.service";

describe("VersionController", () => {
    let controller: VersionController;
    let versionService: jest.Mocked<Partial<VersionService>>;

    beforeEach(async () => {
        /** Mock VersionService with the getVersion method */
        const mockVersionService = {
            getVersion: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [VersionController],
            providers: [{ provide: VersionService, useValue: mockVersionService }],
        }).compile();

        controller = module.get<VersionController>(VersionController);
        versionService = module.get(VersionService);
    });

    it("should be defined", () => {
        expect(controller).toBeDefined();
    });

    // ---------------------------------------------------------------
    // GET /api/version -> versionService.getVersion()
    // ---------------------------------------------------------------
    describe("getVersion", () => {
        it("should return the version string from the service", () => {
            versionService.getVersion.mockReturnValue("1.3.1");

            const result = controller.getVersion();

            expect(result).toBe("1.3.1");
            expect(versionService.getVersion).toHaveBeenCalledTimes(1);
        });

        it("should return whatever version string the service provides", () => {
            versionService.getVersion.mockReturnValue("2.0.0-beta");

            const result = controller.getVersion();

            expect(result).toBe("2.0.0-beta");
        });

        it("should throw HttpException when service throws", () => {
            versionService.getVersion.mockImplementation(() => {
                throw new Error("version error");
            });

            expect(() => controller.getVersion()).toThrow(HttpException);
        });

        it("should include INTERNAL_SERVER_ERROR status on error", () => {
            versionService.getVersion.mockImplementation(() => {
                throw new Error("failure");
            });

            try {
                controller.getVersion();
            } catch (error) {
                expect(error).toBeInstanceOf(HttpException);
                expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
            }
        });

        it("should include the original error message in the HttpException response", () => {
            versionService.getVersion.mockImplementation(() => {
                throw new Error("cannot read package.json");
            });

            try {
                controller.getVersion();
            } catch (error) {
                const response = error.getResponse();
                expect(response.error).toContain("cannot read package.json");
            }
        });
    });
});
