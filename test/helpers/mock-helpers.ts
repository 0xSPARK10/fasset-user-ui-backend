/**
 * Common mock factories for unit and integration tests.
 *
 * Every `createMock*()` function returns a plain object whose methods are
 * `jest.fn()` stubs. Tests can override individual return values with
 * `.mockReturnValue()` / `.mockResolvedValue()` as needed.
 */

import type { EntityManager } from "@mikro-orm/core";
import type { ConfigService } from "@nestjs/config";
import type { HttpService } from "@nestjs/axios";
import type { Cache } from "@nestjs/cache-manager";
import type { EthersService } from "../../src/services/ethers.service";
import type { ContractService } from "../../src/services/contract.service";
import type { FassetConfigService, Fasset } from "../../src/services/fasset.config.service";
import type { BotService } from "../../src/services/bot.init.service";
import type { ExternalApiService } from "../../src/services/external.api.service";
import type { XRPLApiService } from "../../src/services/xrpl-api.service";
import type { PoolService } from "../../src/services/pool.service";
import type { UserService } from "../../src/services/user.service";
import type { HistoryService } from "../../src/services/userHistory.service";
import type { EarnService, EcosystemApp } from "../../src/services/earn.service";
import type { WalletService } from "../../src/services/wallet.service";
import type { VersionService } from "../../src/services/version.service";
import type { RewardsService } from "../../src/services/rewarding.service";
import type {
    IIAssetManager,
    IFAsset,
    ICollateralPool,
    ICollateralPoolToken,
    IPriceReader,
    IAgentOwnerRegistry,
} from "../../src/typechain-ethers-v6";
import type { IRelay } from "../../src/typechain-ethers-v6";
import { of } from "rxjs";

// ---------------------------------------------------------------------------
// Common test constants
// ---------------------------------------------------------------------------

/** A synthetic fasset name used across all tests */
export const TEST_FASSET = "FTestXRP";

/** A generic Ethereum-style address for a user / contract */
export const TEST_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

/** Address representing an agent vault */
export const TEST_VAULT_ADDRESS = "0xabcdef1234567890abcdef1234567890abcdef12";

/** Address representing a collateral pool */
export const TEST_POOL_ADDRESS = "0x9876543210fedcba9876543210fedcba98765432";

/** Address representing a collateral pool token */
export const TEST_TOKEN_ADDRESS = "0xfedcba9876543210fedcba9876543210fedcba98";

/** A dummy transaction hash (64 hex chars after 0x) */
export const TEST_TXHASH = "0x" + "a".repeat(64);

/** A plausible XRP Ledger address used for underlying-layer tests */
export const TEST_XRP_ADDRESS = "rN7Xg5Y9kBtNx3aeZZJvLzYgT5pJ5vH7mA";

// ---------------------------------------------------------------------------
// 1. EntityManager (MikroORM)
// ---------------------------------------------------------------------------

/**
 * Creates a mock MikroORM EntityManager with all commonly used persistence
 * and query methods stubbed out.
 */
export function createMockEntityManager(): Record<string, jest.Mock> {
    return {
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        findAndCount: jest.fn().mockResolvedValue([[], 0]),
        count: jest.fn().mockResolvedValue(0),
        persistAndFlush: jest.fn().mockResolvedValue(undefined),
        removeAndFlush: jest.fn().mockResolvedValue(undefined),
        nativeDelete: jest.fn().mockResolvedValue(0),
        flush: jest.fn().mockResolvedValue(undefined),
        fork: jest.fn().mockReturnThis(),
    };
}

// ---------------------------------------------------------------------------
// 2. ConfigService (NestJS)
// ---------------------------------------------------------------------------

/**
 * Creates a mock NestJS ConfigService. The `get` stub returns `undefined` by
 * default; override with `.mockImplementation()` to supply env values.
 */
export function createMockConfigService(
    overrides: Record<string, string> = {},
): Record<string, jest.Mock> {
    const store: Record<string, string> = {
        NETWORK: "coston2",
        APP_TYPE: "dev",
        RPC_URL: "http://localhost:8545",
        NATIVE_PRIV_KEY: "0x" + "1".repeat(64),
        NATIVE_PUB_ADDR: TEST_ADDRESS,
        ...overrides,
    };
    return {
        get: jest.fn((key: string, defaultValue?: string) => store[key] ?? defaultValue),
    };
}

