/**
 * Unit tests for VersionService.
 *
 * VersionService reads the project version from package.json during
 * onModuleInit() and exposes it via getVersion(). We mock fs.readFileSync
 * so no real file I/O occurs.
 */
import { Test, TestingModule } from "@nestjs/testing";

/* ---- mock the fs module before importing the service ---- */
jest.mock("fs", () => ({
    readFileSync: jest.fn().mockReturnValue(JSON.stringify({ version: "1.3.1" })),
}));

import { VersionService } from "../../src/services/version.service";
import * as fs from "fs";

describe("VersionService", () => {
    let service: VersionService;

    beforeEach(async () => {
        jest.clearAllMocks();

        const module: TestingModule = await Test.createTestingModule({
            providers: [VersionService],
        }).compile();

        service = module.get<VersionService>(VersionService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("onModuleInit", () => {
        it("should load version from package.json", () => {
            service.onModuleInit();
            expect(fs.readFileSync).toHaveBeenCalledTimes(1);
            // The path argument should end with package.json
            const callArg = (fs.readFileSync as jest.Mock).mock.calls[0][0] as string;
            expect(callArg).toContain("package.json");
        });

        it("should set the version correctly after init", () => {
            service.onModuleInit();
            expect(service.getVersion()).toBe("1.3.1");
        });
    });

    describe("getVersion", () => {
        it("should return undefined before onModuleInit is called", () => {
            expect(service.getVersion()).toBeUndefined();
        });

        it("should return the version string after onModuleInit", () => {
            service.onModuleInit();
            expect(service.getVersion()).toBe("1.3.1");
        });

        it("should return updated version when package.json changes", () => {
            (fs.readFileSync as jest.Mock).mockReturnValueOnce(JSON.stringify({ version: "2.0.0" }));
            service.onModuleInit();
            expect(service.getVersion()).toBe("2.0.0");
        });
    });
});
