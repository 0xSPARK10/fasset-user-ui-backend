# Development Log

## 2026-02-19
- Added env var startup validation in backend.server.ts: `validateEnvVars()` checks 7 always-required vars (LISTEN_PORT, NETWORK, DB_TYPE, BOT_CONFIG_PATH, RPC_URL, NATIVE_RPC, DAL_URLS), 5 PostgreSQL-specific vars when DB_TYPE=postgresql, and warns about 24 optional service-specific vars.
- Controller cleanup across 5 controllers:
  - mint.controller: Removed eslint-disable directive and dead commented-out swagger decorator
  - user.controller: Removed test endpoint, fixed wrong ApiResponse type on getUnderlyingStatus (ExecutorResponse→Boolean), removed dead commented-out decorators
  - pool.controller: Added missing logger.error and @ApiResponse decorators on getPoolsSpecific and getAgentSpecific
  - rewards.controller: Removed dead commented-out @ApiResponse
  - redemption.controller: Removed dead commented-out @ApiResponse on getRedemptionQueue, added missing @ApiResponse on requestRedemptionDefault
- Refactored RunnerService gas handling: sendTransactionWithRetry now re-estimates gas on each attempt with escalating buffer (130% → 140% → 150%). withdrawWNAT also uses it for retry + escalation.
- Fixed FAsset contract lookup in BotService: removed incorrect `FAsset_` prefix (deployment uses fasset name directly)
- Removed secrets.json dependency — all API keys now come from env vars:
  - XRPLApiService: Uses XRP_WALLET_URLS and XRP_RPC env vars instead of bot config + secrets.json
  - RewardsService: Uses DAL_API_KEYS env var instead of botService.getSecrets()
  - BotService: Removed getSecrets(), Secrets class, and secrets.json loading
  - Removed SecretsFile, ChainAccount, DatabaseAccount types from constants.ts
- Service initialization audit — eliminated redundant file reads and inconsistent env access:
  - FassetConfigService: Added bot config parsing in constructor to expose dataAccessLayerUrls and per-fasset walletUrls
  - RewardsService: Replaced bot config file read with FassetConfigService.getDataAccessLayerUrls()
  - DalService: Replaced process.env.DAL_URLS/DAL_API_KEYS with ConfigService.get() for consistency
- Removed all @flarelabs/fasset-bots and @flarelabs/fasset-bots-core imports from src/:
  - src/utils/utils.ts: Removed BN, BNish, toBN, toBNExp, formatFixed, AMGSettings, AMG_TOKENWEI_PRICE_SCALE imports. Added local AMGSettings interface and AMG_TOKENWEI_PRICE_SCALE constant. Converted convertAmgToUBA, convertTokenWeiToAMG, convertTokenWeiToUBA to BigInt. Converted usdStringToBN/bnToUsdString/sumUsdStrings to use BigInt internally. Removed duplicate BN functions (formatBNToDisplayDecimals, formatBNToStringForceDecimals, toBNDecimal, calculateUSDValue) — BigInt versions already exist.
  - src/utils/dashboard.utils.ts: Replaced formatFixed(toBN(...)) with formatFixedBigInt(BigInt(...))
  - src/services/userHistory.service.ts: Replaced toBN with BigInt, formatBNToDisplayDecimals with formatBigIntToDisplayDecimals
  - src/services/rewarding.service.ts: Replaced toBN/toBNExp/formatFixed with BigInt/bigintPow10/formatFixedBigInt across all price calculations
  - src/services/xrpl-api.service.ts: Replaced Secrets.load() with readFileSync + JSON.parse
  - src/interfaces/structure.ts: Removed unused BN import and Price interface (replaced by PriceBigInt)

## 2026-02-18
- Optimized DalService and VerifierService API calls:
  - Reduced axios timeout from 10s to 5s and retries from 3 to 2
  - Replaced sequential client fallback with Promise.any (race all clients in parallel)
  - Parallelized latestFinalizedRoundOnDal with Promise.allSettled
  - Removed double retry layer in VerifierService.getTransactionsByReference
- Optimized OFTService.getOFTHistory:
  - Parallelized initial 3 DB queries with Promise.all
  - Batch-fetched OFTReceived, RedemptionDefault, and Collateral before loop with $in queries
  - Replaced O(n) linear scans with Map lookups
- Refactored OFT module to use new IFAssetRedeemComposer contract:
  - Replaced RedemptionTriggered event reading with FAssetRedeemed from IFAssetRedeemComposer
  - Changed from GuidRedemption to OFTRedemption entity for storing redemption data directly
  - Added getComposerFeePPM and getRedeemerAccountAddress contract call methods to event reader service
  - Added getComposerFee and getRedeemerAccountAddress endpoints to OFT controller with typed Swagger responses
  - Created OFTRedemptionProcessor service that checks verifier for payments and DB for default/blocked events
  - Updated OFT history to read from OFTRedemption entities, replaced toBN with BigInt utilities
  - Registered OFTRedemption entity in mikro-orm.config and app.module

## 2026-02-17
- Generated comprehensive SPECIFICATION.md from source code analysis and existing fasset-user-ui-api.md reference. Covers all 40+ API endpoints across 10 controllers, 19 database entities, 17 services, background processing flows, minting/redemption flows, OFT cross-chain module, smart contract integration, and configuration.