// ---------------------------------------------------------------------------
// 3. HttpService (@nestjs/axios)
// ---------------------------------------------------------------------------

/**
 * Creates a mock NestJS HttpService whose `get` and `post` methods return
 * cold Observables wrapping empty-data Axios responses.
 */
export function createMockHttpService(): Record<string, jest.Mock> {
    const emptyAxiosResponse = { data: { status: 200, data: {} }, status: 200, headers: {}, config: {} };
    return {
        get: jest.fn().mockReturnValue(of(emptyAxiosResponse)),
        post: jest.fn().mockReturnValue(of(emptyAxiosResponse)),
    };
}

// ---------------------------------------------------------------------------
// 4. Cache Manager (@nestjs/cache-manager)
// ---------------------------------------------------------------------------

/**
 * Creates a mock NestJS Cache (from cache-manager) with `get` returning
 * `undefined` (miss) and `set` as a no-op.
 */
export function createMockCacheManager(): Record<string, jest.Mock> {
    return {
        get: jest.fn().mockResolvedValue(undefined),
        set: jest.fn().mockResolvedValue(undefined),
    };
}

// ---------------------------------------------------------------------------
// 5. EthersService
// ---------------------------------------------------------------------------

/**
 * Creates a mock EthersService providing a fake provider, signer, and
 * executor address.
 */
export function createMockEthersService(): Record<string, jest.Mock> {
    return {
        getProvider: jest.fn().mockReturnValue({
            getBalance: jest.fn().mockResolvedValue(0n),
            getBlock: jest.fn().mockResolvedValue({ timestamp: Math.floor(Date.now() / 1000) }),
            getTransactionReceipt: jest.fn().mockResolvedValue(null),
        }),
        getSigner: jest.fn().mockReturnValue({}),
        getExecutorAddress: jest.fn().mockReturnValue(TEST_ADDRESS),
    };
}

// ---------------------------------------------------------------------------
// 6. ContractService
// ---------------------------------------------------------------------------

/**
 * Creates a mock ContractService. The generic `get<T>()` returns a new mock
 * object by default; the typed pool/token/manager accessors return
 * pre-built mocks.
 */
export function createMockContractService(): Record<string, jest.Mock> {
    return {
        get: jest.fn().mockReturnValue({}),
        getCollateralPoolContract: jest.fn().mockReturnValue(createMockCollateralPool()),
        getCollateralPoolTokenContract: jest.fn().mockReturnValue(createMockCollateralPoolToken()),
        getAssetManagerContract: jest.fn().mockReturnValue(createMockAssetManager()),
        getPriceReaderContract: jest.fn().mockReturnValue(createMockPriceReader()),
        getFAssetContract: jest.fn().mockReturnValue(createMockFAsset()),
        getContractNames: jest.fn().mockReturnValue([]),
    };
}

// ---------------------------------------------------------------------------
// 7. FassetConfigService
// ---------------------------------------------------------------------------

/** Default fasset config returned by mock */
const DEFAULT_FASSET_CONFIG: Fasset = {
    chainId: "testXRP",
    tokenName: "FTestXRP",
    tokenSymbol: "XRP",
    tokenDecimals: 6,
};

/**
 * Creates a mock FassetConfigService with sensible defaults for a single
 * test fasset (FTestXRP).
 */
export function createMockFassetConfigService(): Record<string, jest.Mock> {
    return {
        getFAssets: jest.fn().mockReturnValue(new Map([[TEST_FASSET, DEFAULT_FASSET_CONFIG]])),
        getFAssetNames: jest.fn().mockReturnValue([TEST_FASSET]),
        getFAssetByName: jest.fn().mockReturnValue(DEFAULT_FASSET_CONFIG),
        getNativeSymbol: jest.fn().mockReturnValue("C2FLR"),
        getVerifier: jest.fn().mockReturnValue({
            getTransactionsByReference: jest.fn().mockResolvedValue([]),
            getLastFinalizedBlockNumber: jest.fn().mockResolvedValue(100),
            getBlock: jest.fn().mockResolvedValue({ number: 100, timestamp: Math.floor(Date.now() / 1000) }),
        }),
        getDataAccessLayerUrls: jest.fn().mockReturnValue(["https://dal.example.com"]),
        getWalletUrl: jest.fn().mockReturnValue("https://wallet.example.com"),
    };
}

