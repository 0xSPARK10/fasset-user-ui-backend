import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { ApiKeyGuard } from "../../src/guards/api.guard";

describe("ApiKeyGuard", () => {
    let guard: ApiKeyGuard;
    let configService: jest.Mocked<ConfigService>;

    const VALID_API_KEY = "test-admin-key-12345";

    beforeEach(async () => {
        const mockConfigService = {
            get: jest.fn().mockReturnValue(VALID_API_KEY),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [ApiKeyGuard, { provide: ConfigService, useValue: mockConfigService }],
        }).compile();

        guard = module.get<ApiKeyGuard>(ApiKeyGuard);
        configService = module.get(ConfigService);
    });

    /** Helper to create a mock ExecutionContext with a given x-api-key header */
    function createMockContext(apiKey?: string): ExecutionContext {
        const headers: Record<string, string> = {};
        if (apiKey !== undefined) {
            headers["x-api-key"] = apiKey;
        }
        return {
            switchToHttp: () => ({
                getRequest: () => ({ headers }),
            }),
        } as unknown as ExecutionContext;
    }

    it("should be defined", () => {
        expect(guard).toBeDefined();
    });

    describe("canActivate", () => {
        it("should return true when a valid API key is provided", () => {
            const context = createMockContext(VALID_API_KEY);
            expect(guard.canActivate(context)).toBe(true);
        });

        it("should throw UnauthorizedException when no API key is provided", () => {
            const context = createMockContext(undefined);
            expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
        });

        it("should throw UnauthorizedException when an empty API key is provided", () => {
            const context = createMockContext("");
            expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
        });

        it("should throw UnauthorizedException when an invalid API key is provided", () => {
            const context = createMockContext("wrong-key");
            expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
        });

        it("should throw UnauthorizedException with descriptive message", () => {
            const context = createMockContext("bad-key");
            expect(() => guard.canActivate(context)).toThrow("Invalid or missing API key for admin");
        });

        it("should read ADMIN_API_KEY from ConfigService", () => {
            const context = createMockContext(VALID_API_KEY);
            guard.canActivate(context);
            expect(configService.get).toHaveBeenCalledWith("ADMIN_API_KEY");
        });

        it("should reject when config returns undefined for ADMIN_API_KEY", () => {
            configService.get.mockReturnValue(undefined);
            const context = createMockContext("any-key");
            expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
        });
    });
});
