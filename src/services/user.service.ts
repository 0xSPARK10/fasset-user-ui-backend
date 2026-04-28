/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inject, Injectable } from "@nestjs/common";
import {
    AddressResponse,
    AssetPrice,
    AvailableFassets,
    BestAgent,
    CommonBalance,
    CostonExpTokenBalance,
    CREvent,
    CREventExtended,
    CRFee,
    CRStatus,
    DirectMintingExecutorResponse,
    DirectMintingInfoResponse,
    ExecutorResponse,
    MintingRecipientResponse,
    TagReservationFeeResponse,
    FassetStatus,
    FeeEstimate,
    IndexerTokenBalances,
    LotSize,
    MaxCPTWithdraw,
    MaxLots,
    MintingCapInfo,
    MaxWithdraw,
    MintingStatus,
    NativeBalanceItem,
    NativeBalanceItemTokenAddress,
    ProtocolFees,
    RedemptionDefaultStatusGrouped,
    RedemptionFee,
    RedemptionFeeData,
    RedemptionQueue,
    RedemptionStatus,
    RequestMint,
    RequestRedemption,
    submitTxResponse,
    TagInfo,
    VaultCollateralRedemption,
} from "../interfaces/requestResponse";
import { BotService } from "./bot.init.service";
import { EntityManager } from "@mikro-orm/core";
import { Minting } from "../entities/Minting";
import { DirectMinting, DirectMintingStatus } from "../entities/DirectMinting";
import { Redemption } from "../entities/Redemption";
import { LotsException } from "../exceptions/lots.exception";
import { Pool } from "../entities/Pool";
import {
    bigintPow10,
    calculateExpirationMinutes,
    calculateUSDValueBigInt,
    formatBigIntToDisplayDecimals,
    formatFixedBigInt,
    isValidWalletAddress,
    sleep,
    timestampToDateString,
    dateStringToTimestamp,
} from "src/utils/utils";
import { EXECUTION_FEE, FILTER_AGENT, NETWORK_SYMBOLS, RedemptionStatusEnum, SONGBIRD_EXECUTOR_ADDRESS, SONGBIRD_EXECUTOR_FEE } from "src/utils/constants";
import { ClaimedPools, EcosystemData, FullRedeemData, RedeemData, RedemptionData, RedemptionIncomplete, TimeData } from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { FullRedemption } from "src/entities/RedemptionWhole";
import { Collateral } from "src/entities/Collaterals";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { ExternalApiService } from "./external.api.service";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { ConfigService } from "@nestjs/config";
import { lastValueFrom } from "rxjs";
import { HttpService } from "@nestjs/axios";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { RedemptionRequested as RedemptionRequestedEntity } from "src/entities/RedemptionRequested";
import { RedemptionWithTagRequestedEvent } from "src/entities/RedemptionWithTagRequestedEvent";
import { RedemptionAmountIncompleteEvent } from "src/entities/RedemptionAmountIncompleteEvent";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { XRPLApiService } from "./xrpl-api.service";
import { ChainType, Wallet } from "src/entities/Wallet";
import { ContractService } from "./contract.service";
import { IIAssetManager, IAgentOwnerRegistry, IRelay__factory, IPriceReader, IFAsset, ERC20__factory, IWNat } from "../typechain-ethers-v6";
import { EthersService } from "./ethers.service";
import { FassetConfigService } from "./fasset.config.service";
import { keccak256, toUtf8Bytes } from "ethers";

const NUM_RETRIES = 3;
const MAX_BIPS = 10_000;

const sigCollateralReserved = keccak256(
    toUtf8Bytes("CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)")
);

@Injectable()
export class UserService {
    envType: string;
    private costonExplorerUrl: string;
    constructor(
        private readonly botService: BotService,
        private readonly em: EntityManager,
        private readonly configService: ConfigService,
        private readonly httpService: HttpService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly externalApiService: ExternalApiService,
        private readonly xrplService: XRPLApiService,
        private readonly contractService: ContractService,
        private readonly ethersService: EthersService,
        private readonly fassetConfigService: FassetConfigService
    ) {
        this.envType = this.configService.get<string>("APP_TYPE");
        this.costonExplorerUrl = this.configService.get<string>("COSTON_EXPLORER_URL");
    }

    /**
     * Returns the IIAssetManager contract for a given fasset symbol.
     * The deployment name follows the convention: AssetManager_<fasset>
     */
    private getAssetManager(fasset: string): IIAssetManager {
        return this.contractService.get<IIAssetManager>(`AssetManager_${fasset}`);
    }

    /**
     * Returns the IFAsset contract for a given fasset symbol.
     * The deployment name is just the fasset symbol.
     */
    private getFAsset(fasset: string): IFAsset {
        return this.contractService.get<IFAsset>(fasset);
    }

    /**
     * Returns the AgentOwnerRegistry contract.
     */
    private getAgentOwnerRegistry(): IAgentOwnerRegistry {
        return this.contractService.get<IAgentOwnerRegistry>("AgentOwnerRegistry");
    }

    /**
     * Returns the PriceReader contract.
     */
    private getPriceReader(): IPriceReader {
        return this.contractService.get<IPriceReader>("PriceReader");
    }