// ---------------------------------------------------------------------------
// 8. BotService
// ---------------------------------------------------------------------------

/**
 * Creates a mock BotService with commonly read properties pre-set and all
 * public async methods stubbed.
 */
export function createMockBotService(): Record<string, jest.Mock | string[] | number | string> {
    return {
        fassetList: [TEST_FASSET],
        getEcosystemInfo: jest.fn().mockReturnValue({
            tvl: "0",
            tvlPoolsNat: "0",
            numTransactions: "0",
            numAgents: 0,
            agentsInLiquidation: 0,
            supplyByFasset: [],
            totalMinted: "0",
            numLiquidations: 0,
            rewardsAvailableUSD: "0",
            overCollaterazied: "0",
            supplyByCollateral: [],
            totalCollateral: "0",
            numMints: 0,
            totalPoolRewardsPaidUSD: "0",
            poolRewards: [],
            numHolders: 0,
            agentCollateral: "0",
            numRedeems: 0,
            coreVaultSupply: "0",
            coreVaultSupplyUSD: "0",
            coreVaultInflows: "0",
            coreVaultInflowsUSD: "0",
            coreVaultOutflows: "0",
            coreVaultOutflowsUSD: "0",
            proofOfReserve: { total: "0", totalUSD: "0", reserve: "0", reserveUSD: "0", ratio: "0" },
        }),
        getFassetDecimals: jest.fn().mockReturnValue(6),
        getAssetSymbol: jest.fn().mockReturnValue("XRP"),
        getCollateralList: jest.fn().mockReturnValue([]),
        getTimeSeries: jest.fn().mockResolvedValue({
            supplyDiff: [],
            mintGraph: [],
            redeemGraph: [],
            bestPools: [],
            totalCollateralDiff: "0",
            isPositiveCollateralDiff: false,
            coreVaultData: {
                supplyDiff: "0",
                isPositiveSupplyDiff: false,
                inflowGraph: [],
                outflowGraph: [],
                inflowDiff: "0",
                isPositiveInflowDiff: false,
                outflowDiff: "0",
                isPositiveOutflowDiff: false,
                tvlGraph: [],
            },
            proofOfReserve: [],
        }),
    };
}

// ---------------------------------------------------------------------------
// 9. ExternalApiService
// ---------------------------------------------------------------------------

/**
 * Creates a mock ExternalApiService with every public method stubbed.
 * Numeric returns default to 0, object returns default to empty / falsy.
 */
export function createMockExternalApiService(): Record<string, jest.Mock> {
    return {
        getMints: jest.fn().mockResolvedValue(0),
        getRedemptionSuccessRate: jest.fn().mockResolvedValue(0),
        getLiquidationCount: jest.fn().mockResolvedValue(0),
        getUserCollateralPoolTokens: jest.fn().mockResolvedValue({}),
        getUserTotalClaimedPoolFees: jest.fn().mockResolvedValue({}),
        getUserTotalClaimedPoolFeesSpecific: jest.fn().mockResolvedValue({}),
        getDefaultEvent: jest.fn().mockResolvedValue({ status: 200, data: {} }),
        getBlockBookHeight: jest.fn().mockResolvedValue("100"),
        getFeeEstimationBlockHeight: jest.fn().mockResolvedValue({ averageFeePerKb: 1000, decilesFeePerKb: [1000] }),
        submitTX: jest.fn().mockResolvedValue("mock-tx-hash"),
    };
}

// ---------------------------------------------------------------------------
// 10. XRPLApiService
// ---------------------------------------------------------------------------

/**
 * Creates a mock XRPLApiService with methods for account info and receive
 * blocked checks.
 */
export function createMockXRPLApiService(): Record<string, jest.Mock> {
    return {
        getAccountInfo: jest.fn().mockResolvedValue({
            data: {
                result: {
                    account_data: { Balance: "1000000" },
                    account_flags: { requireDestinationTag: false, depositAuth: false },
                },
            },
        }),
        accountReceiveBlocked: jest.fn().mockResolvedValue({
            requireDestTag: false,
            depositAuth: false,
        }),
    };
}

// ---------------------------------------------------------------------------
// 11. PoolService
// ---------------------------------------------------------------------------

