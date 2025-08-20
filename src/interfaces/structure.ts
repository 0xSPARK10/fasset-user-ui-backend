import BN from "bn.js";

export interface Price {
    symbol: string;
    price: BN;
    decimals: number;
}

export interface RedeemData {
    type: "redeem";
    requestId: string;
    amountUBA: string;
    paymentReference: string;
    firstUnderlyingBlock: string;
    lastUnderlyingBlock: string;
    lastUnderlyingTimestamp: string;
    executorAddress: string;
    createdAt: string;
    underlyingAddress: string;
}

export interface RedemptionData {
    type: "redeem";
    requestId: string;
    amountUBA: string;
    paymentReference: string;
    firstUnderlyingBlock: string;
    lastUnderlyingBlock: string;
    lastUnderlyingTimestamp: string;
    executorAddress: string;
    createdAt: string;
    underlyingAddress: string;
    agentVault: string;
}

export interface RedemptionIncomplete {
    redeemer: string;
    remainingLots: string;
}

export interface SupplyFasset {
    fasset: string;
    supply: string;
    minted: string;
    availableToMintUSD: string;
    availableToMintLots: number;
    allLots: number;
    mintedPercentage: string;
    availableToMintAsset: string;
    mintedLots: number;
}

export interface SupplyTotalCollateral {
    symbol: string;
    supply: string;
    supplyUSD: string;
}

export interface FassetTimeSupply {
    timestamp: number;
    value: string;
}

export interface FassetSupplyDiff {
    fasset: string;
    diff: string;
    isPositive: boolean;
}

export interface GenericDiff {
    diff: string;
    isPositive: boolean;
}

export interface PoolCollateralDiff {
    diff: string;
    isPositive: boolean;
}

export interface TimeSeries {
    timestamp: number;
    value: string;
}

export interface TimeSpan {
    timestamp: number;
    value: number;
}

export interface TimeSeriesIndexer {
    index: string;
    start: number;
    end: number;
    value: string;
}

export interface TopPoolIndexer {
    pool: string;
    score: string;
    claimed: string;
}

export interface TopPoolData {
    name: string;
    vaultAddress: string;
    poolAddress: string;
    fasset: string;
    collateralSymbol: string;
    tvl: string;
    rewardsPaid: string;
    url: string;
}

export interface TopPool extends TopPoolData {
    tvlDiff: string;
    tvlDiffPositive: boolean;
    rewardsDiff: string;
    rewardsDiffPositive: boolean;
}

export interface TimeData {
    supplyDiff: FassetSupplyDiff[];
    mintGraph: TimeSeries[];
    redeemGraph: TimeSeries[];
    bestPools: TopPool[];
    totalCollateralDiff: string;
    isPositiveCollateralDiff: boolean;
    coreVaultData: TimeDataCV;
    proofOfReserve: TimeSeries[];
}

export interface TimeDataCV {
    supplyDiff: string;
    isPositiveSupplyDiff: boolean;
    inflowGraph: TimeSeries[];
    outflowGraph: TimeSeries[];
    inflowDiff: string;
    isPositiveInflowDiff: boolean;
    outflowDiff: string;
    isPositiveOutflowDiff: boolean;
    tvlGraph: TimeSeries[];
}

export interface PoolRewards {
    fasset: string;
    rewards: string;
    rewardsUSD: string;
}

export interface ProofOfReserve {
    total: string;
    totalUSD: string;
    reserve: string;
    reserveUSD: string;
    ratio: string;
}

export interface EcosystemData {
    tvl: string;
    tvlPoolsNat: string;
    numTransactions: string;
    numAgents: number;
    agentsInLiquidation: number;
    supplyByFasset: SupplyFasset[];
    totalMinted: string;
    numLiquidations: number;
    rewardsAvailableUSD: string;
    overCollaterazied: string;
    supplyByCollateral: SupplyTotalCollateral[];
    totalCollateral: string;
    numMints: number;
    poolRewards: PoolRewards[];
    totalPoolRewardsPaidUSD: string;
    numHolders: number;
    agentCollateral: string;
    numRedeems: number;
    coreVaultSupply: string;
    coreVaultSupplyUSD: string;
    coreVaultInflows: string;
    coreVaultInflowsUSD: string;
    coreVaultOutflows: string;
    coreVaultOutflowsUSD: string;
    proofOfReserve: ProofOfReserve;
}

