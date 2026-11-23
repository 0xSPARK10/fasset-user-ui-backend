jest.mock("../src/logger/winston.logger", () => ({
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

describe("backend environment validation", () => {
    const originalEnv = process.env;
    let validateEnvVars: () => void;

    beforeAll(() => {
        process.env = { ...originalEnv, DB_TYPE: "sqlite" };
        ({ validateEnvVars } = require("../src/backend.server"));
    });

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            LISTEN_PORT: "3001",
            NETWORK: "coston2",
            DB_TYPE: "sqlite",
            RPC_URL: "https://rpc.example",
            NATIVE_RPC: "test-key",
        };
        delete process.env.SMART_ACCOUNTS_API_URL;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it.each([
        ["coston2", "http://smart-accounts.example"],
        ["flare", "https://smart-accounts.example/"],
    ])("accepts a valid Smart Accounts URL on %s", (network, url) => {
        process.env.NETWORK = network;
        process.env.SMART_ACCOUNTS_API_URL = url;

        expect(() => validateEnvVars()).not.toThrow();
    });

    it.each(["coston2", "flare"])("requires the Smart Accounts URL on %s", (network) => {
        process.env.NETWORK = network;

        expect(() => validateEnvVars()).toThrow("Missing required environment variables: SMART_ACCOUNTS_API_URL");
    });

    it.each(["smart-accounts.example", "ftp://smart-accounts.example"])("rejects an invalid Smart Accounts URL: %s", (url) => {
        process.env.SMART_ACCOUNTS_API_URL = url;

        expect(() => validateEnvVars()).toThrow("Invalid SMART_ACCOUNTS_API_URL");
    });

    it("does not reuse API_URL as the Smart Accounts URL", () => {
        process.env.API_URL = "https://indexer.example/api";

        expect(() => validateEnvVars()).toThrow("Missing required environment variables: SMART_ACCOUNTS_API_URL");
    });

    it.each(["coston", "songbird"])("does not require the Smart Accounts URL on %s", (network) => {
        process.env.NETWORK = network;

        expect(() => validateEnvVars()).not.toThrow();
    });
});