/**
 * Creates a mock PoolService with all public query methods stubbed.
 */
export function createMockPoolService(): Record<string, jest.Mock> {
    return {
        getPools: jest.fn().mockResolvedValue([]),
        getAgents: jest.fn().mockResolvedValue([]),
        getAgentsLatest: jest.fn().mockResolvedValue([]),
        getPoolsSpecific: jest.fn().mockResolvedValue(undefined),
        getAgentSpecific: jest.fn().mockResolvedValue(undefined),
    };
}

// ---------------------------------------------------------------------------
// 12. UserService
// ---------------------------------------------------------------------------

/**
 * Creates a mock UserService covering the most frequently called methods.
 * Additional method stubs can be added by the caller.
 */
export function createMockUserService(): Record<string, jest.Mock> {
    return {
        listAvailableFassets: jest.fn().mockReturnValue({ fassets: [TEST_FASSET] }),
        getBestAgent: jest.fn().mockResolvedValue({
            agentAddress: TEST_VAULT_ADDRESS,
            feeBIPS: "200",
            collateralReservationFee: "1000000000000000",
            maxLots: "100",
            agentName: "TestAgent",
            underlyingAddress: TEST_XRP_ADDRESS,
            infoUrl: "",
        }),
        getMaxLots: jest.fn().mockResolvedValue({ maxLots: "100", lotsLimited: false }),
        getLotSize: jest.fn().mockResolvedValue({ lotSize: 20 }),
        getCRTFee: jest.fn().mockResolvedValue({ collateralReservationFee: "1000000000000000" }),
        getRedemptionFee: jest.fn().mockResolvedValue({ redemptionFee: "200", maxLotsOneRedemption: -1, maxRedemptionLots: -1 }),
        getProtocolFees: jest.fn().mockResolvedValue({ redemptionFee: "200" }),
        getAssetManagerAddress: jest.fn().mockResolvedValue({ address: TEST_ADDRESS }),
        getCollateralReservationFee: jest.fn().mockResolvedValue("1000000000000000"),
        getExecutorAddress: jest.fn().mockResolvedValue({ executorAddress: TEST_ADDRESS, executorFee: "100000000000000000", redemptionFee: "200" }),
        requestMinting: jest.fn().mockResolvedValue(undefined),
        mintingStatus: jest.fn().mockResolvedValue({ status: false, step: 0 }),
        requestRedemption: jest.fn().mockResolvedValue({ incomplete: false }),
        redemptionDefaultStatus: jest.fn().mockResolvedValue({ status: false }),
        getRedemptionStatus: jest.fn().mockResolvedValue({ status: "PENDING", incomplete: false, incompleteData: null }),
        getMaxWithdraw: jest.fn().mockResolvedValue({ natReturn: "0", fees: "0" }),
        getMaxCPTWithdraw: jest.fn().mockResolvedValue({ maxWithdraw: "0" }),
        getPoolBalances: jest.fn().mockResolvedValue({ balance: "0" }),
        getNativeBalances: jest.fn().mockResolvedValue([]),
        getNativeBalancesWithAddresses: jest.fn().mockResolvedValue([]),
        getUnderlyingBalance: jest.fn().mockResolvedValue({ balance: "0" }),
        getEcosystemInfo: jest.fn().mockResolvedValue({}),
        getLifetimeClaimed: jest.fn().mockResolvedValue([]),
        getTimeData: jest.fn().mockResolvedValue({}),
        getRedemptionFeeData: jest.fn().mockResolvedValue([]),
        getAssetPrice: jest.fn().mockResolvedValue({ price: 0.5 }),
        getMintingEnabled: jest.fn().mockResolvedValue([]),
        checkStateFassets: jest.fn().mockResolvedValue([]),
        getCrStatus: jest.fn().mockResolvedValue({ status: false }),
        getCREventFromTxHash: jest.fn().mockResolvedValue(undefined),
        estimateFeeForBlocks: jest.fn().mockResolvedValue({ estimatedFee: "1000", extraBTC: "0" }),
        submitTx: jest.fn().mockResolvedValue({ hash: "mock-hash" }),
        getRedemptionQueue: jest.fn().mockResolvedValue({ maxLots: 0, maxLotsOneRedemption: 0 }),
        mintingUnderlyingTransactionExists: jest.fn().mockResolvedValue(false),
    };
}