    //TODO: add verification return and filter by agent with no verification first
    async getBestAgent(fasset: string, lots: number): Promise<BestAgent> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const bestAgent = await this.findBestAgent(BigInt(lots), fasset);
            if (bestAgent == null) {
                throw new LotsException("Agents need to increase collateral in the system to enable minting.");
            }
            const maxLots = await this.getMaxLots(fasset);
            if (BigInt(maxLots.maxLots) === 0n) {
                throw new LotsException("All FAssets are currently minted.");
            }
            if (BigInt(lots) > BigInt(maxLots.maxLots)) {
                throw new LotsException("Cannot mint more than " + maxLots.maxLots + " lots at once.");
            }
            const collateralReservationFee = await assetManager.collateralReservationFee(lots);
            const agentInfo = await assetManager.getAgentInfo(bestAgent);
            const feeBIPS = agentInfo.feeBIPS;
            const agentOwnerRegistry = this.getAgentOwnerRegistry();
            const agentName = await agentOwnerRegistry.getAgentName(agentInfo.ownerManagementAddress);
            const pool = await this.em.findOne(Pool, {
                vaultAddress: bestAgent,
            });
            return {
                agentAddress: bestAgent,
                feeBIPS: feeBIPS.toString(),
                collateralReservationFee: collateralReservationFee.toString(),
                maxLots: maxLots.maxLots,
                agentName: agentName,
                underlyingAddress: agentInfo.underlyingAddressString,
                infoUrl: pool.infoUrl,
            };
        } catch (error) {
            logger.error("Error in getBestAgent:", error);
            throw error;
        }
    }

    /**
     * Taken from fasset-bots and repurposed for agent filtering.
     */
    async getAvailableAgents(chunkSize = 10, fasset: string): Promise<{ agentVault: string; feeBIPS: bigint; freeCollateralLots: bigint }[]> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const result: { agentVault: string; feeBIPS: bigint; freeCollateralLots: bigint }[] = [];
            let start = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const [list] = await assetManager.getAvailableAgentsDetailedList(start, start + chunkSize);
                for (const agent of list) {
                    result.push({
                        agentVault: agent.agentVault,
                        feeBIPS: agent.feeBIPS,
                        freeCollateralLots: agent.freeCollateralLots,
                    });
                }
                if (list.length < chunkSize) break;
                start += list.length;
            }
            const filtered = result.filter((a) => a.agentVault.toLowerCase() != FILTER_AGENT);
            return filtered;
        } catch (error) {
            logger.error("Error in getAvailableAgents:", error);
            throw error;
        }
    }

    async findBestAgent(minAvailableLots: bigint, fasset: string): Promise<string | undefined> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const agents = await this.getAvailableAgents(10, fasset);
            let eligible = agents.filter((a) => a.freeCollateralLots >= minAvailableLots);
            if (eligible.length === 0) return undefined;
            eligible.sort((a, b) => (a.feeBIPS < b.feeBIPS ? -1 : a.feeBIPS > b.feeBIPS ? 1 : 0));
            while (eligible.length > 0) {
                const lowestFee = eligible[0].feeBIPS;
                let optimal = eligible.filter((a) => a.feeBIPS === lowestFee);
                while (optimal.length > 0) {
                    const randomIndex = Math.floor(Math.random() * optimal.length);
                    const agentVault = optimal[randomIndex].agentVault;
                    const info = await assetManager.getAgentInfo(agentVault);
                    if (Number(info.status) === 0) {
                        return agentVault;
                    }
                    // agent is in liquidation or something, remove it and try another
                    optimal = optimal.filter((a) => a.agentVault !== agentVault);
                    eligible = eligible.filter((a) => a.agentVault !== agentVault);
                }
            }
        } catch (error) {
            logger.error("Error in findBestAgent:", error);
            throw error;
        }
    }

    async getCRTFee(fasset: string, lots: number): Promise<CRFee> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const collateralReservationFee = await assetManager.collateralReservationFee(lots);
            return { collateralReservationFee: collateralReservationFee.toString() };
        } catch (error) {
            logger.error("Error in getCRTFee:", error);
            throw error;
        }
    }

    /**
     * Returns the current FAsset ERC20 total supply and the AssetManager minting cap,
     * both in raw UBA (smallest units). `mintingCap` is "0" when the AssetManager has
     * no cap configured (settings.mintingCapAMG === 0n).
     */
    async getMintingCapInfo(fasset: string): Promise<MintingCapInfo> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const fAsset = this.getFAsset(fasset);
            const [settings, totalSupply] = await Promise.all([assetManager.getSettings(), fAsset.totalSupply()]);
            const mintingCapUBA = settings.mintingCapAMG * settings.assetMintingGranularityUBA;
            return {
                totalSupply: totalSupply.toString(),
                mintingCap: mintingCapUBA.toString(),
            };
        } catch (error) {
            logger.error(`Error in getMintingCapInfo for ${fasset}:`, error);
            throw error;
        }
    }

    async getMaxLots(fasset: string): Promise<MaxLots> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const fAsset = this.getFAsset(fasset);
            const agents = await this.getAvailableAgents(10, fasset);
            const settings = await assetManager.getSettings();
            const tokenSupply = await fAsset.totalSupply();
            let reserved = 0n;
            const lotSizeUBA = settings.lotSizeAMG * settings.assetMintingGranularityUBA;
            const mintingCap = settings.mintingCapAMG * settings.assetMintingGranularityUBA;
            if (mintingCap !== 0n) {
                for (const a of agents) {
                    const info = await assetManager.getAgentInfo(a.agentVault);
                    reserved = reserved + info.reservedUBA;
                }
            }
            if (tokenSupply >= mintingCap && mintingCap !== 0n) {
                throw new LotsException("The minting cap for " + fasset + " has been reached. No new minting is available.");
            }
            const availableToMintUBA = mintingCap === 0n ? 0n : mintingCap - (tokenSupply + reserved);
            const availableToMintLots = mintingCap === 0n ? 0n : availableToMintUBA / lotSizeUBA;
            const eligibleAgents = [];
            if (agents.length == 0) {
                throw new LotsException("There are currently no available agents for " + fasset + ".");
            }
            for (const agent of agents) {
                const pools = await this.em.find(Pool, {
                    vaultAddress: agent.agentVault,
                });
                const pool = pools[0];
                if (Number(pool.status) === 0) {
                    eligibleAgents.push(agent);
                }
            }
            const maxLots = eligibleAgents.reduce((max, current) => {
                return Number(current.freeCollateralLots) > max ? Number(current.freeCollateralLots) : max;
            }, Number.NEGATIVE_INFINITY);
            const lots = mintingCap === 0n ? Number(maxLots) : Math.min(Number(maxLots), Number(availableToMintLots));
            let lotsLimited = false;
            if (Number(maxLots) > Number(availableToMintLots) && mintingCap !== 0n) {
                lotsLimited = true;
            }
            return { maxLots: lots.toString(), lotsLimited: lotsLimited };
        } catch (error) {
            logger.error("Error in getMaxLots:", error);
            throw error;
        }
    }

    async getLotSize(fasset: string): Promise<LotSize> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const settings = await assetManager.getSettings();
            const lotSize = Number(settings.lotSizeAMG) * Number(settings.assetMintingGranularityUBA);
            const formatted = lotSize / 10 ** Number(settings.assetDecimals);
            return { lotSize: formatted };
        } catch (error) {
            logger.error("Error in getLotSize:", error);
            throw error;
        }
    }

    async checkStateFassets(): Promise<any> {
        try {
            const stateF = [];
            for (const f of this.botService.fassetList) {
                const assetManager = this.getAssetManager(f);
                const state = await assetManager.emergencyPaused();
                stateF.push({ fasset: f, state: state });
            }
            return stateF;
        } catch (error) {
            logger.error("Error in checkStateFassets:", error);
            throw error;
        }
    }

    //TODO: add trailing fee return
    //Trailing fee: transferAmount * transferFeeMillionths / 10^6 = transferFee, no fee on mint/redeem
    /**
     * Returns redemption fee info including minimum redeem amount for the given fasset.
     * minimumRedeemAmountUBA is converted from AMG to UBA (drops) using assetMintingGranularityUBA.
     */
    async getRedemptionFee(fasset: string): Promise<RedemptionFee> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const settings = await assetManager.getSettings();
            // Calculate minimum redeem amount in UBA from AMG
            const minimumRedeemAmountUBA = (await assetManager.minimumRedeemAmountUBA()).toString();
            if (fasset.includes("XRP")) {
                const redQueue = await this.getRedemptionQueue(fasset);
                return {
                    redemptionFee: settings.redemptionFeeBIPS.toString(),
                    maxLotsOneRedemption: redQueue.maxLotsOneRedemption,
                    maxRedemptionLots: redQueue.maxLots,
                    minimumRedeemAmountUBA,
                };
            }
            return { redemptionFee: settings.redemptionFeeBIPS.toString(), maxLotsOneRedemption: -1, maxRedemptionLots: -1, minimumRedeemAmountUBA };
        } catch (error) {
            logger.error("Error in getRedemptionFee:", error);
            throw error;
        }
    }

    async getProtocolFees(fasset: string): Promise<ProtocolFees> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const settings = await assetManager.getSettings();
            return { redemptionFee: settings.redemptionFeeBIPS.toString() };
        } catch (error) {
            logger.error("Error in getProtocolFees:", error);
            throw error;
        }
    }

    async getAssetManagerAddress(fasset: string): Promise<AddressResponse> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const address = await assetManager.getAddress();
            return { address };
        } catch (error) {
            logger.error("Error in getAssetManagerAddress:", error);
            throw error;
        }
    }

    async getCollateralReservationFee(fasset: string, lots: number): Promise<any> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const fee = await assetManager.collateralReservationFee(lots);
            return fee.toString();
        } catch (error) {
            logger.error("Error in getCollateralReservationFee:", error);
            throw error;
        }
    }

    async getExecutorAddress(fasset: string): Promise<ExecutorResponse> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const settings = await assetManager.getSettings();
            return {
                executorAddress: this.ethersService.getExecutorAddress(),
                executorFee: EXECUTION_FEE.toString(),
                redemptionFee: settings.redemptionFeeBIPS.toString(),
            };
        } catch (error) {
            logger.error("Error in getExecutorAddress:", error);
            throw error;
        }
    }

    async requestMinting(requestMint: RequestMint): Promise<void> {
        if (requestMint.underlyingWalletId && isValidWalletAddress(requestMint.userUnderlyingAddress)) {
            const undWallet = await this.em.findOne(Wallet, { address: requestMint.userUnderlyingAddress });
            if (!undWallet) {
                const wallet = new Wallet(requestMint.userUnderlyingAddress, ChainType.XRP, requestMint.underlyingWalletId);
                await this.em.persistAndFlush(wallet);
            }
        }
        if (requestMint.nativeWalletId && isValidWalletAddress(requestMint.userAddress)) {
            const natWallet = await this.em.findOne(Wallet, { address: requestMint.userAddress });
            if (!natWallet) {
                const wallet = new Wallet(requestMint.userAddress, ChainType.EVM, requestMint.nativeWalletId);
                await this.em.persistAndFlush(wallet);
            }
        }
        if (requestMint.collateralReservationId == "") {
            return;
        }
        const count = await this.em.count(Minting, { txhash: requestMint.txhash });
        if (count != 0) {
            //throw new LotsException("Minting with this txhash already exists.");
            return;
        }
        let crEvent;
        crEvent = await this.em.findOne(CollateralReservationEvent, { collateralReservationId: requestMint.collateralReservationId });
        if (!crEvent) {
            crEvent = (await this.getCREventFromTxHash(requestMint.fasset, requestMint.nativeHash, true)) as CREventExtended;
        }
        const now = new Date();
        if (this.isValidRippleTxHash(requestMint.txhash)) {
            const underlyingPayment = new UnderlyingPayment(crEvent.paymentReference, requestMint.txhash, now.getTime());
            await this.em.persistAndFlush(underlyingPayment);
        }
    }

    isValidRippleTxHash(hash: string): boolean {
        const rippleTxHashRegex = /^[A-Fa-f0-9]{64}$/;
        return rippleTxHashRegex.test(hash);
    }

    /**
     * Returns the minting progress status for a given txhash.
     * First checks traditional Minting entities (agent-based minting with proof rounds),
     * then falls back to DirectMinting entities (Core Vault direct minting).
     * For DirectMinting: uses a 90-second grace period after creation before showing
     * progress, and includes delayed/delayTimestamp fields for the FE.
     */
    async mintingStatus(txhash: string): Promise<MintingStatus> {
        const minting = await this.em.findOne(Minting, { txhash: txhash });

        // Traditional minting path — uses Relay contract for proof round progress
        if (minting) {
            const relay = this.contractService.get<ReturnType<typeof IRelay__factory.connect>>("Relay");
            const now = Math.floor(Date.now() / 1000);
            const currentRound = Number(await relay.getVotingRoundId(now));

            if (minting.processed == false && minting.state == false && minting.proved == false) {
                return { status: minting.processed, step: 0 };
            }
            if (minting.processed == false && minting.state == true && minting.proved == false) {
                if (minting.proofRequestRound - currentRound == 4) {
                    return { status: minting.processed, step: 0 };
                }
                if (minting.proofRequestRound - currentRound == 3) {
                    return { status: minting.processed, step: 1 };
                }
                if (minting.proofRequestRound - currentRound == 2) {
                    return { status: minting.processed, step: 2 };
                }
                if (minting.proofRequestRound - currentRound == 1) {
                    return { status: minting.processed, step: 3 };
                }
                if (minting.proofRequestRound - currentRound == 0) {
                    return { status: minting.processed, step: 3 };
                }
                if (minting.proofRequestRound - currentRound < 0) {
                    return { status: minting.processed, step: 3 };
                }
            }
            if (minting.processed == false && minting.state == true && minting.proved == true) {
                return { status: minting.processed, step: 3 };
            }
            if (minting.processed == true && minting.state == true && minting.proved == true) {
                return { status: minting.processed, step: 4 };
            }
        }

        // Direct minting path — Core Vault minting without agent proof rounds
        // Normalize txhash to match the 0x-prefixed lowercase format stored for DirectMintings
        const normalizedTxHash = txhash.startsWith("0x") ? txhash.toLowerCase() : "0x" + txhash.toLowerCase();
        const directMinting = await this.em.findOne(DirectMinting, { txhash: normalizedTxHash });
        if (!directMinting) {
            return { status: false, step: 0, delayed: false, delayTimestamp: 0 };
        }

        const nowMs = Date.now();
        const isDelayed = directMinting.status === DirectMintingStatus.DELAYED;

        // Already processed (executed / executed_to_smart_account / payment_too_small)
        if (directMinting.processed) {
            return { status: true, step: 4, delayed: false, delayTimestamp: 0 };
        }

        // Within 90-second grace period after the underlying tx — too early to show progress
        // directMinting.timestamp is stored in milliseconds (Date.now()), so compare in ms
        if (nowMs - directMinting.timestamp < 90_000) {
            return {
                status: false,
                step: 0,
                delayed: isDelayed,
                delayTimestamp: directMinting.delayTimestamp ?? 0,
            };
        }

        // Delayed minting — waiting for delay window to pass before execution
        if (isDelayed) {
            return {
                status: false,
                step: 0,
                delayed: true,
                delayTimestamp: directMinting.delayTimestamp ?? 0,
            };
        }

        // Not delayed, past 90 seconds — execution is pending
        return { status: false, step: 3, delayed: false, delayTimestamp: 0 };
    }

    async requestRedemption(fasset: string, txhash: string, amount: string, userAddress: string): Promise<RequestRedemption> {
        const fullRedeemData = await this.getRedemptionRequestedEvents(fasset, txhash);
        if (fullRedeemData.incomplete == true) {
            return {
                incomplete: fullRedeemData.incomplete,
                remainingLots: fullRedeemData.dataIncomplete?.remainingLots,
                remainingAmountUBA: fullRedeemData.dataIncomplete?.remainingAmountUBA,
            };
        }
        return { incomplete: fullRedeemData.incomplete };
    }

    async redemptionDefaultStatus(txhash: string): Promise<RedemptionDefaultStatusGrouped> {
        const redemptions = await this.em.find(Redemption, { txhash: txhash });
        const fullRedemption = await this.em.find(FullRedemption, { txhash: txhash });
        // If no standard Redemption entities, check tag-based redemptions
        if (redemptions.length == 0) {
            return this.redemptionDefaultStatusForTagBased(txhash, fullRedemption);
        }
        for (const redemption of redemptions) {
            if (redemption.processed == false) {
                return { status: false };
            }
        }
        let underlyingPaid = 0n;
        const vaultCollateralPaid: VaultCollateralRedemption[] = [];
        let poolCollateralPaid = 0n;
        let vaultToken: string;
        let fasset: string;
        for (const redemption of redemptions) {
            if (redemption.defaulted == true) {
                // Query the raw chain event directly by requestId instead of the cached RedemptionDefault
                const defEvent = await this.em.findOne(RedemptionDefaultEvent, { requestId: redemption.requestId });
                if (!defEvent) {
                    logger.error(`RedemptionDefaultEvent not found for requestId ${redemption.requestId}`);
                    continue;
                }
                // Look up vault collateral token from the agent's Pool
                const agent = await this.em.find(Pool, { vaultAddress: defEvent.agentVault });
                if (!agent[0]?.vaultCollateralToken) {
                    logger.error(`Pool or collateralToken not found for agentVault ${defEvent.agentVault}`);
                    continue;
                }
                vaultToken = agent[0].vaultCollateralToken;
                fasset = redemption.fasset;
                const collateral = vaultCollateralPaid.find((paid) => paid.token === vaultToken);
                if (collateral) {
                    collateral.value = (BigInt(collateral.value) + BigInt(defEvent.redeemedVaultCollateralWei)).toString();
                } else {
                    vaultCollateralPaid.push({ token: vaultToken, value: BigInt(defEvent.redeemedVaultCollateralWei).toString() });
                }
                poolCollateralPaid = poolCollateralPaid + BigInt(defEvent.redeemedPoolCollateralWei);
            } else {
                underlyingPaid = underlyingPaid + BigInt(redemption.amountUBA);
                fasset = redemption.fasset;
            }
        }
        if (!fasset) {
            return { status: false };
        }
        const collaterals = await this.em.find(Collateral, {
            fasset: fasset,
        });
        vaultCollateralPaid.forEach((paid) => {
            const collateral = collaterals.find((collateral) => collateral.tokenFtsoSymbol === paid.token);
            if (collateral) {
                paid.value = formatBigIntToDisplayDecimals(BigInt(paid.value), vaultToken?.includes("ETH") ? 6 : 3, collateral.decimals);
            }
        });
        const poolCollateralRedeemed = formatBigIntToDisplayDecimals(poolCollateralPaid, 3, 18);
        const underlyingRedeemed = formatBigIntToDisplayDecimals(underlyingPaid, fasset.includes("XRP") ? 2 : 8, fasset.includes("XRP") ? 6 : 8);
        return {
            status: true,
            underlyingPaid: underlyingRedeemed,
            vaultCollateralPaid: vaultCollateralPaid,
            poolCollateralPaid: poolCollateralRedeemed,
            vaultCollateral: vaultToken,
            fasset: fasset,
            redeemedTokens: fullRedemption.length > 0 ? fullRedemption[0].amount : "0",
        };
    }

    /**
     * Handles default status for tag-based redemptions (RedemptionWithTagRequestedEvent).
     * Falls back here when no standard Redemption entities exist for the txhash.
     */
    private async redemptionDefaultStatusForTagBased(txhash: string, fullRedemption: FullRedemption[]): Promise<RedemptionDefaultStatusGrouped> {
        const tagEntities = await this.em.find(RedemptionWithTagRequestedEvent, { txhash: txhash });
        if (tagEntities.length === 0) {
            return { status: false };
        }

        // If any tag entity is not yet processed, status is still pending
        for (const entity of tagEntities) {
            if (entity.processed === false) {
                return { status: false };
            }
        }

        let underlyingPaid = 0n;
        const vaultCollateralPaid: VaultCollateralRedemption[] = [];
        let poolCollateralPaid = 0n;
        let vaultToken: string;
        let fasset: string;

        for (const entity of tagEntities) {
            const amountUBA = BigInt(entity.valueUBA) - BigInt(entity.feeUBA);
            if (entity.status === "DEFAULTED") {
                // Query the raw chain event directly by requestId instead of the cached RedemptionDefault
                const defEvent = await this.em.findOne(RedemptionDefaultEvent, { requestId: entity.requestId });
                if (!defEvent) {
                    logger.error(`RedemptionDefaultEvent not found for tag requestId ${entity.requestId}`);
                    continue;
                }
                // Look up vault collateral token from the agent's Pool
                const agent = await this.em.find(Pool, { vaultAddress: defEvent.agentVault });
                if (!agent[0]?.vaultCollateralToken) {
                    logger.error(`Pool or collateralToken not found for agentVault ${defEvent.agentVault}`);
                    continue;
                }
                vaultToken = agent[0].vaultCollateralToken;
                fasset = entity.fasset;
                const collateral = vaultCollateralPaid.find((paid) => paid.token === vaultToken);
                if (collateral) {
                    collateral.value = (BigInt(collateral.value) + BigInt(defEvent.redeemedVaultCollateralWei)).toString();
                } else {
                    vaultCollateralPaid.push({ token: vaultToken, value: BigInt(defEvent.redeemedVaultCollateralWei).toString() });
                }
                poolCollateralPaid = poolCollateralPaid + BigInt(defEvent.redeemedPoolCollateralWei);
            } else {
                // Completed — underlying was paid
                underlyingPaid = underlyingPaid + amountUBA;
                fasset = entity.fasset;
            }
        }

        // If no fasset was set (shouldn't happen), return false
        if (!fasset) {
            return { status: false };
        }

        const collaterals = await this.em.find(Collateral, { fasset: fasset });
        vaultCollateralPaid.forEach((paid) => {
            const collateral = collaterals.find((c) => c.tokenFtsoSymbol === paid.token);
            if (collateral) {
                paid.value = formatBigIntToDisplayDecimals(BigInt(paid.value), vaultToken?.includes("ETH") ? 6 : 3, collateral.decimals);
            }
        });
        const poolCollateralRedeemed = formatBigIntToDisplayDecimals(poolCollateralPaid, 3, 18);
        const underlyingRedeemed = formatBigIntToDisplayDecimals(underlyingPaid, fasset.includes("XRP") ? 2 : 8, fasset.includes("XRP") ? 6 : 8);
        return {
            status: true,
            underlyingPaid: underlyingRedeemed,
            vaultCollateralPaid: vaultCollateralPaid,
            poolCollateralPaid: poolCollateralRedeemed,
            vaultCollateral: vaultToken ?? null,
            fasset: fasset,
            redeemedTokens: fullRedemption.length > 0 ? fullRedemption[0].amount : "0",
        };
    }

    getUniqueAddresses(additionalAddress: string[], underlyingAddress: string): string[] {
        const filteredAddresses = additionalAddress.filter((address) => address !== underlyingAddress);
        const uniqueAddresses = new Set(filteredAddresses);
        return Array.from(uniqueAddresses);
    }

    async estimateFeeForBlocks(fasset: string): Promise<FeeEstimate> {
        if (fasset.includes("XRP")) {
            return { estimatedFee: "1000", extraBTC: "0.0045" };
        }
        const feeName = fasset.includes("BTC") ? "btcFee" : "dogeFee";
        let btcFee = await this.cacheManager.get(feeName);
        if (this.envType == "dev") {
            if (btcFee === undefined) {
                try {
                    const blockHeight = Number(await this.externalApiService.getBlockBookHeight(fasset));
                    const feeData = await this.externalApiService.getFeeEstimationBlockHeight(fasset, blockHeight);
                    btcFee = BigInt(feeData.decilesFeePerKb[feeData.decilesFeePerKb.length - 2]);
                } catch (error) {
                    btcFee = 1000000;
                }
                await this.cacheManager.set(feeName, btcFee.toString(), 600000);
            }
            const fee = Math.max(Number(BigInt(btcFee as string) / 1000n), fasset.includes("BTC") ? 50 : 500);
            const btcForBytes = 300 * fee;
            const extraBTC = this.envType == "dev" ? (btcForBytes * 1.5) / 10 ** 8 : btcForBytes / 10 ** 8;
            return { estimatedFee: fee.toFixed(0), extraBTC: extraBTC.toString() };
        } else {
            if (btcFee === undefined) {
                try {
                    const blockHeight = Number(await this.externalApiService.getBlockBookHeight(fasset));
                    const feeDataBlock1 = await this.externalApiService.getFeeEstimationBlockHeight(fasset, blockHeight);
                    const feeDataBlock2 = await this.externalApiService.getFeeEstimationBlockHeight(fasset, blockHeight - 1);
                    const feeDataBlock3 = await this.externalApiService.getFeeEstimationBlockHeight(fasset, blockHeight - 2);
                    const fee1 = feeDataBlock1.averageFeePerKb;
                    const fee2 = feeDataBlock2.averageFeePerKb;
                    const fee3 = feeDataBlock3.averageFeePerKb;

                    // Calculate the weighted average (e.g., weights: 50%, 30%, 20%)
                    btcFee = Math.floor(fee1 * 0.5 + fee2 * 0.3 + fee3 * 0.2);
                } catch (error) {
                    btcFee = 1000000;
                }
                await this.cacheManager.set(feeName, btcFee.toString(), 600000);
            }
            const fee = Math.max(Number(BigInt(btcFee as string) / 1000n), fasset.includes("BTC") ? 25 : 500);
            const btcForBytes = 300 * fee;
            const extraBTC = btcForBytes / 10 ** 8;
            return { estimatedFee: fee.toFixed(0), extraBTC: extraBTC.toString() };
        }
    }

    shuffleArray<T>(array: T[]): T[] {
        const shuffledArray = array.slice();
        for (let i = shuffledArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
        }
        return shuffledArray;
    }

    async getUnderlyingBalance(
        fasset: string,
        underlyingAddress: string,
        _additionalAddressReceive?: string[],
        _additionalAddressChange?: string[]
    ): Promise<CommonBalance> {
        try {
            for (let i = 0; i < NUM_RETRIES; i++) {
                try {
                    const accountInfo = await this.xrplService.getAccountInfo(underlyingAddress);
                    // If the XRP account is not activated (unfunded) or account_data is missing for any reason,
                    // return zero balance immediately. XRPL returns HTTP 200 with an error body for inactive
                    // accounts, so Axios won't throw — the fallback guard on account_data prevents a TypeError.
                    const result = accountInfo.data.result as any;
                    if ((result.status === "error" && result.error === "actNotFound") || !result.account_data) {
                        return {
                            balance: "0.00",
                            accountInfo: {
                                destTagReq: false,
                                depositAuth: false,
                            },
                        };
                    }
                    const balance = accountInfo.data.result.account_data.Balance;
                    const accountFlags = await this.xrplService.accountReceiveBlocked(underlyingAddress);
                    return {
                        balance: formatFixedBigInt(BigInt(balance), 6, { decimals: 2, groupDigits: true, groupSeparator: "," }),
                        accountInfo: accountFlags,
                    };
                } catch (error) {
                    logger.error(`Error in underlying balance (xrp), attempt ${i + 1} of ${NUM_RETRIES}: `, error);
                    if (i < NUM_RETRIES - 1) {
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                    } else {
                        logger.error("Error in underlying balance after max retries: ", error);
                    }
                }
            }
        } catch (error) {
            logger.error("Error in underlying balance: ", error);
        }
    }

    async getNativeBalances(address: string): Promise<NativeBalanceItem[]> {
        try {
            const provider = this.ethersService.getProvider();
            const priceReader = this.getPriceReader();

            // Get native token symbol from the first fasset's settings
            const firstFasset = this.botService.fassetList[0];
            const assetManager = this.getAssetManager(firstFasset);
            //assetManager.getCoreVaultNativeAddress()
            const settings = await assetManager.getSettings();

            // Get native token price (e.g., CFLR/FLR/SGB)
            const nativeSymbol = this.fassetConfigService.getNativeSymbol();
            const [cflrPrice, , cflrPriceDecimals] = await priceReader.getPrice(nativeSymbol);
            const priceUSD = cflrPrice * bigintPow10(18);

            const collaterals: NativeBalanceItem[] = [];
            // Native balance
            const nativeBalanceWrapped = await provider.getBalance(address);
            const balanceNative = this.formatBigIntForceDecimals(nativeBalanceWrapped, 2, 18);
            const nativeUSDFormatted = calculateUSDValueBigInt(nativeBalanceWrapped, priceUSD, 18 + Number(cflrPriceDecimals), 18, 3);
            collaterals.push({
                symbol: nativeSymbol,
                balance: balanceNative,
                valueUSD: nativeUSDFormatted,
                wrapped: nativeBalanceWrapped.toString(),
            });
            // FAssets
            const fassets = this.listAvailableFassets();
            for (const fasset of fassets.fassets) {
                const fAssetManager = this.getAssetManager(fasset);
                const fAsset = this.getFAsset(fasset);
                const settingsAsset = await fAssetManager.getSettings();
                const redemptionFee = settings.redemptionFeeBIPS;
                const assetSymbol = await fAsset.assetSymbol();
                const [priceAsset, , priceAssetDecimals] = await priceReader.getPrice(assetSymbol);
                const fBalance = await fAsset.balanceOf(address);
                const fBalanceAfterFee = fBalance - (fBalance * redemptionFee) / BigInt(MAX_BIPS);
                const assetUSDFormatted = calculateUSDValueBigInt(
                    fBalanceAfterFee,
                    priceAsset,
                    Number(priceAssetDecimals),
                    Number(settingsAsset.assetDecimals),
                    3
                );
                const lotSizeUBA = settingsAsset.lotSizeAMG * settingsAsset.assetMintingGranularityUBA;
                const lots = lotSizeUBA > 0n ? fBalance / lotSizeUBA : 0n;
                const fDecimals = Number(settingsAsset.assetDecimals);
                const fAssetSymbol = await fAsset.symbol();
                const fCollateral = {
                    symbol: fAssetSymbol,
                    balance: this.formatBigIntForceDecimals(fBalance, 2, fDecimals),
                    valueUSD: assetUSDFormatted,
                    lots: lots.toString(),
                };
                collaterals.push(fCollateral);
            }
            // Vault collaterals
            const vaultCollaterals = this.botService.getCollateralList();
            for (const c of vaultCollaterals) {
                const collateralEntity = await this.em.findOne(Collateral, { tokenFtsoSymbol: c });
                const token = ERC20__factory.connect(collateralEntity.token, provider);
                const balance = await token.balanceOf(address);
                const decimals = Number(await token.decimals());
                collaterals.push({ symbol: c == "USDT" ? "USDT0" : c, balance: this.formatBigIntForceDecimals(balance, 2, decimals) });
            }
            return collaterals;
        } catch (error) {
            logger.error("Error in getNativeBalances:", error);
            throw error;
        }
    }

    /**
     * Similar to getNativeBalances, but returns each item with its token contract address.
     * Instead of native balance, returns WNAT balance and the WNAT token address.
     * Each fasset entry includes the fasset token address.
     * Each collateral entry includes the collateral token address.
     */
    async getNativeBalancesWithAddresses(address: string): Promise<NativeBalanceItemTokenAddress[]> {
        try {
            const provider = this.ethersService.getProvider();
            const results: NativeBalanceItemTokenAddress[] = [];

            // WNAT balance (instead of native balance)
            const wNat = this.contractService.get<IWNat>("WNat");
            const wNatBalance = await wNat.balanceOf(address);
            const wNatAddress = await wNat.getAddress();
            const nativeSymbol = this.fassetConfigService.getNativeSymbol();
            results.push({
                symbol: `W${nativeSymbol}`,
                balance: this.formatBigIntForceDecimals(wNatBalance, 2, 18),
                exact: wNatBalance.toString(),
                address: wNatAddress,
                type: "wnat",
            });

            // FAssets balance with token address
            const fassets = this.listAvailableFassets();
            for (const fasset of fassets.fassets) {
                const fAsset = this.getFAsset(fasset);
                const fAssetManager = this.getAssetManager(fasset);
                const settingsAsset = await fAssetManager.getSettings();
                const fBalance = await fAsset.balanceOf(address);
                const fDecimals = Number(settingsAsset.assetDecimals);
                const fAssetSymbol = await fAsset.symbol();
                const fAssetAddress = await fAsset.getAddress();
                results.push({
                    symbol: fAssetSymbol,
                    balance: this.formatBigIntForceDecimals(fBalance, 2, fDecimals),
                    exact: fBalance.toString(),
                    address: fAssetAddress,
                    type: "fasset",
                });
            }

            // Vault collaterals with token address
            const vaultCollaterals = this.botService.getCollateralList();
            for (const c of vaultCollaterals) {
                const collateralEntity = await this.em.findOne(Collateral, { tokenFtsoSymbol: c });
                const token = ERC20__factory.connect(collateralEntity.token, provider);
                const balance = await token.balanceOf(address);
                const decimals = Number(await token.decimals());
                results.push({
                    symbol: c == "USDT" ? "USDT0" : c,
                    balance: this.formatBigIntForceDecimals(balance, 2, decimals),
                    exact: balance.toString(),
                    address: collateralEntity.token,
                    type: "collateral",
                });
            }

            return results;
        } catch (error) {
            logger.error("Error in getNativeBalancesWithAddresses:", error);
            throw error;
        }
    }

    /**
     * Bigint version of formatBNToStringForceDecimals.
     * Display displayDecimals, if all decimals are 0 it only shows 2.
     */
    private formatBigIntForceDecimals(value: bigint, displayDecimals: number, baseUnitDecimals: number): string {
        const baseUnitStr = value.toString();
        let integerPart = "0";
        let fractionalPart = "";

        if (baseUnitStr.length > baseUnitDecimals) {
            integerPart = baseUnitStr.slice(0, baseUnitStr.length - baseUnitDecimals);
            fractionalPart = baseUnitStr.slice(baseUnitStr.length - baseUnitDecimals);
        } else {
            fractionalPart = baseUnitStr.padStart(baseUnitDecimals, "0");
        }
        fractionalPart = fractionalPart.padEnd(baseUnitDecimals, "0");
        const fullFraction = fractionalPart.slice(0, displayDecimals);

        const isAllZero = /^0+$/.test(fullFraction);

        let displayFraction: string;

        if (isAllZero && displayDecimals > 2) {
            displayFraction = "00";
        } else {
            displayFraction = fullFraction.padEnd(displayDecimals, "0");
        }
        integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

        if (displayFraction.length > 0) {
            return `${integerPart}.${displayFraction}`;
        }

        return integerPart;
    }

    //TODO: add getting rejection/cancel event from DB first and if present return false before reading CREvent from DB
    async getCrStatus(crId: string): Promise<CRStatus | null> {
        const [crEvent] = await Promise.all([this.em.findOne(CollateralReservationEvent, { collateralReservationId: crId })]);
        if (crEvent == null) {
            return { status: false };
        }
        const paymentAmount = BigInt(crEvent.feeUBA) + BigInt(crEvent.valueUBA);
        return {
            status: true,
            accepted: true,
            collateralReservationId: crId,
            paymentAmount: paymentAmount.toString(),
            paymentAddress: crEvent.paymentAddress,
            paymentReference: crEvent.paymentReference,
        };
    }

    // Gets collateral reservation event or identity verification required event from txhash
    async getCREventFromTxHash(fasset: string, txhash: string, local: boolean): Promise<CREvent | CREventExtended> {
        try {
            const provider = this.ethersService.getProvider();
            let receipt = await provider.getTransactionReceipt(txhash);
            let i = 0;
            while (receipt == null) {
                await sleep(1000);
                receipt = await provider.getTransactionReceipt(txhash);
                i++;
                if (i == 20) {
                    logger.error(`Error in getCREventFromTxHash - time exceeded for ${fasset} and ${txhash} `);
                    throw new Error(`Transaction receipt not found for ${txhash}`);
                }
            }
            const assetManager = this.getAssetManager(fasset);
            for (const log of receipt.logs) {
                try {
                    if (log.topics[0] === sigCollateralReserved) {
                        const decoded = assetManager.interface.decodeEventLog("CollateralReserved", log.data, log.topics);
                        const paymentAmount = BigInt(decoded.feeUBA) + BigInt(decoded.valueUBA);
                        if (!local) {
                            return {
                                collateralReservationId: decoded.collateralReservationId.toString(),
                                paymentAmount: paymentAmount.toString(),
                                paymentAddress: decoded.paymentAddress,
                                paymentReference: decoded.paymentReference,
                                lastUnderlyingBlock: decoded.lastUnderlyingBlock.toString(),
                                expirationMinutes: calculateExpirationMinutes(decoded.lastUnderlyingTimestamp.toString()),
                            } as CREvent;
                        } else {
                            return {
                                collateralReservationId: decoded.collateralReservationId.toString(),
                                paymentAmount: decoded.valueUBA.toString(),
                                paymentAddress: decoded.paymentAddress,
                                paymentReference: decoded.paymentReference,
                                lastUnderlyingBlock: decoded.lastUnderlyingBlock.toString(),
                                expirationMinutes: calculateExpirationMinutes(decoded.lastUnderlyingTimestamp.toString()),
                                from: receipt.from,
                            } as CREventExtended;
                        }
                    }
                } catch (error) {
                    logger.error(`Error in getCREventFromTxHash (abi):`, error);
                }
            }
        } catch (error) {
            logger.error(`Error in getCREventFromTxHash:`, error);
        }
    }

    /**
     * Gets all redemption requested events from txhash.
     * First attempts a DB lookup (RedemptionRequestedEntity / RedemptionWithTagRequestedEvent),
     * then falls back to parsing blockchain transaction logs.
     */
    async getRedemptionRequestedEvents(fasset: string, txhash: string): Promise<FullRedeemData> {
        try {
            // --- DB-first: try to build result from persisted entities ---
            const dbResult = await this.getRedemptionRequestedFromDB(fasset, txhash);
            if (dbResult) {
                return dbResult;
            }

            // --- Fallback: parse blockchain transaction logs ---
            const provider = this.ethersService.getProvider();
            const assetManager = this.getAssetManager(fasset);
            let receipt = await provider.getTransactionReceipt(txhash);
            let i = 0;
            let incomplete = false;
            let dataIncomplete: RedemptionIncomplete = null;
            while (receipt == null) {
                await sleep(1000);
                receipt = await provider.getTransactionReceipt(txhash);
                i++;
                if (i == 20) {
                    logger.error(`Error in getRedemptionRequestedEvents ${fasset} and ${txhash}`);
                    throw new Error(`Transaction receipt not found for ${txhash}`);
                }
            }
            const redemptions = [];
            const block = await provider.getBlock("latest");
            const timestamp = block.timestamp;
            let amount = 0n;
            for (const log of receipt.logs) {
                try {
                    let eventName: string;
                    try {
                        const parsed = assetManager.interface.parseLog({ topics: [...log.topics], data: log.data });
                        eventName = parsed?.name;
                    } catch {
                        continue;
                    }
                    if (eventName === "RedemptionRequested") {
                        const decoded = assetManager.interface.decodeEventLog("RedemptionRequested", log.data, log.topics);
                        const amountUBA = BigInt(decoded.valueUBA) - BigInt(decoded.feeUBA);
                        amount = amount + BigInt(decoded.valueUBA);
                        const redemption: RedemptionData = {
                            type: "redeem",
                            requestId: decoded.requestId.toString(),
                            amountUBA: amountUBA.toString(),
                            paymentReference: decoded.paymentReference,
                            firstUnderlyingBlock: decoded.firstUnderlyingBlock.toString(),
                            lastUnderlyingBlock: decoded.lastUnderlyingBlock.toString(),
                            lastUnderlyingTimestamp: decoded.lastUnderlyingTimestamp.toString(),
                            executorAddress: decoded.executor,
                            createdAt: timestampToDateString(Number(timestamp)),
                            underlyingAddress: decoded.paymentAddress,
                            agentVault: decoded.agentVault,
                        };
                        redemptions.push(redemption);
                    } else if (eventName === "RedemptionWithTagRequested") {
                        // Tag-based redemption — parse same fields as RedemptionRequested
                        const decoded = assetManager.interface.decodeEventLog("RedemptionWithTagRequested", log.data, log.topics);
                        const amountUBA = BigInt(decoded.valueUBA) - BigInt(decoded.feeUBA);
                        amount = amount + BigInt(decoded.valueUBA);
                        const redemption: RedemptionData = {
                            type: "redeem",
                            requestId: decoded.requestId.toString(),
                            amountUBA: amountUBA.toString(),
                            paymentReference: decoded.paymentReference,
                            firstUnderlyingBlock: decoded.firstUnderlyingBlock.toString(),
                            lastUnderlyingBlock: decoded.lastUnderlyingBlock.toString(),
                            lastUnderlyingTimestamp: decoded.lastUnderlyingTimestamp.toString(),
                            executorAddress: this.ethersService.getExecutorAddress(),
                            createdAt: timestampToDateString(Number(timestamp)),
                            underlyingAddress: decoded.paymentAddress,
                            agentVault: decoded.agentVault,
                        };
                        redemptions.push(redemption);
                    } else if (eventName === "RedemptionRequestIncomplete") {
                        const decoded = assetManager.interface.decodeEventLog("RedemptionRequestIncomplete", log.data, log.topics);
                        incomplete = true;
                        dataIncomplete = { redeemer: decoded.redeemer, remainingLots: decoded.remainingLots.toString() };
                    } else if (eventName === "RedemptionAmountIncomplete") {
                        // Amount-based incomplete — stores remaining UBA instead of lots
                        const decoded = assetManager.interface.decodeEventLog("RedemptionAmountIncomplete", log.data, log.topics);
                        incomplete = true;
                        dataIncomplete = { redeemer: decoded.redeemer, remainingAmountUBA: decoded.remainingAmountUBA.toString() };
                    }
                } catch (error) {
                    // skip logs that can't be decoded
                }
            }
            const settings = await assetManager.getSettings();
            const value = formatBigIntToDisplayDecimals(amount, fasset.includes("XRP") ? 2 : 8, Number(settings.assetDecimals));
            return { redeemData: redemptions, fullAmount: value, from: receipt.from, incomplete: incomplete, dataIncomplete: dataIncomplete };
        } catch (error) {
            logger.error("Error in getRedemptionRequestedEvents:", error);
            throw error;
        }
    }

    /**
     * Tries to build FullRedeemData from DB entities (RedemptionRequestedEntity and
     * RedemptionWithTagRequestedEvent). Returns null if no entities are found,
     * allowing caller to fall back to blockchain log parsing.
     */
    private async getRedemptionRequestedFromDB(fasset: string, txhash: string): Promise<FullRedeemData | null> {
        const standardEntities = await this.em.find(RedemptionRequestedEntity, { txhash: txhash });
        const tagEntities = await this.em.find(RedemptionWithTagRequestedEvent, { txhash: txhash });

        if (standardEntities.length === 0 && tagEntities.length === 0) {
            return null;
        }

        const assetManager = this.getAssetManager(fasset);
        const redemptions: RedemptionData[] = [];
        let amount = 0n;
        let from = "";

        // Build RedemptionData from standard RedemptionRequested entities
        for (const entity of standardEntities) {
            const amountUBA = BigInt(entity.valueUBA) - BigInt(entity.feeUBA);
            amount = amount + BigInt(entity.valueUBA);
            if (!from) from = entity.redeemer;
            redemptions.push({
                type: "redeem",
                requestId: entity.requestId,
                amountUBA: amountUBA.toString(),
                paymentReference: entity.paymentReference,
                firstUnderlyingBlock: entity.firstUnderlyingBlock,
                lastUnderlyingBlock: entity.lastUnderlyingBlock,
                lastUnderlyingTimestamp: entity.lastUnderlyingTimestamp,
                executorAddress: this.ethersService.getExecutorAddress(),
                createdAt: timestampToDateString(Number(entity.timestamp) / 1000),
                underlyingAddress: entity.paymentAddress,
                agentVault: entity.agentVault,
            });
        }

        // Build RedemptionData from tag-based entities
        for (const entity of tagEntities) {
            const amountUBA = BigInt(entity.valueUBA) - BigInt(entity.feeUBA);
            amount = amount + BigInt(entity.valueUBA);
            if (!from) from = entity.redeemer;
            redemptions.push({
                type: "redeem",
                requestId: entity.requestId,
                amountUBA: amountUBA.toString(),
                paymentReference: entity.paymentReference,
                firstUnderlyingBlock: entity.firstUnderlyingBlock,
                lastUnderlyingBlock: entity.lastUnderlyingBlock,
                lastUnderlyingTimestamp: entity.lastUnderlyingTimestamp,
                executorAddress: this.ethersService.getExecutorAddress(),
                createdAt: timestampToDateString(Number(entity.timestamp) / 1000),
                underlyingAddress: entity.paymentAddress,
                agentVault: entity.agentVault,
            });
        }

        // Check for incomplete data from both lot-based and amount-based sources
        let incomplete = false;
        let dataIncomplete: RedemptionIncomplete = null;

        const incompleteEntities = await this.em.find(IncompleteRedemption, { txhash: txhash });
        if (incompleteEntities.length > 0) {
            incomplete = true;
            dataIncomplete = { redeemer: incompleteEntities[0].redeemer, remainingLots: incompleteEntities[0].remainingLots };
        }

        const amountIncompleteEntities = await this.em.find(RedemptionAmountIncompleteEvent, { txhash: txhash });
        if (amountIncompleteEntities.length > 0) {
            incomplete = true;
            dataIncomplete = {
                ...dataIncomplete,
                redeemer: amountIncompleteEntities[0].redeemer,
                remainingAmountUBA: amountIncompleteEntities[0].remainingAmountUBA,
            };
        }

        const settings = await assetManager.getSettings();
        const value = formatBigIntToDisplayDecimals(amount, fasset.includes("XRP") ? 2 : 8, Number(settings.assetDecimals));
        return { redeemData: redemptions, fullAmount: value, from: from, incomplete: incomplete, dataIncomplete: dataIncomplete };
    }

    async redemptionStatus(
        fasset: string,
        state: RedeemData,
        timestamp: number,
        settings: { attestationWindowSeconds: bigint }
    ): Promise<RedemptionStatusEnum> {
        const stateTs = dateStringToTimestamp(state.createdAt);
        if (timestamp - stateTs >= Number(settings.attestationWindowSeconds)) {
            return RedemptionStatusEnum.EXPIRED;
        } else if (await this.findRedemptionPayment(fasset, state)) {
            return RedemptionStatusEnum.SUCCESS;
        } else if (await this.redemptionTimeElapsed(fasset, state)) {
            return RedemptionStatusEnum.DEFAULT;
        } else {
            return RedemptionStatusEnum.PENDING;
        }
    }

    async findRedemptionPayment(fasset: string, state: RedeemData) {
        try {
            const txs = await this.fassetConfigService.getVerifier(fasset).getTransactionsByReference(state.paymentReference);
            for (const tx of txs) {
                let amount = 0n;
                for (const output of tx.outputs) {
                    if (output[0] === state.underlyingAddress) {
                        amount += output[1];
                    }
                }
                if (amount >= BigInt(state.amountUBA)) {
                    return tx;
                }
            }
            return null;
        } catch (error) {
            logger.error("Error in findRedemptionPayment:", error);
            return null;
        }
    }

    async redemptionTimeElapsed(fasset: string, state: RedeemData): Promise<boolean> {
        try {
            const verifier = this.fassetConfigService.getVerifier(fasset);
            const blockHeight = await verifier.getLastFinalizedBlockNumber();
            const lastBlock = await verifier.getBlock(blockHeight);
            return blockHeight > Number(state.lastUnderlyingBlock) && lastBlock.timestamp > Number(state.lastUnderlyingTimestamp);
        } catch (error) {
            logger.error("Error in redemptionTimeElapsed:", error);
            return false;
        }
    }

    /**
     * Gets the current redemption status for a txhash by checking Redemption entities
     * and falling back to RedemptionWithTagRequestedEvent for tag-based redemptions.
     * Also enriches incomplete data from DB if not already set by getRedemptionRequestedEvents.
     */
    async getRedemptionStatus(fasset: string, txhash: string): Promise<RedemptionStatus> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const fullRedeemData = await this.getRedemptionRequestedEvents(fasset, txhash);
            const provider = this.ethersService.getProvider();
            const block = await provider.getBlock("latest");
            const latestTimestamp = block.timestamp;
            const settings = await assetManager.getSettings();

            // Build RedeemData[] from either standard Redemption entities or tag-based entities
            const redeemDataList = await this.buildRedeemDataForStatus(txhash, fasset);

            // Defensively check for incomplete data from DB if not already set
            if (!fullRedeemData.incomplete) {
                const incompleteFromDB = await this.checkIncompleteFromDB(txhash);
                if (incompleteFromDB) {
                    fullRedeemData.incomplete = true;
                    fullRedeemData.dataIncomplete = incompleteFromDB;
                }
            }

            let success = false;
            for (const redemption of redeemDataList) {
                if (redemption.amountUBA === "0") {
                    continue;
                }
                const status = await this.redemptionStatus(fasset, redemption, Number(latestTimestamp), settings);
                switch (status) {
                    case RedemptionStatusEnum.PENDING:
                        return { status: status, incomplete: fullRedeemData.incomplete, incompleteData: fullRedeemData.dataIncomplete };
                    case RedemptionStatusEnum.SUCCESS:
                        success = true;
                        break;
                    case RedemptionStatusEnum.DEFAULT:
                        return { status: RedemptionStatusEnum.DEFAULT, incomplete: fullRedeemData.incomplete, incompleteData: fullRedeemData.dataIncomplete };
                    case RedemptionStatusEnum.EXPIRED:
                        return { status: RedemptionStatusEnum.EXPIRED, incomplete: fullRedeemData.incomplete, incompleteData: fullRedeemData.dataIncomplete };
                    default:
                        break;
                }
            }
            return {
                status: success ? RedemptionStatusEnum.SUCCESS : RedemptionStatusEnum.PENDING,
                incomplete: fullRedeemData.incomplete,
                incompleteData: fullRedeemData.dataIncomplete,
            };
        } catch (error) {
            logger.error("Error in getRedemptionStatus:", error);
            throw error;
        }
    }

    /**
     * Builds RedeemData[] from standard Redemption entities. If none exist,
     * falls back to RedemptionWithTagRequestedEvent entities for tag-based redemptions.
     */
    private async buildRedeemDataForStatus(txhash: string, fasset: string): Promise<RedeemData[]> {
        const takenOverRed = await this.em.find(Redemption, { txhash: txhash });
        if (takenOverRed.length > 0) {
            return takenOverRed.map((r) => ({
                type: "redeem" as const,
                requestId: r.requestId,
                amountUBA: r.amountUBA.toString(),
                paymentReference: r.paymentReference,
                firstUnderlyingBlock: r.firstUnderlyingBlock,
                lastUnderlyingBlock: r.lastUnderlyingBlock,
                lastUnderlyingTimestamp: r.lastUnderlyingTimestamp,
                executorAddress: this.ethersService.getExecutorAddress(),
                createdAt: timestampToDateString(r.timestamp / 1000),
                underlyingAddress: r.underlyingAddress,
            }));
        }

        // Fallback: build from tag-based entities
        const tagEntities = await this.em.find(RedemptionWithTagRequestedEvent, { txhash: txhash });
        return tagEntities.map((entity) => ({
            type: "redeem" as const,
            requestId: entity.requestId,
            amountUBA: (BigInt(entity.valueUBA) - BigInt(entity.feeUBA)).toString(),
            paymentReference: entity.paymentReference,
            firstUnderlyingBlock: entity.firstUnderlyingBlock,
            lastUnderlyingBlock: entity.lastUnderlyingBlock,
            lastUnderlyingTimestamp: entity.lastUnderlyingTimestamp,
            executorAddress: this.ethersService.getExecutorAddress(),
            createdAt: timestampToDateString(Number(entity.timestamp) / 1000),
            underlyingAddress: entity.paymentAddress,
        }));
    }

    /**
     * Checks DB for incomplete redemption data (both lot-based IncompleteRedemption
     * and amount-based RedemptionAmountIncompleteEvent).
     */
    private async checkIncompleteFromDB(txhash: string): Promise<RedemptionIncomplete | null> {
        let result: RedemptionIncomplete = null;

        const incompleteEntities = await this.em.find(IncompleteRedemption, { txhash: txhash });
        if (incompleteEntities.length > 0) {
            result = { redeemer: incompleteEntities[0].redeemer, remainingLots: incompleteEntities[0].remainingLots };
        }

        const amountIncompleteEntities = await this.em.find(RedemptionAmountIncompleteEvent, { txhash: txhash });
        if (amountIncompleteEntities.length > 0) {
            result = {
                ...result,
                redeemer: amountIncompleteEntities[0].redeemer,
                remainingAmountUBA: amountIncompleteEntities[0].remainingAmountUBA,
            };
        }

        return result;
    }

    async getTokenBalanceFromIndexer(userAddress: string): Promise<IndexerTokenBalances[]> {
        const data = await this.externalApiService.getUserCollateralPoolTokens(userAddress);
        return data;
    }

    async getTokenBalanceFromExplorer(userAddress: string): Promise<CostonExpTokenBalance[]> {
        const data = await lastValueFrom(this.httpService.get(this.costonExplorerUrl + "?module=account&action=tokenlist&address=" + userAddress));
        return data.data.result;
    }

    async getMaxWithdraw(fasset: string, poolAddress: string, userAddress: string, value: number): Promise<MaxWithdraw> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const settings = await assetManager.getSettings();
            const agent = await this.em.findOne(Pool, { poolAddress: poolAddress });
            const valueWei = BigInt(Math.floor(value * 10 ** 18));
            const pool = this.contractService.getCollateralPoolContract(poolAddress);
            const poolToken = this.contractService.getCollateralPoolTokenContract(agent.tokenAddress);
            const poolNatBalance = await pool.totalCollateral();
            const fees = await pool.fAssetFeesOf(userAddress);
            const totalSupply = await poolToken.totalSupply();

            const userPoolNatReturn = totalSupply > 0n ? (valueWei * poolNatBalance) / totalSupply : 0n;
            const assetData = await assetManager.assetPriceNatWei();
            const assetPriceMul = assetData[0];
            const assetPriceDiv = assetData[1];
            const exitCRBIPS = await pool.exitCollateralRatioBIPS();
            const agentBackedFassets = await assetManager.getFAssetsBackedByPool(agent.vaultAddress);
            const a = (poolNatBalance - userPoolNatReturn) * assetPriceDiv;
            const b = agentBackedFassets * assetPriceMul * (exitCRBIPS / BigInt(MAX_BIPS));
            if (a >= b) {
                return {
                    natReturn: formatFixedBigInt(userPoolNatReturn, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    }),
                    fees: formatBigIntToDisplayDecimals(fees, fasset.includes("XRP") ? 3 : 8, Number(settings.assetDecimals)),
                };
            } else {
                throw new LotsException("Pool collateral ratio falls below exitCR. Please enter a lower value.");
            }
        } catch (error) {
            logger.error(`Error in getMaxWithdraw:`, error);
            throw error;
        }
    }

    async getMaxCPTWithdraw(fasset: string, poolAddress: string): Promise<MaxCPTWithdraw> {
        try {
            const assetManager = this.getAssetManager(fasset);
            const agent = await this.em.findOne(Pool, { poolAddress: poolAddress });
            const pool = this.contractService.getCollateralPoolContract(poolAddress);
            const poolToken = this.contractService.getCollateralPoolTokenContract(agent.tokenAddress);
            const poolNatBalance = await pool.totalCollateral();
            const totalSupply = await poolToken.totalSupply();
            const assetData = await assetManager.assetPriceNatWei();
            const assetPriceMul = assetData[0];
            const assetPriceDiv = assetData[1];
            const exitCRBIPS = await pool.exitCollateralRatioBIPS();
            const agentBackedFassets = await assetManager.getFAssetsBackedByPool(agent.vaultAddress);
            const maxNatWith = poolNatBalance - (agentBackedFassets * assetPriceMul * (exitCRBIPS / BigInt(MAX_BIPS))) / assetPriceDiv;
            const maxCptWith = totalSupply > 0n ? (maxNatWith * totalSupply) / poolNatBalance : 0n;
            return { maxWithdraw: formatBigIntToDisplayDecimals(maxCptWith, 3, 18) };
        } catch (error) {
            logger.error(`Error in getMaxCPTWithdraw:`, error);
            throw error;
        }
    }

    async getPoolBalances(address: string): Promise<CommonBalance> {
        try {
            const agents = await this.em.find(Pool, {});
            let userNatPosition = 0n;
            const cptokenBalances = await this.getTokenBalanceFromIndexer(address);
            for (const agent of agents) {
                try {
                    const info = cptokenBalances[agent.tokenAddress];
                    if (!info) {
                        continue;
                    }

                    const pool = this.contractService.getCollateralPoolContract(agent.poolAddress);
                    const poolToken = this.contractService.getCollateralPoolTokenContract(agent.tokenAddress);

                    const balance = await poolToken.balanceOf(address);
                    if (balance === 0n) {
                        continue;
                    }
                    const poolNatBalance = await pool.totalCollateral();
                    const totalSupply = await poolToken.totalSupply();
                    const userPoolNatBalance = totalSupply > 0n ? (balance * poolNatBalance) / totalSupply : 0n;
                    userNatPosition = userNatPosition + userPoolNatBalance;
                } catch (error) {
                    logger.error(`Error in getPoolBalances:`, error);
                    continue;
                }
            }
            return {
                balance: formatFixedBigInt(userNatPosition, 18, {
                    decimals: 2,
                    groupDigits: true,
                    groupSeparator: ",",
                }),
            };
        } catch (error) {
            logger.error("Error in getPoolBalances:", error);
            throw error;
        }
    }

    listAvailableFassets(): AvailableFassets {
        return { fassets: this.botService.fassetList };
    }

    async submitTx(fasset: string, tx: string): Promise<submitTxResponse> {
        try {
            const response = await this.externalApiService.submitTX(fasset, tx);
            return { hash: response };
        } catch (error) {
            throw new LotsException(error.error);
        }
    }

    async getEcosystemInfo(): Promise<EcosystemData> {
        return this.botService.getEcosystemInfo();
    }

    async getLifetimeClaimed(address: string): Promise<any> {
        try {
            const claimed = await this.externalApiService.getUserTotalClaimedPoolFees(address);
            const claimedUSD: ClaimedPools[] = [];
            const fassets = this.botService.fassetList;
            const userCpts = await this.getTokenBalanceFromIndexer(address);
            const claimedP: ClaimedPools[] = [];
            for (const key of Object.keys(userCpts)) {
                const agent = await this.em.findOne(Pool, {
                    tokenAddress: key,
                });
                if (!agent) {
                    continue;
                }
                const cl = claimedP.find((c) => c.fasset === agent.fasset);
                const pool = this.contractService.getCollateralPoolContract(agent.poolAddress);
                const fees = await pool.fAssetFeesOf(address);
                if (!cl) {
                    claimedP.push({ fasset: agent.fasset, claimed: fees.toString() });
                } else {
                    cl.claimed = (BigInt(cl.claimed) + fees).toString();
                }
            }
            const priceReader = this.getPriceReader();
            for (const fasset of fassets) {
                const netw = NETWORK_SYMBOLS.find((item) => (this.envType == "dev" ? item.test : item.real) === fasset);
                const claim = claimed[netw.real];
                if (!claim) {
                    claimedUSD.push({ fasset: fasset, claimed: "0" });
                    continue;
                }
                const cl = claimedP.find((c) => c.fasset === fasset);
                if (cl) {
                    claim.value = (BigInt(claim.value) + BigInt(cl.claimed)).toString();
                }
                const assetManager = this.getAssetManager(fasset);
                const settings = await assetManager.getSettings();
                const fAsset = this.getFAsset(fasset);
                const assetSymbol = await fAsset.assetSymbol();
                const [price, , priceDecimals] = await priceReader.getPrice(assetSymbol);
                const priceMul = price * bigintPow10(18);
                claimedUSD.push({
                    fasset: fasset,
                    claimed: calculateUSDValueBigInt(BigInt(claim.value), priceMul, 18 + Number(settings.assetDecimals), Number(priceDecimals), 3),
                });
            }
            return claimedUSD;
        } catch (error) {
            logger.error("Error in getLifetimeClaimed:", error);
            throw error;
        }
    }

    async getTimeData(time: string): Promise<TimeData> {
        return this.botService.getTimeSeries(time);
    }

    async getRedemptionFeeData(): Promise<RedemptionFeeData[]> {
        try {
            const redemptionFeeData: RedemptionFeeData[] = [];
            const priceReader = this.getPriceReader();
            for (const f of this.botService.fassetList) {
                const assetManager = this.getAssetManager(f);
                const settings = await assetManager.getSettings();
                const redemptionFee = Number(settings.redemptionFeeBIPS.toString()) / 100;
                const lotSize = await this.getLotSize(f);
                const fassetFee = (redemptionFee / 100) * lotSize.lotSize;
                const fAsset = this.getFAsset(f);
                const assetSymbol = await fAsset.assetSymbol();
                const [price, , priceDecimals] = await priceReader.getPrice(assetSymbol);
                const priceMul = Number(price) / 10 ** Number(priceDecimals);
                const valueUSD = fassetFee * priceMul;
                redemptionFeeData.push({ fasset: f, feePercentage: redemptionFee.toString(), feeUSD: valueUSD.toFixed(3) });
            }
            return redemptionFeeData;
        } catch (error) {
            logger.error("Error in getRedemptionFeeData:", error);
            throw error;
        }
    }

    async getAssetPrice(fasset: string): Promise<AssetPrice> {
        try {
            const cachedPrice = await this.cacheManager.get(fasset + "price");
            if (!cachedPrice) {
                const priceReader = this.getPriceReader();
                const fAsset = this.getFAsset(fasset);
                const assetSymbol = await fAsset.assetSymbol();
                const [price, , priceDecimals] = await priceReader.getPrice(assetSymbol);
                const priceMul = Number(price) / 10 ** Number(priceDecimals);
                await this.cacheManager.set(fasset + "-price", priceMul, 5000);
                return { price: priceMul };
            }
            return { price: Number(cachedPrice) };
        } catch (error) {
            logger.error("Error in getAssetPrice:", error);
            throw error;
        }
    }

    async getMintingEnabled(): Promise<FassetStatus[]> {
        try {
            const fassetStatus: FassetStatus[] = [];
            for (const f of this.botService.fassetList) {
                const assetManager = this.getAssetManager(f);
                const pause = await assetManager.emergencyPaused();
                fassetStatus.push({ fasset: f, status: !pause });
            }
            return fassetStatus;
        } catch (error) {
            logger.error("Error in getMintingEnabled:", error);
            throw error;
        }
    }

    /**
     * Returns the current redemption queue capacity as both lots and UBA amounts.
     * Amount cache keys store raw UBA values; XRP decimals = 6.
     */
    async getRedemptionQueue(fasset: string): Promise<RedemptionQueue> {
        const maxLotsSingleRedeem = await this.cacheManager.get(fasset + "maxLotsSingleRedeem");
        const maxLotsTotalRedeem = await this.cacheManager.get(fasset + "maxLotsTotalRedeem");
        // Read raw UBA amount cache (set by updateRedemptionQueue)
        const maxAmountSingleRedeem: string | undefined = await this.cacheManager.get(fasset + "maxAmountSingleRedeem");
        const maxAmountTotalRedeem: string | undefined = await this.cacheManager.get(fasset + "maxAmountTotalRedeem");
        const decimals = fasset.includes("XRP") ? 6 : 8;
        const divisor = BigInt(10 ** decimals);
        const singleDrops = maxAmountSingleRedeem || "0";
        const totalDrops = maxAmountTotalRedeem || "0";
        // Convert UBA (drops) to human-readable XRP by dividing by 10^decimals
        const singleXRP = (Number(singleDrops) / Number(divisor)).toFixed(decimals);
        const totalXRP = (Number(totalDrops) / Number(divisor)).toFixed(decimals);
        return {
            maxLots: Number(maxLotsTotalRedeem ?? 0),
            maxLotsOneRedemption: Number(maxLotsSingleRedeem ?? 0),
            maxAmountOneRedemptionDrops: singleDrops,
            maxAmountOneRedemptionXRP: singleXRP,
            maxAmountDrops: totalDrops,
            maxAmountXRP: totalXRP,
        };
    }

    /**
     * Returns all minting tags owned by an EVM address from the MintingTagManager contract.
     * For each tag, fetches the minting recipient, allowed executor, and any pending executor change info.
     * When an executor change is pending (10-minute cooldown after setAllowedExecutor), the response
     * includes the new executor address and the timestamp when it becomes active.
     */
    async getTagsForAddress(fasset: string, evmAddress: string): Promise<TagInfo[]> {
        try {
            const tagManager = this.contractService.getMintingTagManagerContract(fasset);
            const tagIds: bigint[] = await tagManager.reservedTagsForOwner(evmAddress);
            const tags: TagInfo[] = [];
            for (const tag of tagIds) {
                const mintingRecipient = await tagManager.mintingRecipient(tag);
                const allowedExecutor = await tagManager.allowedExecutor(tag);
                // Check if there is a pending executor change (10-minute cooldown after setAllowedExecutor)
                const pendingResult = await tagManager.pendingAllowedExecutorChange(tag);
                tags.push({
                    tagId: tag.toString(),
                    mintingRecipient,
                    allowedExecutor,
                    executorChangePending: pendingResult._pending,
                    ...(pendingResult._pending && {
                        pendingNewExecutor: pendingResult._newExecutor,
                        executorChangeActiveAfterTs: Number(pendingResult._activeAfterTs),
                    }),
                });
            }
            return tags;
        } catch (error) {
            logger.error("Error in getTagsForAddress:", error);
            throw error;
        }
    }

    /**
     * Returns info for a single minting tag from the MintingTagManager contract.
     * Fetches the minting recipient, allowed executor, and any pending executor change.
     * When an executor change is pending (10-minute cooldown after setAllowedExecutor),
     * the response includes both the current and new executor, plus the activation timestamp.
     */
    async getTagForAddress(fasset: string, tagId: string): Promise<TagInfo> {
        try {
            const tagManager = this.contractService.getMintingTagManagerContract(fasset);
            const mintingRecipient = await tagManager.mintingRecipient(tagId);
            const allowedExecutor = await tagManager.allowedExecutor(tagId);
            // Check if there is a pending executor change (10-minute cooldown after setAllowedExecutor)
            const pendingResult = await tagManager.pendingAllowedExecutorChange(tagId);
            return {
                tagId,
                mintingRecipient,
                allowedExecutor,
                executorChangePending: pendingResult._pending,
                ...(pendingResult._pending && {
                    pendingNewExecutor: pendingResult._newExecutor,
                    executorChangeActiveAfterTs: Number(pendingResult._activeAfterTs),
                }),
            };
        } catch (error) {
            logger.error("Error in getTagForAddress:", error);
            throw error;
        }
    }

    /**
     * Looks up the EVM recipient address for a given minting tag via the MintingTagManager contract.
     */
    async getMintingRecipient(fasset: string, tagId: string): Promise<MintingRecipientResponse> {
        try {
            const tagManager = this.contractService.getMintingTagManagerContract(fasset);
            const recipient = await tagManager.mintingRecipient(tagId);
            return { recipient };
        } catch (error) {
            logger.error("Error in getMintingRecipient:", error);
            throw error;
        }
    }

    /**
     * Returns the tag reservation fee from the MintingTagManager contract.
     * This is the fee required to reserve a minting tag, returned as a string in native wei.
     */
    async getTagReservationFee(fasset: string): Promise<TagReservationFeeResponse> {
        try {
            const tagManager = this.contractService.getMintingTagManagerContract(fasset);
            const reservationFee = await tagManager.reservationFee();
            return { reservationFee: reservationFee.toString() };
        } catch (error) {
            logger.error("Error in getTagReservationFee:", error);
            throw error;
        }
    }

    /**
     * Returns executor info for direct minting. On songbird the MasterAccountController
     * contract is not called — hard-coded constants are returned instead.
     */
    private async resolveExecutorInfo(fasset: string): Promise<{ executorAddress: string; executorFee: string }> {
        const network = this.configService.get<string>("NETWORK", "coston2");
        if (network === "songbird") {
            return {
                executorAddress: SONGBIRD_EXECUTOR_ADDRESS,
                executorFee: SONGBIRD_EXECUTOR_FEE,
            };
        }
        const controller = this.contractService.getMasterAccountControllerContract(fasset);
        const [executorAddress, executorFee] = await controller.getExecutorInfo();
        return { executorAddress, executorFee: executorFee.toString() };
    }

    /**
     * Returns executor address and fee from the MasterAccountController for direct minting.
     */
    async getDirectMintingExecutor(fasset: string): Promise<DirectMintingExecutorResponse> {
        try {
            return await this.resolveExecutorInfo(fasset);
        } catch (error) {
            logger.error("Error in getDirectMintingExecutor:", error);
            throw error;
        }
    }

    /**
     * Returns everything a frontend needs to build a direct minting transaction:
     * the Core Vault payment address, fee parameters, and executor info.
     * Uses dedicated AssetManager view methods for direct minting fees.
     */
    async getDirectMintingInfo(fasset: string): Promise<DirectMintingInfoResponse> {
        try {
            const assetManager = this.getAssetManager(fasset);
            // Core Vault XRP address to send payment to
            const paymentAddress = await assetManager.directMintingPaymentAddress();
            // Direct minting fee in BIPS and minimum fee in UBA (drops)
            const mintingFeeBIPS = await assetManager.getDirectMintingFeeBIPS();
            const minimumMintingFeeUBA = await assetManager.getDirectMintingMinimumFeeUBA();
            // Executor fee denominated in FAsset UBA (drops)
            const fassetsExecutorFeeUBA = await assetManager.getDirectMintingExecutorFeeUBA();
            // Executor info from MasterAccountController (or songbird constants)
            const { executorAddress, executorFee } = await this.resolveExecutorInfo(fasset);
            return {
                paymentAddress,
                mintingFeeBIPS: mintingFeeBIPS.toString(),
                minimumMintingFeeUBA: minimumMintingFeeUBA.toString(),
                executorAddress,
                executorFee,
                fassetsExecutorFee: fassetsExecutorFeeUBA.toString(),
            };
        } catch (error) {
            logger.error("Error in getDirectMintingInfo:", error);
            throw error;
        }
    }

    async mintingUnderlyingTransactionExists(fasset: string, paymentReference: string): Promise<boolean> {
        try {
            const verifier = this.fassetConfigService.getVerifier(fasset);
            const txs = await verifier.getTransactionsByReference(paymentReference);
            const crData = await this.em.findOne(CollateralReservationEvent, {
                paymentReference: paymentReference,
            });
            if (!crData) {
                return true;
            }
            for (const tx of txs) {
                let amount = 0n;
                for (const output of tx.outputs) {
                    if (output[0] === crData.paymentAddress) {
                        amount += output[1];
                    }
                }
                if (amount >= BigInt(crData.valueUBA) + BigInt(crData.feeUBA)) {
                    return true;
                }
            }
            const underlyingBlockNumber = await verifier.getLastFinalizedBlockNumber();
            const lastUnderlyingBlock = await verifier.getBlock(underlyingBlockNumber);
            if (lastUnderlyingBlock) {
                const timestamp = lastUnderlyingBlock.timestamp;
                const block = lastUnderlyingBlock.number;
                const lastUnderlyingTimestamp = Number(crData.lastUnderlyingTimestamp);
                const lastUnderlyingBlockNumber = Number(crData.lastUnderlyingBlock);
                if (timestamp >= lastUnderlyingTimestamp && block >= lastUnderlyingBlockNumber) {
                    return true;
                }
                const remaining = lastUnderlyingTimestamp >= timestamp ? lastUnderlyingTimestamp - timestamp : 0;
                const blocksRemaining = lastUnderlyingBlockNumber >= block ? lastUnderlyingBlockNumber - block : 0;
                if (remaining < 120 && blocksRemaining <= 30) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            logger.error("Error in mintingUnderlyingTransactionExists:", error);
            return false;
        }
    }
}