export interface AssetManagerFasset {
    fasset: string;
    assetManager: string;
    decimals: number;
}

export interface FassetDecimals {
    fasset: string;
    decimals: number;
}

export interface FullRedeemData {
    redeemData: RedemptionData[];
    fullAmount: string;
    from: string;
    incomplete: boolean;
    dataIncomplete?: RedemptionIncomplete;
}

export interface TransactionBTC {
    time: number;
    txs: number;
    received: string;
    sent: string;
    sentToSelf: string;
}

export interface ClaimedPools {
    fasset: string;
    claimed: string;
}

export interface ClaimedPoolSpecific {
    value: string;
}

export interface CurrencyMap {
    [key: string]: ClaimedPoolSpecific;
}

export interface XpubBTC {
    address: string;
    balance: string;
    totalReceived: string;
    totalSent: string;
    unconfirmedBalance: string;
    unconfirmedTxs: number;
    txs: number;
    addrTxCount: number;
    usedTokens: number;
}

export interface UTXOBTC {
    txid: string;
    vout: number;
    value: string;
    confirmations: string;
    locktime?: number;
    height?: number;
    coinbase?: boolean;
}

export interface UTXOBTCXPUB {
    txid: string;
    vout: number;
    value: string;
    confirmations: string;
    locktime?: number;
    height?: number;
    coinbase?: boolean;
    path: string;
    address: string;
}

export interface AddressBTC {
    address: string;
    balance: string;
    totalReceived: string;
    totalSent: string;
    unconfirmedBalance: string;
    unconfirmedTxs: number;
    txs: number;
}

export interface SelectedUTXO {
    txid: string;
    vout: number;
    value: string;
    hexTx: string;
    path: string;
    utxoAddress: string;
}

export interface SelectedUTXOAddress {
    txid: string;
    vout: number;
    value: string;
    hexTx: string;
    path: string;
    utxoAddress: string;
    address: string;
    index: number;
}

export interface IndexerFLRAddress {
    id: number;
    hex: string;
    type: number;
}

export interface IndexerUnderlyingAddress {
    id: number;
    text: string;
    type: number;
}

export interface AddressVaultIndexer {
    id: number;
    hex: string;
    type: number;
}

export interface UnderlyingAddressVaultIndexer {
    id: number;
    text: string;
    type: number;
}

export interface IndexerAgentVault {
    address: AddressVaultIndexer;
    fasset: number;
    underlyingAddress: UnderlyingAddressVaultIndexer;
    collateralPool: number;
    collateralPoolToken: number;
    owner: number;
    destroyed: boolean;
}

export interface RedemptionRequested {
    evmLog: number;
    fasset: number;
    requestId: number;
    agentVault: IndexerAgentVault;
    redeemer: IndexerFLRAddress;
    paymentAddress: IndexerUnderlyingAddress;
    valueUBA: string;
    feeUBA: string;
    firstUnderlyingBlock: number;
    lastUnderlyingBlock: number;
    lastUnderlyingTimestamp: number;
    paymentReference: string;
    executor: IndexerFLRAddress;
    executorFeeNatWei: string;
}

export interface RedemptionDefaultEvent {
    agentVault: string;
    redeemer: string;
    requestId: string;
    redemptionAmountUBA: string;
    redeemedVaultCollateralWei: string;
    redeemedPoolCollateralWei: string;
}

export interface IndexerRedemptionDefaultReponse {
    evmLog: number;
    fasset: number;
    redemptionRequested: RedemptionRequested;
    redeemedVaultCollateralWei: string;
    redeemedPoolCollateralWei: string;
}

export interface IndexerApiResponse {
    status: number;
    data: IndexerRedemptionDefaultReponse;
}

export interface Rewards {
    usd: string;
    rflr: string;
}

export interface FeeBTC {
    averageFeePerKb: number;
    decilesFeePerKb: number[];
}
