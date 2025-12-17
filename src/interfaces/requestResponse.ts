import { ApiProperty } from "@nestjs/swagger";
import { RedemptionStatusEnum } from "src/utils/constants";
import { RedemptionIncomplete } from "./structure";
import { WalletType } from "src/entities/Wallet";

export interface CostonExpTokenBalance {
    balance: string;
    contractAddress: string;
    decimals: string;
    name: string;
    symbol: string;
    type: string;
}

export interface IndexerTokenBalances {
    token: string;
    balance: string;
}

export interface UserClaimedPoolFees {
    fasset: string;
    claimeduba: string;
}

export class LotSize {
    @ApiProperty({ example: "20" })
    lotSize: number;
}

export class RequestMint {
    @ApiProperty({ example: "FTestXRP" })
    fasset: string;
    @ApiProperty({ example: "123456" })
    collateralReservationId: string;
    @ApiProperty({
        example: "8DD8A7C2AC0387C2BA39C52496990CF05137C987E8A2CEB0B81A4A04FA6AF4E4",
    })
    txhash: string;
    @ApiProperty({ example: "rajgVNW9b4H4ifvB1238kfgsSJYesXwwtv" })
    paymentAddress: string;
    @ApiProperty({ example: "rajgVNW9b4H4ifvB1238kfgsSJYesXwwtv" })
    userUnderlyingAddress: string;
    @ApiProperty({ example: "0x0048508b510502555ED47E98dE98Dd6426dDd0C4" })
    userAddress: string;
    @ApiProperty({ example: "40" })
    amount: string;
    @ApiProperty({
        example: "0x846aaa6fb67fce71b4daa2256e06f0061c4b0bf4c19c037bd047d85aef30413e",
    })
    nativeHash: string;
    @ApiProperty({
        example: "0x0048508b510502555ED47E98dE98Dd6426dDd0C4",
    })
    vaultAddress: string;
    @ApiProperty({
        enum: WalletType,
        description: "Wallet type",
    })
    nativeWalletId?: WalletType;
    @ApiProperty({
        enum: WalletType,
        description: "Wallet type",
    })
    underlyingWalletId?: WalletType;
}

export class CREvent {
    @ApiProperty({ example: "123456" })
    collateralReservationId: string;
    @ApiProperty({ example: "40100" })
    paymentAmount: string;
    @ApiProperty({ example: "tb1qpnwnyf0z9jqvgxnemg4et0k39p88k7mfw08gaa" })
    paymentAddress: string;
    @ApiProperty({
        example: "0x464250526641000100000000000000000000000000000000000000000007f625",
    })
    paymentReference: string;
    @ApiProperty({ example: "123456" })
    lastUnderlyingBlock: string;
    @ApiProperty({ example: "123" })
    expirationMinutes: string;
}

export class CRStatus {
    @ApiProperty({ example: true })
    status: boolean;
    @ApiProperty({ example: true })
    accepted?: boolean;
    @ApiProperty({ example: "123456" })
    collateralReservationId?: string;
    @ApiProperty({ example: "40100" })
    paymentAmount?: string;
    @ApiProperty({ example: "tb1qpnwnyf0z9jqvgxnemg4et0k39p88k7mfw08gaa" })
    paymentAddress?: string;
    @ApiProperty({
        example: "0x464250526641000100000000000000000000000000000000000000000007f625",
    })
    paymentReference?: string;
}

export class CREventExtended extends CREvent {
    @ApiProperty({ example: "0x0048508b510502555ED47E98dE98Dd6426dDd0C4" })
    from: string;
}

export class MintingStatus {
    @ApiProperty({ example: false })
    status: boolean;
    @ApiProperty({ example: 1 })
    step: number;
}

export class RedemptionFeeData {
    @ApiProperty({ example: "FXRP" })
    fasset: string;
    @ApiProperty({ example: "0.5" })
    feePercentage: string;
    @ApiProperty({ example: "20" })
    feeUSD: string;
}

export class AssetPrice {
    @ApiProperty({ example: "0.3" })
    price: number;
}

export class CRFee {
    @ApiProperty({ example: "125326247" })
    collateralReservationFee: string;
}

export class MaxLots {
    @ApiProperty({ example: "55" })
    maxLots: string;
    @ApiProperty({ example: "true" })
    lotsLimited: boolean;
}

export class RedemptionFee {
    @ApiProperty({ example: "10" })
    redemptionFee: string;
    @ApiProperty({ example: 123 })
    maxRedemptionLots: number;
    @ApiProperty({ example: 212 })
    maxLotsOneRedemption: number;
}