// ---------------------------------------------------------------------------
// 13. HistoryService
// ---------------------------------------------------------------------------

/**
 * Creates a mock HistoryService with the getProgress method stubbed.
 */
export function createMockHistoryService(): Record<string, jest.Mock> {
    return {
        getProgress: jest.fn().mockResolvedValue([]),
    };
}

// ---------------------------------------------------------------------------
// 14. EarnService
// ---------------------------------------------------------------------------

/**
 * Creates a mock EarnService returning an empty ecosystem list.
 */
export function createMockEarnService(): Record<string, jest.Mock> {
    return {
        getEcosystemList: jest.fn().mockReturnValue({} as Record<string, EcosystemApp>),
    };
}

// ---------------------------------------------------------------------------
// 15. WalletService
// ---------------------------------------------------------------------------

/**
 * Creates a mock WalletService for paginated wallet retrieval.
 */
export function createMockWalletService(): Record<string, jest.Mock> {
    return {
        getPaginatedWallets: jest.fn().mockResolvedValue({ count: 0, offset: 0, limit: 10, data: [] }),
    };
}

// ---------------------------------------------------------------------------
// 16. VersionService
// ---------------------------------------------------------------------------

/**
 * Creates a mock VersionService that returns a fixed version string.
 */
export function createMockVersionService(): Record<string, jest.Mock> {
    return {
        getVersion: jest.fn().mockReturnValue("1.0.0-test"),
    };
}

// ---------------------------------------------------------------------------
// 17. RewardsService
// ---------------------------------------------------------------------------

/**
 * Creates a mock RewardsService with the primary user-facing method stubbed.
 */
export function createMockRewardsService(): Record<string, jest.Mock> {
    return {
        getRewardsForUser: jest.fn().mockResolvedValue({
            claimedRflr: "0",
            claimedUsd: "0",
            claimableRflr: "0",
            claimableUsd: "0",
            points: "0",
            share: "0.0000",
            numTickets: 0,
            prevBiweeklyPlace: 500,
            prevBiweeklyRflr: "0",
            prevBiweeklyRflrUSD: "0",
            participated: false,
            rewardsDistributed: false,
        }),
    };
}

// ---------------------------------------------------------------------------
// Mock Contract Interfaces
// ---------------------------------------------------------------------------

// -- IIAssetManager --------------------------------------------------------

/**
 * Creates a mock IIAssetManager contract. The `getSettings` stub returns a
 * plausible settings struct; other stubs return safe defaults.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMockAssetManager(): Record<string, any> {
    const defaultSettings = {
        assetDecimals: 6n,
        lotSizeAMG: 20n,
        assetMintingGranularityUBA: 1000000n,
        mintingCapAMG: 0n,
        redemptionFeeBIPS: 200n,
        maxRedeemedTickets: 20n,
        priceReader: TEST_ADDRESS,
        agentOwnerRegistry: TEST_ADDRESS,
        attestationWindowSeconds: 86400n,
    };

    return {
        getSettings: jest.fn().mockResolvedValue(defaultSettings),
        getAgentInfo: jest.fn().mockResolvedValue({
            status: 0n,
            ownerManagementAddress: TEST_ADDRESS,
            collateralPool: TEST_POOL_ADDRESS,
            vaultCollateralToken: TEST_TOKEN_ADDRESS,
            feeBIPS: 200n,
            poolFeeShareBIPS: 4000n,
            mintedUBA: 0n,
            reservedUBA: 0n,
            freeCollateralLots: 100n,
            totalPoolCollateralNATWei: 0n,
            totalVaultCollateralWei: 0n,
            poolCollateralRatioBIPS: 36000n,
            vaultCollateralRatioBIPS: 25000n,
            poolExitCollateralRatioBIPS: 26000n,
            mintingPoolCollateralRatioBIPS: 24000n,
            mintingVaultCollateralRatioBIPS: 16000n,
            publiclyAvailable: true,
            underlyingAddressString: TEST_XRP_ADDRESS,
        }),
        collateralReservationFee: jest.fn().mockResolvedValue(1000000000000000n),
        getAvailableAgentsDetailedList: jest.fn().mockResolvedValue([[], 0n]),
        emergencyPaused: jest.fn().mockResolvedValue(false),
        assetPriceNatWei: jest.fn().mockResolvedValue([1n, 1n]),
        getFAssetsBackedByPool: jest.fn().mockResolvedValue(0n),
        getAddress: jest.fn().mockResolvedValue(TEST_ADDRESS),
        getCollateralTypes: jest.fn().mockResolvedValue([]),
        getCollateralType: jest.fn().mockResolvedValue({
            token: TEST_TOKEN_ADDRESS,
            decimals: 18n,
            validUntil: 0n,
            assetFtsoSymbol: "XRP",
            tokenFtsoSymbol: "testUSDC",
            collateralClass: 2n,
            minCollateralRatioBIPS: 15000n,
            ccbMinCollateralRatioBIPS: 13000n,
            safetyMinCollateralRatioBIPS: 16000n,
        }),
        getAllAgents: jest.fn().mockResolvedValue([[]]),
        mintingPaused: jest.fn().mockResolvedValue(false),
        redemptionQueue: jest.fn().mockResolvedValue([[], 0n]),
        interface: {
            decodeEventLog: jest.fn().mockReturnValue({}),
            parseLog: jest.fn().mockReturnValue(null),
        },
        target: TEST_ADDRESS,
    };
}

// -- IFAsset ---------------------------------------------------------------

/**
 * Creates a mock IFAsset contract with common token read methods.
 */
