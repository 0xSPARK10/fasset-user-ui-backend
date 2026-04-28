# FAsset User UI Backend - API Specification

## Table of Contents

- [1. Overview](#1-overview)
- [2. Architecture](#2-architecture)
- [3. Configuration & Environment](#3-configuration--environment)
- [4. API Endpoints](#4-api-endpoints)
  - [4.1 User Endpoints](#41-user-endpoints)
  - [4.2 Minting Endpoints](#42-minting-endpoints)
  - [4.3 Redemption Endpoints](#43-redemption-endpoints)
  - [4.4 Balance Endpoints](#44-balance-endpoints)
  - [4.5 Pool Endpoints](#45-pool-endpoints)
  - [4.6 OFT Endpoints](#46-oft-endpoints-cross-chain)
  - [4.7 Earn Endpoints](#47-earn-endpoints)
  - [4.8 Wallet Endpoints](#48-wallet-endpoints)
  - [4.9 Utility Endpoints](#49-utility-endpoints)
- [5. Database Schema](#5-database-schema)
- [6. Services](#6-services)
- [7. Background Processing](#7-background-processing)
- [8. Minting Flow](#8-minting-flow)
- [9. Redemption Flow](#9-redemption-flow)
- [10. OFT Cross-Chain Module](#10-oft-cross-chain-module)
- [11. Smart Contract Integration](#11-smart-contract-integration)

---

## 1. Overview

NestJS backend for the Flare Network FAsset minting/redemption application. It provides APIs for:

- Minting FAssets (FXRP, FBTC, FDOGE) by wrapping underlying chain assets
- Redeeming FAssets back to underlying chain assets
- Managing collateral pools (enter, exit, view balances)
- Querying balances (native FLR/CFLR tokens, underlying chain tokens, pool tokens)
- Agent selection and information
- Ecosystem dashboard data (TVL, supply, time-series)
- Cross-chain OFT (Omnichain Fungible Token) operations via LayerZero

**Supported Networks:** coston, coston2, songbird, flare

**Supported FAssets:**
| Symbol | Mainnet | Testnet |
|--------|---------|---------|
| XRP | FXRP | FTestXRP |
| BTC | FBTC | FTestBTC |
| DOGE | FDOGE | FTestDOGE |

---

## 2. Architecture

```
src/
├── app.module.ts                  # Main NestJS module
├── backend.server.ts              # Server bootstrap (CORS, Helmet, Swagger)
├── main.ts                        # Entry point
├── controllers/                   # 10 API route controllers
├── services/                      # Core business logic
├── entities/                      # 19 MikroORM database entities
├── interfaces/                    # Request/response DTOs & type definitions
├── utils/                         # Helpers, constants, ORM config
├── guards/                        # API key authentication guard
├── health/                        # Database health indicator
├── logger/                        # Winston logger + middleware
├── oft/                           # OFT module (Flare & Coston2 only)
├── configs/                       # Network config JSON files
├── deploys/                       # Contract deployment JSON files
├── typechain-ethers-v6/           # Generated smart contract type bindings
└── artifacts/                     # Contract ABIs
```

**Key Technologies:**
- NestJS framework
- MikroORM (SQLite dev / MySQL production)
- ethers.js v6 for blockchain interaction
- Swagger/OpenAPI documentation at `{ROOT_PATH}api-doc`
- Winston logging
- Helmet security headers
- CORS enabled globally

---

## 3. Configuration & Environment

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `NETWORK` | Target network | `coston`, `coston2`, `flare`, `songbird` |
| `LISTEN_PORT` | Server port | `1235` |
| `RPC_URL` | Blockchain RPC endpoint | `https://flare-api.flare.network/ext/C/rpc` |
| `NATIVE_RPC` | Optional RPC API key (sent as header) | |
| `NATIVE_PRIV_KEY` | Executor wallet private key | |
| `NATIVE_PUB_ADDR` | Executor wallet public address | |
| `APP_TYPE` | Application mode | `dev` or `production` |
| `ROOT_PATH` | Global API prefix path | `/v1/` |
| `BTC_INDEXER` | Blockbook BTC indexer URL | |
| `DOGE_INDEXER` | Blockbook DOGE indexer URL | |
| `API_URL` | Flare Dashboard API URL | |
| `BOT_CONFIG_PATH` | Path to bot config JSON | |
| `DAL_URLS` | Comma-separated DAL endpoint URLs | |
| `DAL_API_KEYS` | Comma-separated DAL API keys | |
| `VERIFIER_URLS` | Comma-separated verifier URLs | |
| `VERIFIER_API_KEYS` | Comma-separated verifier API keys | |
| `EARN_JSON_URL` | URL to ecosystem apps JSON | |

### Authentication

- **API Key Guard:** Applied to `/api/wallets` endpoint only. Requires `x-api-key` header.

---

## 4. API Endpoints

All endpoints are prefixed with the configured `ROOT_PATH`. Default base path is `/api/`.

### 4.1 User Endpoints

**Tag:** `User`

---

#### `GET /api/fassets`

Returns list of available FAssets on the current network.

**Response:** `AvailableFassets`
```json
{
  "fassets": ["FTestXRP", "FTestBTC", "FTestDOGE"]
}
```

---

#### `GET /api/agent/:fasset/:lots`

Returns the best agent for minting the specified number of lots. Selection is based on lowest fee and sufficient collateral.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol (e.g. `FTestXRP`) |
| `lots` | number | Number of lots to mint |

**Response:** `BestAgent`
```json
{
  "agentAddress": "0x3f93AaC4BbC64D574B9C3F6FbCe0842148d834F4",
  "feeBIPS": "50",
  "collateralReservationFee": "1542931785195936139",
  "maxLots": "155",
  "agentName": "Forevernode",
  "underlyingAddress": "rMxqeqUoeD4faxdaKKAARYwm7711rVZ92x",
  "infoUrl": "www.forevernode.com"
}
```

---

#### `GET /api/agents/:fasset`

Returns all available agents for a specific FAsset with basic info.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `AgentPoolLatest[]`
```json
[
  {
    "vault": "0x1b3Ac6669E1C7D4974C8BDa1CF982c39Ab83301F",
    "totalPoolCollateral": "17,617,195.121",
    "poolCR": "2.40",
    "vaultCR": "1.67",
    "feeShare": "40",
    "agentName": "Amsterdam",
    "vaultType": "FTestXRP",
    "poolExitCR": "2.60",
    "freeLots": "100",
    "status": "false",
    "health": 0,
    "url": "https://example.com/image.jpg",
    "mintFee": "0.35",
    "feeBIPS": "35",
    "underlyingAddress": "rMxqeqUoeD4faxdaKKAARYwm7711rVZ92x"
  }
]
```

**Health values:**
| Value | Meaning |
|-------|---------|
| 0 | Healthy |
| 1 | CCB (Collateral Call Band) |
| 2 | In Liquidation |
| 3 | In Full Liquidation |
| 4 | Closing |

---

#### `GET /api/assetManagerAddress/:fasset`

Returns the asset manager contract address for a FAsset.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `AddressResponse`
```json
{
  "address": "0xc49d729Ed92D2B6659e4848d92f93695a0b43d4a"
}
```

---

#### `GET /api/executor/:fasset`

Returns executor address, executor fee (in wei), and redemption fee (in BIPS).

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `ExecutorResponse`
```json
{
  "executorAddress": "0x745D1C6176757DA4fdE964F6310163A62591695f",
  "executorFee": "2500000000000000000",
  "redemptionFee": "10"
}
```

---

#### `GET /api/userProgress/:address`

Returns the user's mint and redeem history (7-day rolling window).

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `address` | string | User's FLR/CFLR address |

**Response:** `Progress[]`
```json
[
  {
    "action": "MINT",
    "timestamp": 1726075112022,
    "amount": "1,000",
    "fasset": "FTestXRP",
    "status": true,
    "txhash": "50F603F3535DC6FAA9EFA2BAC043A463D92D34E0FF29AA6BB8EBC9BE12EE64D4",
    "defaulted": false,
    "incomplete": false,
    "remainingLots": null
  },
  {
    "action": "REDEEM",
    "timestamp": 1726075843671,
    "amount": "1,000",
    "fasset": "FTestXRP",
    "status": true,
    "defaulted": true,
    "txhash": "0x15eac1b887e58238391de079fe0f4a458d06b8d6b6ca3016f2f882117f574bc8",
    "ticketID": "16550138",
    "vaultToken": "testUSDT",
    "vaultTokenValueRedeemed": "365.343",
    "poolTokenValueRedeemed": "0",
    "underlyingPaid": "0",
    "incomplete": false,
    "remainingLots": null
  }
]
```

**Progress fields:**
| Field | Type | Description |
|-------|------|-------------|
| `action` | string | `"MINT"` or `"REDEEM"` |
| `timestamp` | number | Unix timestamp in milliseconds |
| `amount` | string | Formatted amount requested |
| `fasset` | string | FAsset symbol |
| `status` | boolean | `true` if completed |
| `defaulted` | boolean | `true` if redemption defaulted |
| `txhash` | string | Underlying tx hash (MINT) or FLR tx hash (REDEEM) |
| `ticketID` | string? | Redemption ticket ID (REDEEM only) |
| `vaultToken` | string? | Vault collateral token symbol (if defaulted) |
| `vaultTokenValueRedeemed` | string? | Vault collateral amount paid (if defaulted) |
| `poolTokenValueRedeemed` | string? | Pool collateral amount paid (if defaulted) |
| `underlyingPaid` | string? | Underlying amount paid for redemption |
| `incomplete` | boolean? | `true` if redemption was partial |
| `remainingLots` | string? | Unredeemed lots if incomplete |
| `missingUnderlying` | boolean? | `true` if underlying tx not yet detected |
| `underlyingTransactionData` | object? | Mint payment details if underlying tx pending |
| `redemptionBlocked` | boolean? | `true` if redemption payment was blocked |

---

#### `GET /api/lifetimeClaimed/:address`

Returns lifetime claimed pool rewards for a user address.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `address` | string | User's FLR/CFLR address |

---

#### `GET /api/timeData/:time`

Returns time-series dashboard data for a specified time scope.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `time` | string | Time scope: `day`, `week`, `month`, `year`, `ytd`, `all` |

**Response:** `TimeData`
```json
{
  "supplyDiff": [
    { "fasset": "FXRP", "diff": "1,234.56", "isPositive": true }
  ],
  "mintGraph": [
    { "timestamp": 1726075112022, "value": "100" }
  ],
  "redeemGraph": [
    { "timestamp": 1726075112022, "value": "50" }
  ],
  "bestPools": [
    {
      "name": "Super Mario",
      "vaultAddress": "0x...",
      "poolAddress": "0x...",
      "fasset": "FXRP",
      "collateralSymbol": "FLR",
      "tvl": "10,000.00",
      "rewardsPaid": "500.00",
      "url": "https://example.com/image.png",
      "tvlDiff": "100.00",
      "tvlDiffPositive": true,
      "rewardsDiff": "50.00",
      "rewardsDiffPositive": true
    }
  ],
  "totalCollateralDiff": "5,000.00",
  "isPositiveCollateralDiff": true,
  "coreVaultData": {
    "supplyDiff": "200.00",
    "isPositiveSupplyDiff": true,
    "inflowGraph": [],
    "outflowGraph": [],
    "tvlGraph": [],
    "inflowDiff": "100.00",
    "isPositiveInflowDiff": true,
    "outflowDiff": "50.00",
    "isPositiveOutflowDiff": false
  }
}
```

---

#### `GET /api/fassetState`

Returns current state/status of all FAssets.

---

#### `GET /api/fassetPrice/:fasset`

Returns the current USD price for a FAsset.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `AssetPrice`
```json
{
  "price": 0.53
}
```

---

#### `GET /api/underlyingStatus/:fasset/:paymentReference`

Checks whether an underlying transaction exists for a given payment reference (used to verify minting payments).

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `paymentReference` | string | Payment reference from collateral reservation |

**Response:** `boolean`

---

#### `GET /api/test`

Test/debug endpoint. Returns variable test data.

---

### 4.2 Minting Endpoints

**Tag:** `Minting`

---

#### `GET /api/maxLots/:fasset`

Returns the maximum number of lots available to mint for a FAsset.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `MaxLots`
```json
{
  "maxLots": "66",
  "lotsLimited": true
}
```

---

#### `GET /api/lotSize/:fasset`

Returns the lot size for a FAsset (amount of underlying per lot).

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `LotSize`
```json
{
  "lotSize": 20
}
```

---

#### `GET /api/getCrEvent/:fasset/:txhash`

Gets the collateral reservation event data from a reserve collateral transaction hash. Called after the first minting transaction.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `txhash` | string | Transaction hash of the reserve collateral call |

**Response:** `CREvent`
```json
{
  "collateralReservationId": "87390",
  "paymentAmount": "40100",
  "paymentAddress": "rajgVNW9b4H4ifvB1238kfgsSJYesXwwtv",
  "paymentReference": "0x464250526641000100000000000000000000000000000000000000000007f625",
  "lastUnderlyingBlock": "123456",
  "expirationMinutes": "123"
}
```

---

#### `GET /api/getCrStatus/:crId`

Gets the collateral reservation status by CR ID. Used for agents that require identity verification (handshake). Polled every ~5 seconds by the frontend.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `crId` | string | Collateral reservation ID |

**Response:** `CRStatus | null`
```json
{
  "status": true,
  "accepted": true,
  "collateralReservationId": "87390",
  "paymentAmount": "40100",
  "paymentAddress": "rajgVNW9b4H4ifvB1238kfgsSJYesXwwtv",
  "paymentReference": "0x4642505266410001..."
}
```

**Status interpretation:**
- `status: false` — No data yet for this CR
- `status: true, accepted: false` — CR was rejected, minting flow ends
- `status: true, accepted: true` — CR accepted, payment details available

---

#### `POST /api/mint`

Records a minting request. Saves minting data to the database so the executor bot can prove and execute it.

**Request Body:** `RequestMint`
```json
{
  "fasset": "FTestXRP",
  "collateralReservationId": "123456",
  "txhash": "8DD8A7C2AC0387C2BA39C52496990CF05137C987E8A2CEB0B81A4A04FA6AF4E4",
  "paymentAddress": "rajgVNW9b4H4ifvB1238kfgsSJYesXwwtv",
  "userUnderlyingAddress": "rajgVNW9b4H4ifvB1238kfgsSJYesXwwtv",
  "userAddress": "0x0048508b510502555ED47E98dE98Dd6426dDd0C4",
  "amount": "40",
  "nativeHash": "0x846aaa6fb67fce71b4daa2256e06f0061c4b0bf4c19c037bd047d85aef30413e",
  "vaultAddress": "0x0048508b510502555ED47E98dE98Dd6426dDd0C4",
  "nativeWalletId": 1,
  "underlyingWalletId": 2
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fasset` | string | Yes | FAsset symbol |
| `collateralReservationId` | string | Yes | CR ID from `getCrEvent` |
| `txhash` | string | Yes | Underlying chain tx hash |
| `paymentAddress` | string | Yes | Vault's underlying address (payment destination) |
| `userUnderlyingAddress` | string | Yes | User's underlying chain address |
| `userAddress` | string | Yes | User's FLR/CFLR address |
| `amount` | string | Yes | Amount of underlying sent |
| `nativeHash` | string | Yes | FLR tx hash of reserve collateral call |
| `vaultAddress` | string | Yes | Agent vault FLR address |
| `nativeWalletId` | WalletType? | No | Wallet type enum (METAMASK=1, BIFROST=2, LEDGER=3, XAMAN=4) |
| `underlyingWalletId` | WalletType? | No | Wallet type enum for underlying wallet |

**Response:** `void` (200 OK)

---

#### `GET /api/mint/:txhash`

Returns the minting status. Polled every 15-30 seconds by the frontend.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `txhash` | string | Underlying transaction hash |

**Response:** `MintingStatus`
```json
{
  "status": false,
  "step": 1
}
```

**Minting steps:**
| Step | Description |
|------|-------------|
| 0 | Requesting underlying payment proof from Data Connector |
| 1 | Data Connector is finalizing payment proof |
| 2 | Underlying payment has been proved |
| 3 | Executor is executing minting |
| 4 | Minting complete (`status: true`) |

---

#### `GET /api/collateralReservationFee/:fasset/:lots`

Returns the collateral reservation fee in wei for the specified number of lots.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `lots` | number | Number of lots |

**Response:** `CRFee`
```json
{
  "collateralReservationFee": "20254437869822485207"
}
```

---

#### `GET /api/estimateFee/:fasset`

Returns the estimated blockchain fee (for BTC/DOGE) in satoshi/byte and extra amount needed.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `FeeEstimate`
```json
{
  "estimatedFee": "1079",
  "extraBTC": "0.002158"
}
```

---

#### `GET /api/getUtxosForTransaction/:fasset/:xpub/:amount`

Returns UTXOs needed for a BTC/DOGE transaction. **Currently returns stub/empty data.**

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `xpub` | string | Extended public key |
| `amount` | string | Amount in smallest unit |

**Response:** `UTXOSLedger`
```json
{
  "selectedUtxos": [],
  "estimatedFee": 12456,
  "returnAddresses": []
}
```

---

#### `GET /api/submitTx/:fasset/:hex`

Broadcasts a signed transaction to the underlying blockchain (BTC/DOGE).

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `hex` | string | Signed transaction hex |

**Response:** `submitTxResponse`
```json
{
  "hash": "cfe46aba4d7e1cfe98282bc000c228e29ff2858c4c2af6fe258bff60846bbff1"
}
```

---

#### `GET /api/ecosystemInfo`

Returns aggregated ecosystem data including TVL, supply, agents, fees, rewards, and core vault metrics.

**Response:** `EcosystemData`
```json
{
  "tvl": "50,000,000.00",
  "tvlPoolsNat": "30,000,000.00",
  "numTransactions": "15000",
  "numAgents": 25,
  "agentsInLiquidation": 0,
  "supplyByFasset": [
    {
      "fasset": "FXRP",
      "supply": "1,000,000",
      "minted": "500,000",
      "availableToMintUSD": "250,000",
      "availableToMintLots": 500,
      "allLots": 1000,
      "mintedPercentage": "50.00",
      "mintedLots": 500
    }
  ],
  "totalMinted": "5,000,000.00",
  "numLiquidations": 2,
  "rewardsAvailableUSD": "10,000.00",
  "overCollaterazied": "250.00",
  "supplyByCollateral": [
    { "symbol": "FLR", "supply": "30,000,000", "supplyUSD": "150,000" }
  ],
  "totalCollateral": "200,000,000.00",
  "numMints": 5000,
  "poolRewards": [
    { "fasset": "FXRP", "rewards": "1,000", "rewardsUSD": "500" }
  ],
  "totalPoolRewardsPaidUSD": "5,000.00",
  "numHolders": 1200,
  "agentCollateral": "100,000,000.00",
  "numRedeems": 3000,
  "coreVaultSupply": "100,000.00",
  "coreVaultSupplyUSD": "50,000.00",
  "coreVaultInflows": "10,000.00",
  "coreVaultInflowsUSD": "5,000.00",
  "coreVaultOutflows": "5,000.00",
  "coreVaultOutflowsUSD": "2,500.00",
  "proofOfReserve": {
    "total": "1,000,000",
    "totalUSD": "500,000",
    "reserve": "1,500,000",
    "reserveUSD": "750,000",
    "ratio": "1.50"
  }
}
```

---

#### `POST /api/prepareUtxos/:fasset/:amount/:recipient/:memo/:fee`

Prepares UTXOs for a BTC/DOGE PSBT transaction. **Currently returns stub/null data.**

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `amount` | string | Amount in satoshi |
| `recipient` | string | Recipient address |
| `memo` | string | Payment reference memo |
| `fee` | string | Fee in satoshi |

**Request Body:** `SelectedUTXOAddress[]`

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `changeAddresses` | string? | Comma-separated change addresses |

---

#### `GET /api/returnAddresses/:fasset/:amount/:address`

Returns addresses for BTC/DOGE minting with identity verification. **Currently returns stub data.**

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `amount` | string | Amount in satoshi |
| `address` | string | Connected wallet address |

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `receiveAddresses` | string? | Comma-separated receive addresses |
| `changeAddresses` | string? | Comma-separated change addresses |

**Response:** `ReturnAddresses`
```json
{
  "addresses": ["addr1", "addr2"],
  "estimatedFee": "12456"
}
```

---

#### `GET /api/mintEnabled`

Returns which FAssets currently have minting enabled.

**Response:** `FassetStatus[]`
```json
[
  { "fasset": "FXRP", "status": true },
  { "fasset": "FBTC", "status": false }
]
```

---

### 4.3 Redemption Endpoints

**Tag:** `Redemption`

---

#### `GET /api/redemptionFee/:fasset`

Returns the redemption fee in BIPS, max redemption lots, and max lots per single redemption.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `RedemptionFee`
```json
{
  "redemptionFee": "10",
  "maxRedemptionLots": 123,
  "maxLotsOneRedemption": 212
}
```

> Note: To get fee percentage, divide BIPS by 100 (e.g. 10 BIPS = 0.1%).

---

#### `GET /api/redemptionStatus/:fasset/:txhash`

Returns the status of a redemption request.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `txhash` | string | FLR transaction hash of the redeem call |

**Response:** `RedemptionStatus`
```json
{
  "status": "SUCCESS",
  "incomplete": true,
  "incompleteData": {
    "redeemer": "0xe2465d57a8719B3f0cCBc12dD095EFa1CC55A997",
    "remainingLots": "451"
  }
}
```

**Status values:**
| Status | Description |
|--------|-------------|
| `PENDING` | Redemption is being processed |
| `SUCCESS` | Redemption completed successfully |
| `DEFAULT` | Redemption defaulted (agent failed to pay) |
| `EXPIRED` | Redemption expired |

---

#### `GET /api/redemptionDefaultStatus/:txhash`

Returns details of a defaulted redemption including collateral compensation.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `txhash` | string | FLR transaction hash |

**Response:** `RedemptionDefaultStatusGrouped`
```json
{
  "status": true,
  "underlyingPaid": "879.12",
  "vaultCollateralPaid": [
    { "token": "testUSDC", "value": "213.824" },
    { "token": "testETH", "value": "0.005" }
  ],
  "poolCollateralPaid": "0",
  "vaultCollateral": "testUSDT",
  "fasset": "FTestXRP",
  "redeemedTokens": "1,000.0"
}
```

> `status: false` means the default has not yet been processed.

---

#### `GET /api/requestRedemptionDefault/:fasset/:txhash/:amount/:userAddress`

Triggers handling of a redemption default. Called after user confirms the default.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `txhash` | string | FLR transaction hash |
| `amount` | string | Redemption amount |
| `userAddress` | string | User's FLR address |

**Response:** `RequestRedemption`
```json
{
  "incomplete": true,
  "remainingLots": "366"
}
```

---

#### `GET /api/redemptionFeeData`

Returns redemption fee data for all FAssets.

**Response:** `RedemptionFeeData[]`
```json
[
  {
    "fasset": "FXRP",
    "feePercentage": "0.1",
    "feeUSD": "0.05"
  }
]
```

---

#### `GET /api/redemptionQueue/:fasset`

Returns the pending redemption queue for a FAsset.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |

**Response:** `RedemptionQueue`
```json
{
  "maxLotsOneRedemption": 12,
  "maxLots": 55
}
```

---

### 4.4 Balance Endpoints

**Tag:** `Balance`

---

#### `GET /api/balance/underlying/:fasset/:address`

Returns the underlying chain balance for a given address.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol (determines chain: XRP, BTC, DOGE) |
| `address` | string | Underlying chain address |

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `receiveAddresses` | string? | Comma-separated BTC receive addresses (from wallet) |
| `changeAddresses` | string? | Comma-separated BTC change addresses (from wallet) |

> `receiveAddresses` and `changeAddresses` are required for BTC/DOGE as they contain UTXOs.

**Response:** `CommonBalance`
```json
{
  "balance": "1,270.62",
  "accountInfo": {
    "depositAuth": false,
    "destTagReq": false
  }
}
```

> `accountInfo` is only present for XRP.

---

#### `GET /api/balance/native/:address`

Returns balances of native tokens (FLR/CFLR, wrapped, stablecoins, and FAssets).

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `address` | string | FLR/CFLR address |

**Response:** `NativeBalanceItem[]`
```json
[
  { "symbol": "CFLR", "balance": "2,145,091.997", "wrapped": "0", "valueUSD": "14,586.62", "lots": "0" },
  { "symbol": "testUSDC", "balance": "628.475" },
  { "symbol": "testUSDT", "balance": "1,186.834" },
  { "symbol": "testETH", "balance": "0" },
  { "symbol": "FTestXRP", "balance": "60", "lots": "3" },
  { "symbol": "FTestBTC", "balance": "0", "lots": "0" }
]
```

---

#### `GET /api/balance/pool/:userAddress`

Returns total CFLR balance across all collateral pools.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `userAddress` | string | User's FLR/CFLR address |

**Response:** `CommonBalance`
```json
{
  "balance": "1,990.02"
}
```

---

#### `GET /api/balance/xpub/:fasset/:xpub`

Returns balance from an extended public key (BTC/DOGE). **Currently returns zero.**

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `xpub` | string | Extended public key |

**Response:** `CommonBalance`
```json
{
  "balance": "0"
}
```

---

### 4.5 Pool Endpoints

**Tag:** `Pool`

---

#### `GET /api/pools`

Returns all collateral pools/agents for the specified FAssets.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string[] | One or more FAsset symbols |

**Response:** `AgentPoolItem[]` — See pool response format below.

---

#### `GET /api/pools/:address`

Returns pools with user-specific balances (pool tokens, fees, NAT balance).

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `address` | string | User's FLR address |

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string[] | One or more FAsset symbols |

**Response:** `AgentPoolItem[]`

**Full AgentPoolItem fields:**

| Field | Type | Description |
|-------|------|-------------|
| `vault` | string | Vault contract address |
| `pool` | string | Pool contract address |
| `totalPoolCollateral` | string | Total pool collateral in FLR (formatted) |
| `poolCR` | string | Pool collateral ratio |
| `vaultCR` | string | Vault collateral ratio |
| `feeShare` | string | Pool fee share (%) |
| `agentName` | string | Agent display name |
| `vaultType` | string | FAsset type |
| `poolExitCR` | string | CR required to exit pool |
| `freeLots` | string | Free lots available |
| `status` | string | Online/offline |
| `health` | number | Vault health status (0-4) |
| `url` | string | Agent image URL |
| `mintFee` | string | Mint fee (%) |
| `mintCount` | number | Total mints on vault |
| `numLiquidations` | number | Liquidation count |
| `redeemRate` | string | Redemption success rate (%) |
| `poolCollateralUSD` | string | Pool collateral in USD |
| `vaultCollateral` | string | Vault collateral amount |
| `collateralToken` | string | Vault collateral token symbol |
| `tokenAddress` | string | Pool token contract address |
| `mintingPoolCR` | string | Minting pool CR |
| `mintingVaultCR` | string | Minting vault CR |
| `vaultCCBCR` | string | Vault CCB CR |
| `vaultMinCR` | string | Vault minimum CR |
| `vaultSafetyCR` | string | Vault safety CR |
| `poolCCBCR` | string | Pool CCB CR |
| `poolMinCR` | string | Pool minimum CR |
| `poolSafetyCR` | string | Pool safety CR |
| `poolTopupCR` | string | Pool topup CR |
| `description` | string | Agent description |
| `mintedAssets` | string | Total minted in underlying |
| `mintedUSD` | string | Total minted in USD |
| `remainingAssets` | string | Remaining mintable in underlying |
| `remainingUSD` | string | Remaining mintable in USD |
| `allLots` | number | Total lots |
| `poolOnlyCollateralUSD` | string | Pool-only collateral in USD |
| `vaultOnlyCollateralUSD` | string | Vault-only collateral in USD |
| `totalPortfolioValueUSD` | string | Total portfolio value in USD |
| `limitUSD` | string | Limit in USD |
| `infoUrl` | string | Agent info URL |
| **User-specific fields** (when address provided) | | |
| `userPoolBalance` | string? | User's pool token balance |
| `userPoolFees` | string? | User's earned fees in FAsset |
| `userPoolFeesUSD` | string? | User's earned fees in USD |
| `userPoolNatBalance` | string? | User's pool balance in FLR |
| `userPoolNatBalanceInUSD` | string? | User's pool balance in USD |
| `userPoolShare` | string? | User's share of pool (%) |
| `transferableTokens` | string? | Transferable pool tokens |
| `fassetDebt` | string? | User's FAsset debt |
| `nonTimeLocked` | string? | Non-time-locked pool tokens |
| `lifetimeClaimedPoolFormatted` | string? | Lifetime claimed rewards |
| `lifetimeClaimedPoolUSDFormatted` | string? | Lifetime claimed in USD |
| `userPoolTokensFull` | string? | Full precision pool token balance |

---

#### `GET /api/pools/:fasset/:address/:poolAddress`

Returns a specific pool with user balances.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `address` | string | User's FLR address |
| `poolAddress` | string | Pool contract address |

**Response:** `AgentPoolItem` (single object, same fields as above)

---

#### `GET /api/pools/:fasset/:poolAddress`

Returns a specific pool/agent without user balances.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `poolAddress` | string | Pool contract address |

**Response:** `AgentPoolItem`

---

#### `GET /api/maxWithdraw/:fasset/:poolAddress/:userAddress/:value`

Calculates what a user receives when exiting a pool with a given amount of pool tokens.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `poolAddress` | string | Pool contract address |
| `userAddress` | string | User's FLR address |
| `value` | number | Amount of pool tokens to exit with |

**Response (success):** `MaxWithdraw`
```json
{
  "natReturn": "100.015",
  "fees": "0"
}
```

**Response (error, 400):**
```json
{
  "statusCode": 400,
  "message": "Pool collateral ratio falls below exitCR. Please enter a lower value."
}
```

---

#### `GET /api/maxPoolWith/:fasset/:poolAddress`

Returns the maximum amount of collateral pool tokens that can be withdrawn from a pool.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `fasset` | string | FAsset symbol |
| `poolAddress` | string | Pool contract address |

**Response:** `MaxCPTWithdraw`
```json
{
  "maxWithdraw": "100.12"
}
```

---

### 4.6 OFT Endpoints (Cross-Chain)

**Tag:** `OFT`
**Base Path:** `/api/oft`
**Availability:** Only on `flare` and `coston2` networks.

---

#### `GET /api/oft/redemptionHash/:guid`

Returns the redemption transaction hash for a given OFT GUID.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `guid` | string | OFT GUID (LayerZero message identifier) |

**Response:** `RedemptionOFT`
```json
{
  "txhash": "0x123..."
}
```

---

#### `GET /api/oft/userHistory/:address`

Returns the OFT cross-chain transaction history for a user.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `address` | string | User's FLR address |

**Response:** `OFTHistory[]`
```json
[
  {
    "action": "SEND",
    "timestamp": 1726125839877,
    "eid": 1234,
    "txhash": "0x123...",
    "amountSent": "660",
    "amountReceived": "660",
    "amount": "660",
    "toHypercore": true,
    "fasset": "FTestXRP",
    "status": true,
    "defaulted": false,
    "incomplete": false,
    "remainingLots": null,
    "redemptionBlocked": false
  }
]
```

---

#### `GET /api/oft/composerFee/:srcEid`

Returns the composer fee in parts per million for a given source endpoint ID.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `srcEid` | string | Source endpoint ID (LayerZero EID) |

**Response:** `ComposerFeeResponse`
```json
{
  "composerFeePPM": "10000"
}
```

---

#### `GET /api/oft/redeemerAccount/:redeemer`

Returns the redeemer account address registered in the FAssetRedeemComposer contract and its native balances.

**Path Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `redeemer` | string | Redeemer's address |

**Response:** `RedeemerAccountResponse`
```json
{
  "address": "0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8",
  "balances": [
    {
      "symbol": "FLR",
      "balance": "1,270.62",
      "valueUSD": "12.50"
    }
  ]
}
```

---

### 4.7 Earn Endpoints

**Tag:** `Earn`

---

#### `GET /api/earn`

Returns a list of ecosystem DeFi applications. Data is fetched from an external JSON URL and cached, refreshed every 5 minutes via cron.

**Response:** `Record<string, EcosystemApp>`

---

### 4.8 Wallet Endpoints

**Tag:** `Wallet`
**Authentication:** Requires `x-api-key` header.

---

#### `GET /api/wallets`

Returns paginated wallet IDs.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 10 | Number of results per page |
| `offset` | number | 0 | Offset for pagination |

---

### 4.9 Utility Endpoints

---

#### `GET /api/version`

Returns the API version from `package.json`.

---

#### `GET /api/json`

Returns the Swagger/OpenAPI JSON document.

---

#### `GET /health`

Database health check endpoint (NestJS Terminus).

---

## 5. Database Schema

Uses MikroORM with SQLite (development) or MySQL (production). 19 entities total.

### Core Entities

#### `minting`
| Column | Type | Description |
|--------|------|-------------|
| `id` | int (PK, auto) | |
| `collateralReservationId` | string | CR ID |
| `txhash` | string? | Underlying tx hash |
| `paymentAddress` | string | Vault underlying address |
| `userUnderlyingAddress` | string | User's underlying address |
| `processed` | boolean | Minting completed |
| `proofRequestRound` | number? | DAL proof round |
| `proofRequestData` | text? | DAL proof data |
| `state` | boolean | Current state |
| `validUntil` | bigint | Proof validity timestamp |
| `proved` | boolean | Payment proved |
| `fasset` | string | FAsset symbol |
| `userAddress` | string | User's FLR address |
| `amount` | string | Amount |
| `timestamp` | bigint | Creation timestamp |
| `vaultAddress` | string | Vault FLR address |
| `paymentReference` | text? | Payment reference |
| `handshakeRequired` | boolean | Agent requires ID verification |

#### `redemption`
| Column | Type | Description |
|--------|------|-------------|
| `id` | int (PK, auto) | |
| `txhash` | string | FLR tx hash |
| `processed` | boolean | Redemption completed |
| `proofRequestRound` | number? | DAL proof round |
| `proofRequestData` | text? | DAL proof data |
| `state` | boolean | Current state |
| `underlyingAddress` | string | Underlying payment address |
| `paymentReference` | string | Payment reference |
| `amountUBA` | string | Amount in UBA |
| `firstUnderlyingBlock` | string | First underlying block |
| `lastUnderlyingBlock` | string | Last underlying block |
| `lastUnderlyingTimestamp` | string | Deadline timestamp |
| `requestId` | string | Redemption request ID |
| `defaulted` | boolean | Whether defaulted |
| `validUntil` | bigint | Proof validity |
| `fasset` | string | FAsset symbol |
| `handshakeType` | number | Handshake type (default: 1) |
| `rejected` | boolean | Whether rejected |
| `takenOver` | boolean | Whether taken over |
| `rejectionDefault` | boolean | Whether rejection defaulted |
| `timestamp` | bigint? | Timestamp |
| `blocked` | boolean | Payment blocked |

#### `pools`
| Column | Type | Description |
|--------|------|-------------|
| `id` | int (PK, auto) | |
| `vaultAddress` | string | Vault contract address |
| `fasset` | string | FAsset symbol |
| `poolAddress` | string | Pool contract address |
| `tokenAddress` | string | Pool token address |
| `agentName` | string | Agent display name |
| `vaultType` | string | FAsset type |
| `poolCR` | decimal(10,2) | Pool collateral ratio |
| `vaultCR` | decimal(10,2) | Vault collateral ratio |
| `poolExitCR` | decimal(10,2) | Exit CR |
| `totalPoolCollateral` | string | Total pool collateral |
| `feeShare` | decimal(10,2) | Fee share % |
| `status` | number | Agent online status |
| `freeLots` | string | Free lots |
| `mintFee` | decimal(10,5) | Mint fee |
| `mintNumber` | number | Mint count |
| `redeemSuccessRate` | decimal(10,4) | Redeem success % |
| `numLiquidations` | number | Liquidation count |
| `url` | text | Agent image URL |
| `poolNatUsd` | string | Pool NAT in USD |
| `vaultCollateral` | string | Vault collateral |
| `vaultCollateralToken` | string | Collateral token symbol |
| `vaultCollateralTokenDecimals` | number | Token decimals |
| `publiclyAvailable` | boolean | Agent is public |
| `mintingPoolCR` | decimal(10,2) | Minting pool CR |
| `mintingVaultCR` | decimal(10,2) | Minting vault CR |
| `vaultToken` | string | Vault token |
| `description` | text? | Agent description |
| `mintedUBA` | string? | Minted amount UBA |
| `mintedUSD` | string? | Minted in USD |
| `allLots` | number? | Total lots |
| `poolOnlyCollateralUSD` | string? | Pool collateral USD |
| `vaultOnlyCollateralUSD` | string? | Vault collateral USD |
| `remainingUBA` | string? | Remaining mintable |
| `remainingUSD` | string? | Remaining mintable USD |
| `totalPortfolioValueUSD` | string? | Total portfolio USD |
| `limitUSD` | string? | Limit USD |
| `infoUrl` | text? | Agent info URL |
| `underlyingAddress` | string? | Agent underlying address |
| `poolTopupCR` | decimal(10,2) | Pool topup CR |
| `handshakeType` | number? | Handshake type |

### Event Entities

#### `collateral_reservation`
Stores CollateralReserved events from the blockchain.

| Column | Type | Description |
|--------|------|-------------|
| `id` | int (PK, auto) | |
| `collateralReservationId` | string | CR ID |
| `agentVault` | string | Agent vault address |
| `minter` | string | Minter address |
| `valueUBA` | string | Value in UBA |
| `feeUBA` | string | Fee in UBA |
| `firstUnderlyingBlock` | string | First underlying block |
| `lastUnderlyingBlock` | string | Last underlying block |
| `lastUnderlyingTimestamp` | string | Deadline timestamp |
| `paymentAddress` | string | Payment address |
| `paymentReference` | string | Payment reference |
| `executorAddress` | string | Executor address |
| `executorFeeNatWei` | string | Executor fee |
| `timestamp` | bigint | Event timestamp |
| `txhash` | text? | Transaction hash |

#### `redemption_requested`
Stores RedemptionRequested events.

#### `redemption_event_default`
Stores RedemptionDefault events.

#### `redemption_default`
Stores processed redemption defaults with collateral payments.

#### `incomplete_redemption`
Stores incomplete (partial) redemptions with remaining lots.

#### `minting_payment_default`
Stores MintingPaymentDefault events.

#### `redemption_blocked`
Stores RedemptionPaymentBlocked events.

#### `underlying_payment`
Stores confirmed underlying chain payments.

### Other Entities

#### `liveness`
Agent heartbeat tracking via AgentPingResponse events.

| Column | Type | Description |
|--------|------|-------------|
| `vaultAddress` | string | Agent vault address |
| `fasset` | string | FAsset symbol |
| `lastPinged` | bigint | Last ping block |
| `lastTimestamp` | bigint | Last ping timestamp |
| `publiclyAvailable` | boolean | Agent is public |

#### `full_redemption`
Whole redemption records.

#### `collaterals`
Collateral token configuration (decimals, FTSO symbols, CR ratios).

#### `wallet`
User wallet records with chain type and wallet type enums.

**WalletType enum:** OTHER=0, METAMASK=1, BIFROST=2, LEDGER=3, XAMAN=4
**ChainType enum:** EVM=1, XRP=2

#### `indexer_state`
Event reader checkpoint tracking (last processed block).

### OFT Entities

#### `oft_sent`
OFT send events (cross-chain transfers out).

#### `oft_received`
OFT receive events (cross-chain transfers in).

#### `guid_redemption`
Maps OFT GUIDs to redemption request IDs. (Legacy — replaced by `oft_redemption`.)

#### `oft_redemption`
Stores OFT redemption data from FAssetRedeemed events, enriched with RedemptionRequested event data.

| Column | Type | Description |
|--------|------|-------------|
| `id` | int (PK, auto) | |
| `agentVault` | string | Agent vault address |
| `redeemer` | string | Redeemer's address (from FAssetRedeemed) |
| `requestId` | string | Redemption request ID |
| `paymentAddress` | string | Underlying payment address |
| `valueUBA` | string | Value in UBA |
| `feeUBA` | string | Fee in UBA |
| `paymentReference` | string | Payment reference |
| `timestamp` | bigint | Creation timestamp |
| `txhash` | string | FLR transaction hash |
| `fasset` | string | FAsset symbol |
| `guid` | string | LayerZero GUID |
| `personalRedeemerAddress` | string | Redeemer account from composer |
| `srcEid` | number | Source endpoint ID |
| `defaulted` | boolean | Whether defaulted (default: false) |
| `blocked` | boolean | Payment blocked (default: false) |
| `processed` | boolean | Processing complete (default: false) |

---

## 6. Services

### Core Services

| Service | Description |
|---------|-------------|
| **UserService** | Main business logic: agent selection, minting, redemption, balances, ecosystem data |
| **PoolService** | Collateral pool operations: pool listings, user balances, agent data, CR calculations |
| **BotService** | Initialization: loads bot config, asset managers, agent data, computes ecosystem aggregates |
| **ContractService** | Smart contract instantiation from deployment JSON files |
| **EthersService** | Provides ethers.js JsonRpcProvider and Wallet (signer) |
| **FassetConfigService** | Loads FAsset configurations from network JSON, creates verifier services |
| **RunnerService** | Background processor: executes minting proofs/settlements, processes redemptions |
| **EventReaderService** | Reads blockchain events (CollateralReserved, RedemptionRequested, defaults, etc.) |
| **ExternalApiService** | External API calls: Blockbook, Flare Dashboard, verifiers |
| **HistoryService** | User progress history (7-day window) and lifetime claimed rewards |
| **TimeDataService** | Time-series dashboard data generation and caching |
| **DalService** | Data Availability Layer client for proof verification |
| **XRPLApiService** | XRP Ledger specific RPC calls |
| **EarnService** | DeFi ecosystem app list (fetched from JSON URL, 5-min cache) |
| **CleaningService** | Cron job: deletes stale records older than 7 days at midnight |
| **WalletService** | Paginated wallet queries |
| **VersionService** | Reads version from package.json |
| **VerifierService** | Queries underlying chain verifiers for transaction data by payment reference |
| **OFTRedemptionProcessor** | Background processor for OFT redemption payment verification and status tracking |

---

## 7. Background Processing

### Event Reader (EventReaderService)

Continuously reads blockchain logs from the last processed block. Tracks these event topics:

| Event | Description |
|-------|-------------|
| `AgentPingResponse` | Agent liveness heartbeat (2-hour window) |
| `CollateralReserved` | New collateral reservation for minting |
| `RedemptionRequested` | New redemption request |
| `RedemptionDefault` | Redemption default event |
| `RedemptionRequestIncomplete` | Partial redemption |
| `MintingPaymentDefault` | Failed minting payment |
| `RedemptionPaymentBlocked` | Blocked redemption payment |

Saves events to corresponding database entities and updates minting/redemption records.

### Runner (RunnerService)

Main processing loop that handles the minting/redemption lifecycle:

- Processes pending mintings: requests DAL proofs, verifies proofs via Relay & FdcHub, executes minting on AssetManager
- Processes pending redemptions: monitors for defaults, handles proof verification
- Withdraws accumulated WNAT every 10 minutes (executor fee collection)

### Cleaning (CleaningService)

Cron job running at midnight that deletes:
- Unprocessed minting records older than 7 days
- Stale redemption records
- Old default events, incomplete redemptions, OFT records

### OFT Event Reader (OFTEventReaderService)

Reads OFTSent, OFTReceived, FAssetRedeemed, RedemptionRequested, and ComposeDelivered events from the FAsset OFT and FAssetRedeemComposer contracts. Creates `OFTRedemption` entities from FAssetRedeemed+RedemptionRequested event pairs. Only active on Flare and Coston2 networks.

### OFT Redemption Processor (OFTRedemptionProcessor)

Background loop (5s interval) that processes unprocessed `OFTRedemption` entities. For each:
1. Checks the verifier for underlying chain payment (by payment reference, amount = valueUBA - feeUBA)
2. Checks DB for `RedemptionDefaultEvent` by requestId
3. Checks DB for `RedemptionBlocked` by requestId
Marks redemptions as processed/defaulted/blocked accordingly. Only active on Flare and Coston2 networks.

---

## 8. Minting Flow

### V2 Flow (with optional identity verification)

#### For XRP:

1. User selects number of lots to mint
2. Frontend calls `GET /api/agent/:fasset/:lots` to get best agent
3. Frontend calls `reserveCollateral()` on AssetManager contract with: `(agentVaultAddress, lots, feeBIPS, executorAddress, [minterUnderlyingAddresses], { value: collateralReservationFee + executorFee })`
4. Frontend calls `GET /api/getCrEvent/:fasset/:txhash` with the reserve collateral tx hash
   - **No verification required:** Returns `paymentAddress`, `paymentAmount`, `paymentReference`, `collateralReservationId` → go to step 6
   - **Verification required:** Returns `crtId` → go to step 5
5. Frontend polls `GET /api/getCrStatus/:crId` every ~5 seconds
   - `status: false` → No decision yet
   - `status: true, accepted: true` → Returns payment details, continue to step 6
   - `status: true, accepted: false` → CR rejected, flow ends
   - If no response within ~30s, user can cancel via `assetManager.cancelCollateralReservation(crtId)`
6. User sends underlying payment to `paymentAddress` with `paymentAmount` and `paymentReference`
7. Frontend calls `POST /api/mint` with all minting data
8. Frontend polls `GET /api/mint/:txhash` every 15-30 seconds until `status: true`

#### For BTC/DOGE:

Same as XRP with additional steps for UTXO-based chains:
- Before step 3 (if verification required): call `GET /api/returnAddresses/:fasset/:amount/:address` to get addresses for the reserve collateral call
- Before step 6: call `POST /api/prepareUtxos/...` to get PSBT for signing
- Step 6 uses `signPSBT` via WalletConnect instead of direct send

---

## 9. Redemption Flow

1. User selects number of lots to redeem
2. Frontend calls `redeem(lots, userUnderlyingAddress, executorAddress, { value: executorFee })` on AssetManager
3. Frontend monitors progress via `GET /api/userProgress/:address`
4. If status is `DEFAULT`, frontend calls `GET /api/requestRedemptionDefault/:fasset/:txhash/:amount/:userAddress`
5. Frontend polls `GET /api/redemptionDefaultStatus/:txhash` for default compensation details
6. If `redemptionStatus` returns `SUCCESS`, redemption is complete

**Redemption statuses:** PENDING → SUCCESS | DEFAULT | EXPIRED

---

## 10. OFT Cross-Chain Module

Available only on `flare` and `coston2` networks. Uses LayerZero's OFT (Omnichain Fungible Token) standard for cross-chain FAsset transfers. Reads events from the `IFAssetRedeemComposer` contract.

**Module Components:**
- `OFTController` — API endpoints for OFT data (history, redemption hash, composer fee, redeemer account)
- `OFTService` — Business logic for OFT history, composer fee queries, and redeemer account lookups
- `OFTEventReaderService` — Reads OFTSent/OFTReceived/FAssetRedeemed/RedemptionRequested/ComposeDelivered events from blockchain; provides contract call methods for `getComposerFeePPM` and `getRedeemerAccountAddress`
- `OFTRedemptionProcessor` — Background processor that monitors unprocessed `OFTRedemption` entities: checks the verifier for underlying payments, and the DB for default/blocked events. Marks redemptions as processed/defaulted/blocked accordingly. Does not implement the defaulting procedure (no payment nonexistence proving).

**Tracked Events:**
- `OFTSent` — FAssets sent cross-chain (with destination EID, amounts, GUID)
- `OFTReceived` — FAssets received cross-chain (with source EID, amounts, GUID)
- `FAssetRedeemed` — Emitted by IFAssetRedeemComposer when a cross-chain redeem is executed (with GUID, srcEid, redeemer, redeemerAccount, amounts)
- `RedemptionRequested` — From AssetManager, paired with FAssetRedeemed to populate OFTRedemption entities
- `ComposeDelivered` — LayerZero EndpointV2 compose delivery confirmation

---

## 11. Smart Contract Integration

Contracts are loaded from deployment JSON files at `src/deploys/{network}.json` and instantiated via ethers.js v6.

### Supported Contracts

| Contract | Interface | Purpose |
|----------|-----------|---------|
| AssetManager | `IIAssetManager` | Core FAsset minting/redemption management |
| FAsset | `IFAsset` | FAsset ERC-20 token |
| CollateralPool | `ICollateralPool` | Collateral pool management |
| CollateralPoolToken | `ICollateralPoolToken` | Pool token ERC-20 |
| PriceReader | `IPriceReader` | FtsoV2 price feeds |
| AgentOwnerRegistry | `IAgentOwnerRegistry` | Agent metadata (name, URL, description) |
| WNat | `WNat` | Wrapped native token |
| Relay | `IRelay` | Proof relay |
| FdcHub | `IFdcHub` | Flare Data Connector hub |
| FdcVerification | `IFdcVerification` | FDC proof verification |
| CoreVaultManager | — | Core vault operations |
| FAssetRedeemComposer | `IFAssetRedeemComposer` | OFT cross-chain redemption composer (fee PPM, redeemer accounts) |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `EXECUTION_FEE` | `2.5 * 10^18` wei | Default executor fee |
| `TEN_MINUTES` | 600000 ms | Processing cycle interval |
| `FILTER_AGENT` | `0x09011d...` | Excluded agent address |

---

## Formatting Conventions

- **Balances** are formatted with commas for thousands and dots for decimals (e.g. `"1,270.62"`)
- **Fees in BIPS:** Divide by 100 to get percentage (e.g. 50 BIPS = 0.5%)
- **Fees in wei:** Raw blockchain values (e.g. `"2500000000000000000"` = 2.5 FLR)
- **Collateral ratios:** Decimal format with dot separator (e.g. `"2.40"`)
- **Timestamps:** Unix epoch in milliseconds for user-facing, seconds/bigint for blockchain