export class ProtocolFees {
    @ApiProperty({ example: "10" })
    redemptionFee: string;
}

export class RedemptionStatus {
    @ApiProperty({ example: "DEFAULT" })
    status: RedemptionStatusEnum;
    @ApiProperty({ example: "true" })
    incomplete: boolean;
    @ApiProperty({ example: "redeemer: 0x0048508b510502555ED47E98dE98Dd6426dDd0C4, remainingLots: 30" })
    incompleteData: RedemptionIncomplete;
}

export class RedemptionDefaultStatus {
    @ApiProperty({ example: true })
    status: boolean;
    @ApiProperty({ example: "12.4" })
    underlyingPaid?: string;
    @ApiProperty({ example: "10.1" })
    vaultCollateralPaid?: string;
    @ApiProperty({ example: "10.1" })
    poolCollateralPaid?: string;
    @ApiProperty({ example: "testETH" })
    vaultCollateral?: string;
    @ApiProperty({ example: "FTestXRP" })
    fasset?: string;
}

export class RedemptionDefaultStatusGrouped {
    @ApiProperty({ example: true })
    status: boolean;
    @ApiProperty({ example: "12.4" })
    underlyingPaid?: string;
    @ApiProperty({ example: "10.1" })
    vaultCollateralPaid?: VaultCollateralRedemption[];
    @ApiProperty({ example: "10.1" })
    poolCollateralPaid?: string;
    @ApiProperty({ example: "testETH" })
    vaultCollateral?: string;
    @ApiProperty({ example: "FTestXRP" })
    fasset?: string;
    @ApiProperty({ example: "1,000.0" })
    redeemedTokens?: string;
}

export class VaultCollateralRedemption {
    @ApiProperty({ example: "1,200.11" })
    value: string;
    @ApiProperty({ example: "testETH" })
    token: string;
}

export class XRPAccountInfo {
    @ApiProperty({ example: false })
    depositAuth?: boolean;
    @ApiProperty({ example: false })
    destTagReq?: boolean;
}

export class CommonBalance {
    @ApiProperty({ example: "1,200.11" })
    balance: string;
    accountInfo?: XRPAccountInfo;
}

export class NativeBalanceItem extends CommonBalance {
    @ApiProperty({ example: "CFLR" })
    symbol: string;
    @ApiProperty({ example: "1,200.11" })
    wrapped?: string;
    valueUSD?: string;
    lots?: string;
}

export class AgentPoolCommon {
    @ApiProperty({ example: "0x71FD59e46cab8ed0F10B55d7eab39e6ecbb273a2" })
    vault: string;
    @ApiProperty({ example: "5,391,703.512" })
    totalPoolCollateral: string;
    @ApiProperty({ example: "3.6" })
    poolCR: string;
    @ApiProperty({ example: "2.5" })
    vaultCR: string;
    @ApiProperty({ example: "40" })
    feeShare: string;
    @ApiProperty({ example: "Flare" })
    agentName: string;
    @ApiProperty({ example: "FTestXRP" })
    vaultType: string;
    @ApiProperty({ example: "4.6" })
    poolExitCR: string;
    @ApiProperty({ example: "100" })
    freeLots: string;
    @ApiProperty({ example: "false" })
    status: string;
    @ApiProperty({ example: 0 })
    health: number;
    @ApiProperty({
        example: "https://interactivechaos.com/sites/default/files/2023-02/super_mario.png",
    })
    url: string;
}