export function createMockFAsset(): Record<string, jest.Mock> {
    return {
        totalSupply: jest.fn().mockResolvedValue(0n),
        balanceOf: jest.fn().mockResolvedValue(0n),
        symbol: jest.fn().mockResolvedValue("FTestXRP"),
        assetSymbol: jest.fn().mockResolvedValue("XRP"),
        decimals: jest.fn().mockResolvedValue(6n),
        getAddress: jest.fn().mockResolvedValue(TEST_ADDRESS),
    };
}

// -- ICollateralPool -------------------------------------------------------

/**
 * Creates a mock ICollateralPool contract.
 */
export function createMockCollateralPool(): Record<string, jest.Mock> {
    return {
        totalCollateral: jest.fn().mockResolvedValue(0n),
        fAssetFeesOf: jest.fn().mockResolvedValue(0n),
        exitCollateralRatioBIPS: jest.fn().mockResolvedValue(26000n),
        poolToken: jest.fn().mockResolvedValue(TEST_TOKEN_ADDRESS),
    };
}

// -- ICollateralPoolToken --------------------------------------------------

/**
 * Creates a mock ICollateralPoolToken contract.
 */
export function createMockCollateralPoolToken(): Record<string, jest.Mock> {
    return {
        totalSupply: jest.fn().mockResolvedValue(0n),
        balanceOf: jest.fn().mockResolvedValue(0n),
        transferableBalanceOf: jest.fn().mockResolvedValue(0n),
        nonTimelockedBalanceOf: jest.fn().mockResolvedValue(0n),
    };
}

// -- IPriceReader ----------------------------------------------------------

/**
 * Creates a mock IPriceReader. `getPrice` returns a tuple-like array
 * `[price, timestamp, decimals]` matching the contract signature.
 */
export function createMockPriceReader(): Record<string, jest.Mock> {
    return {
        getPrice: jest.fn().mockResolvedValue({
            _price: 500000n,
            _timestamp: BigInt(Math.floor(Date.now() / 1000)),
            _priceDecimals: 5n,
            0: 500000n,
            1: BigInt(Math.floor(Date.now() / 1000)),
            2: 5n,
        }),
    };
}

// -- IAgentOwnerRegistry ---------------------------------------------------

/**
 * Creates a mock IAgentOwnerRegistry contract.
 */
export function createMockAgentOwnerRegistry(): Record<string, jest.Mock> {
    return {
        getAgentName: jest.fn().mockResolvedValue("TestAgent"),
        getAgentIconUrl: jest.fn().mockResolvedValue("https://example.com/icon.png"),
        getAgentDescription: jest.fn().mockResolvedValue("A test agent"),
        getAgentTermsOfUseUrl: jest.fn().mockResolvedValue("https://example.com/tos"),
    };
}

// -- IRelay ----------------------------------------------------------------

/**
 * Creates a mock IRelay contract with the voting round ID method.
 */
export function createMockRelay(): Record<string, jest.Mock> {
    return {
        getVotingRoundId: jest.fn().mockResolvedValue(100n),
    };
}
