/**
 * Unit tests for EthersService.
 *
 * EthersService wraps ethers.JsonRpcProvider and ethers.Wallet, reading
 * configuration values from ConfigService during construction. We mock the
 * entire ethers module so that no real network calls are made.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

/* ---- mock ethers before importing the service ---- */
const mockProvider = { getNetwork: jest.fn() };
const mockWallet = { address: "0xMockAddress" };
const mockFetchRequest = { setHeader: jest.fn() };

jest.mock("ethers", () => ({
    ethers: {
        JsonRpcProvider: jest.fn().mockImplementation(() => mockProvider),
        Wallet: jest.fn().mockImplementation(() => mockWallet),
    },
    FetchRequest: jest.fn().mockImplementation(() => mockFetchRequest),
}));

import { EthersService } from "../../src/services/ethers.service";

describe("EthersService", () => {
    let service: EthersService;
    let configService: jest.Mocked<ConfigService>;

    const ENV_VALUES: Record<string, string> = {
        RPC_URL: "https://rpc.example.com",
        NATIVE_RPC: "test-api-key",
        NETWORK: "coston2",
        NATIVE_PRIV_KEY: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        APP_TYPE: "dev",
        NATIVE_PUB_ADDR: "0xPubAddr123",
    };

    beforeEach(async () => {
        const mockConfigService = {
            get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
                return ENV_VALUES[key] ?? defaultValue ?? undefined;
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [EthersService, { provide: ConfigService, useValue: mockConfigService }],
        }).compile();

        service = module.get<EthersService>(EthersService);
        configService = module.get(ConfigService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("constructor", () => {
        it("should read all required config values from ConfigService", () => {
            expect(configService.get).toHaveBeenCalledWith("RPC_URL", "");
            expect(configService.get).toHaveBeenCalledWith("NATIVE_RPC", "");
            expect(configService.get).toHaveBeenCalledWith("NETWORK", "coston2");
            expect(configService.get).toHaveBeenCalledWith("NATIVE_PRIV_KEY", "");
            expect(configService.get).toHaveBeenCalledWith("APP_TYPE");
            expect(configService.get).toHaveBeenCalledWith("NATIVE_PUB_ADDR", "");
        });

        it("should set API key headers on the FetchRequest when NATIVE_RPC is defined", () => {
            expect(mockFetchRequest.setHeader).toHaveBeenCalledWith("x-api-key", "test-api-key");
            expect(mockFetchRequest.setHeader).toHaveBeenCalledWith("x-apikey", "test-api-key");
        });
    });

    describe("getProvider", () => {
        it("should return the JsonRpcProvider instance", () => {
            const provider = service.getProvider();
            expect(provider).toBe(mockProvider);
        });
    });

    describe("getSigner", () => {
        it("should return the Wallet instance", () => {
            const signer = service.getSigner();
            expect(signer).toBe(mockWallet);
        });
    });

    describe("getExecutorAddress", () => {
        it("should return the NATIVE_PUB_ADDR from config", () => {
            const address = service.getExecutorAddress();
            expect(address).toBe("0xPubAddr123");
        });
    });
});