export class AgentPoolItem extends AgentPoolCommon {
    @ApiProperty({ example: "0x71FD59e46cab8ed0F10B55d7eab39e6ecbb273a2" })
    pool: string;
    @ApiProperty({ example: "100.12" })
    userPoolBalance?: string;
    @ApiProperty({ example: "10.1" })
    userPoolFees?: string;
    @ApiProperty({ example: "1,222.1" })
    userPoolNatBalance?: string;
    @ApiProperty({ example: "1,222.1" })
    userPoolNatBalanceInUSD?: string;
    @ApiProperty({ example: "2.1" })
    userPoolShare?: string;
    @ApiProperty({ example: "100" })
    mintCount: number;
    @ApiProperty({ example: "3" })
    numLiquidations: number;
    @ApiProperty({ example: "99.5" })
    redeemRate: string;
    @ApiProperty({ example: "10,234.12" })
    poolCollateralUSD: string;
    @ApiProperty({ example: "202.12" })
    vaultCollateral: string;
    @ApiProperty({ example: "testUSDC" })
    collateralToken: string;
    @ApiProperty({ example: "100.2" })
    transferableTokens?: string;
    @ApiProperty({ example: "0xDF3Fc879BF162320dC46900Cf6ba698F26b13c1D" })
    tokenAddress: string;
    @ApiProperty({ example: "1.86645" })
    fassetDebt?: string;
    @ApiProperty({ example: "14.667" })
    nonTimeLocked?: string;
    @ApiProperty({ example: "3.5" })
    mintingPoolCR: string;
    @ApiProperty({ example: "3.4" })
    mintingVaultCR: string;
    @ApiProperty({ example: "2.6" })
    vaultCCBCR: string;
    @ApiProperty({ example: "2.3" })
    vaultMinCR: string;
    @ApiProperty({ example: "1.4" })
    vaultSafetyCR: string;
    @ApiProperty({ example: "4.5" })
    poolCCBCR: string;
    @ApiProperty({ example: "5.4" })
    poolMinCR: string;
    @ApiProperty({ example: "3.3" })
    poolSafetyCR: string;
    @ApiProperty({ example: "1.2" })
    mintFee: string;
    @ApiProperty({ example: "Some description about agent." })
    description: string;
    @ApiProperty({ example: "29,773.02" })
    mintedAssets: string;
    @ApiProperty({ example: "16,234.037" })
    mintedUSD: string;
    @ApiProperty({ example: "4160" })
    remainingAssets: string;
    @ApiProperty({ example: "2,268.282" })
    remainingUSD: string;
    @ApiProperty({ example: "208" })
    allLots: number;
    @ApiProperty({ example: "41,565.156" })
    poolOnlyCollateralUSD: string;
    @ApiProperty({ example: "25,859.734" })
    vaultOnlyCollateralUSD: string;
    @ApiProperty({ example: "1.23" })
    userPoolFeesUSD?: string;
    @ApiProperty({ example: "25,859.734" })
    totalPortfolioValueUSD: string;
    @ApiProperty({ example: "25,859.734" })
    limitUSD: string;
    @ApiProperty({
        example: "https://interactivechaos.com/sites/default/files/2023-02/super_mario.png",
    })
    infoUrl: string;
    @ApiProperty({ example: "25,859.734" })
    lifetimePoolClaimed?: string;
    @ApiProperty({ example: "25,859.734" })
    lifetimePoolClaimedUSD?: string;
    @ApiProperty({ example: "12345567" })
    userPoolTokensFull?: string;
}

export class AgentPoolLatest extends AgentPoolCommon {
    @ApiProperty({ example: "1.2" })
    mintFee: string;
    @ApiProperty({ example: "200" })
    feeBIPS: string;
    @ApiProperty({ example: "0xDF3Fc879BF162320dC46900Cf6ba698F26b13c1D" })
    underlyingAddress: string;
}

export class FeeEstimate {
    @ApiProperty({ example: "1079" })
    estimatedFee: string;
    @ApiProperty({ example: "0.002158" })
    extraBTC: string;
}

export class MaxWithdraw {
    @ApiProperty({ example: "100.1" })
    natReturn: string;
    @ApiProperty({ example: "1.2" })
    fees: string;
}

export class MaxCPTWithdraw {
    @ApiProperty({ example: "100.12" })
    maxWithdraw: string;
}

export class DepositLotsToNat {
    @ApiProperty()
    message: string;
}
export class DepositNatToLots extends DepositLotsToNat {
    @ApiProperty()
    createdLots: string;
}

export class BestAgent {
    @ApiProperty({ example: "0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8" })
    agentAddress: string;
    @ApiProperty({ example: "1586629213483146067" })
    collateralReservationFee: string;
    @ApiProperty({ example: "54" })
    feeBIPS: string;
    @ApiProperty({ example: "155" })
    maxLots: string;
    @ApiProperty({ example: "Forevernode" })
    agentName: string;
    @ApiProperty({ example: "0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8" })
    underlyingAddress: string;
    @ApiProperty({ example: "www.google.com" })
    infoUrl: string;
}

export class AddressResponse {
    @ApiProperty({ example: "0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8" })
    address: string;
}

export class ReturnAddresses {
    @ApiProperty({ example: "[0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8, 0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8]" })
    addresses: string[];
    @ApiProperty({ example: "12456" })
    estimatedFee: string;
}

export class SelectedUTXOs {
    @ApiProperty({
        example: "cfe46aba4d7e1cfe98282bc000c228e29ff2858c4c2af6fe258bff60846bbff1",
    })
    txid: string;
    @ApiProperty({ example: "1" })
    vout: number;
    @ApiProperty({ example: "40100" })
    value: string;
    @ApiProperty({ example: "0200000000010152988c42843124dc2aef7389f55a69eb" })
    hexTx: string;
    @ApiProperty({ example: "m/44'/1'/0'/0/1" })
    path: string;
    @ApiProperty({ example: "mgRHcps6LVXExPVccAwSwriBSm134dck8o" })
    utxoAddress: string;
    @ApiProperty({ example: "0" })
    index: string;
}

export class PrepareUtxos {
    @ApiProperty({ example: "asga" })
    psbt: string;
    @ApiProperty({ example: "12456" })
    estimatedFee: string;
}

export class ExecutorResponse {
    @ApiProperty({ example: "0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8" })
    executorAddress: string;
    @ApiProperty({ example: "100000000000000000" })
    executorFee: string;
    @ApiProperty({ example: "10" })
    redemptionFee: string;
}

export class AvailableFassets {
    @ApiProperty({ example: "[FTestXRP, FTestBTC]" })
    fassets: string[];
}

export class MintingTransaction {
    @ApiProperty({ example: "0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8" })
    paymentReference: string;
    @ApiProperty({ example: "rfkjtg" })
    destinationAddress: string;
    @ApiProperty({ example: "12400" })
    amount: string;
    @ApiProperty({ example: "Agent" })
    agentName: string;
    @ApiProperty({ example: "123456" })
    lastUnderlyingBlock: string;
    @ApiProperty({ example: "123" })
    expirationMinutes: string;
}

export class Progress {
    @ApiProperty({ example: "REDEEM" })
    action: string;
    @ApiProperty({ example: 1726125839877 })
    timestamp: number;
    @ApiProperty({ example: "660" })
    amount: string;
    @ApiProperty({ example: "FTestXRP" })
    fasset: string;
    @ApiProperty({ example: true })
    status: boolean;
    @ApiProperty({ example: false })
    defaulted: boolean;
    @ApiProperty({ example: "12345" })
    ticketID?: string;
    @ApiProperty({ example: "FTestXRP" })
    vaultToken?: string;
    @ApiProperty({ example: "390.666" })
    vaultTokenValueRedeemed?: string;
    @ApiProperty({ example: "390.666" })
    poolTokenValueRedeemed?: string;
    @ApiProperty({ example: "390.666" })
    underlyingPaid?: string;
    @ApiProperty({ example: true })
    incomplete?: boolean;
    @ApiProperty({ example: "30" })
    remainingLots?: string;
    @ApiProperty({ example: true })
    missingUnderlying?: boolean;
    @ApiProperty({ example: "Data for underlyingTx" })
    underlyingTransactionData?: MintingTransaction;
    @ApiProperty({ example: true })
    redemptionBlocked?: boolean;
}

export class submitTxResponse {
    @ApiProperty({ example: "0x7b7204684854Da846E49dEFd1408b52c4e0E3ce8" })
    hash: string;
}

export class RequestRedemption {
    @ApiProperty({ example: true })
    incomplete: boolean;
    @ApiProperty({ example: "30" })
    remainingLots?: string;
}

export class SelectedUTXO {
    @ApiProperty({
        example: "cfe46aba4d7e1cfe98282bc000c228e29ff2858c4c2af6fe258bff60846bbff1",
    })
    txid: string;
    @ApiProperty({ example: "1" })
    vout: number;
    @ApiProperty({ example: "40100" })
    value: string;
    @ApiProperty({ example: "0200000000010152988c42843124dc2aef7389f55a69eb" })
    hexTx: string;
    @ApiProperty({ example: "m/44'/1'/0'/0/1" })
    path: string;
    @ApiProperty({ example: "mgRHcps6LVXExPVccAwSwriBSm134dck8o" })
    utxoAddress: string;
}

export class UTXOSLedger {
    @ApiProperty({ example: "" })
    selectedUtxos: SelectedUTXO[];
    @ApiProperty({ example: "12456" })
    estimatedFee: number;
    @ApiProperty({ example: "" })
    returnAddresses: string[];
}

export class SupplyFasset {
    @ApiProperty()
    fasset: string;
    @ApiProperty()
    supply: string;
    @ApiProperty()
    minted: string;
    @ApiProperty()
    availableToMintUSD: string;
    @ApiProperty()
    availableToMintLots: number;
    @ApiProperty()
    allLots: number;
    @ApiProperty()
    mintedPercentage: string;
    @ApiProperty()
    mintedLots: number;
}

export class SupplyTotalCollateral {
    @ApiProperty()
    symbol: string;
    @ApiProperty()
    supply: string;
    @ApiProperty()
    supplyUSD: string;
}

export class FassetTimeSupply {
    @ApiProperty()
    timestamp: number;
    @ApiProperty()
    value: string;
}

export class FassetSupplyDiff {
    @ApiProperty()
    fasset: string;
    @ApiProperty()
    diff: string;
    @ApiProperty()
    isPositive: boolean;
}

export class PoolCollateralDiff {
    @ApiProperty()
    diff: string;
    @ApiProperty()
    isPositive: boolean;
}

export class TimeSeries {
    @ApiProperty()
    timestamp: number;
    @ApiProperty()
    value: string;
}

export class TimeSeriesIndexer {
    @ApiProperty()
    index: string;
    @ApiProperty()
    start: number;
    @ApiProperty()
    end: number;
    @ApiProperty()
    value: string;
}

export class TopPoolIndexer {
    @ApiProperty()
    pool: string;
    @ApiProperty()
    score: string;
    @ApiProperty()
    claimed: string;
}

export class TopPoolData {
    @ApiProperty()
    name: string;
    @ApiProperty()
    vaultAddress: string;
    @ApiProperty()
    poolAddress: string;
    @ApiProperty()
    fasset: string;
    @ApiProperty()
    collateralSymbol: string;
    @ApiProperty()
    tvl: string;
    @ApiProperty()
    rewardsPaid: string;
    @ApiProperty()
    url: string;
}

export class TopPool extends TopPoolData {
    @ApiProperty()
    tvlDiff: string;
    @ApiProperty()
    tvlDiffPositive: boolean;
    @ApiProperty()
    rewardsDiff: string;
    @ApiProperty()
    rewardsDiffPositive: boolean;
}

export class PoolRewards {
    @ApiProperty()
    fasset: string;
    @ApiProperty()
    rewards: string;
    @ApiProperty()
    rewardsUSD: string;
}

export class EcosystemData {
    @ApiProperty()
    tvl: string;
    @ApiProperty()
    tvlPoolsNat: string;
    @ApiProperty()
    numTransactions: string;
    @ApiProperty()
    numAgents: number;
    @ApiProperty()
    agentsInLiquidation: number;
    @ApiProperty({ type: [SupplyFasset] })
    supplyByFasset: SupplyFasset[];
    @ApiProperty()
    totalMinted: string;
    @ApiProperty()
    numLiquidations: number;
    @ApiProperty()
    rewardsAvailableUSD: string;
    @ApiProperty()
    overCollaterazied: string;
    @ApiProperty({ type: [SupplyTotalCollateral] })
    supplyByCollateral: SupplyTotalCollateral[];
    @ApiProperty()
    totalCollateral: string;
    @ApiProperty()
    numMints: number;
    @ApiProperty({ type: [PoolRewards] })
    poolRewards: PoolRewards[];
    @ApiProperty()
    totalPoolRewardsPaidUSD: string;
    @ApiProperty()
    numHolders: number;
    @ApiProperty()
    agentCollateral: string;
}

export class TimeDataCV {
    @ApiProperty()
    supplyDiff: string;
    @ApiProperty({ type: [TimeSeries] })
    inflowGraph: TimeSeries[];
    @ApiProperty({ type: [TimeSeries] })
    outflowGraph: TimeSeries[];
    @ApiProperty()
    isPositiveSupplyDiff: boolean;
    @ApiProperty({ type: [TimeSeries] })
    tvlGraph: TimeSeries[];
    @ApiProperty()
    inflowDiff: string;
    @ApiProperty()
    outflowDiff: string;
    @ApiProperty()
    isPositiveInflowDiff: boolean;
    @ApiProperty()
    isPositiveOutflowDiff: boolean;
}

export class TimeData {
    @ApiProperty({ type: [FassetSupplyDiff] })
    supplyDiff: FassetSupplyDiff[];
    @ApiProperty({ type: [TimeSeries] })
    mintGraph: TimeSeries[];
    @ApiProperty({ type: [TimeSeries] })
    redeemGraph: TimeSeries[];
    @ApiProperty({ type: [TopPool] })
    bestPools: TopPool[];
    @ApiProperty()
    totalCollateralDiff: string;
    @ApiProperty()
    isPositiveCollateralDiff: boolean;
    @ApiProperty()
    coreVaultData: TimeDataCV;
}

export class FassetStatus {
    @ApiProperty({ example: "FXRP" })
    fasset: string;
    @ApiProperty({ example: true })
    status: boolean;
}

export class RedemptionQueue {
    @ApiProperty({ example: 12 })
    maxLotsOneRedemption: number;
    @ApiProperty({ example: 55 })
    maxLots: number;
}
