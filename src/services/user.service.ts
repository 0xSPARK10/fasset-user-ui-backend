/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inject, Injectable } from "@nestjs/common";
import {
    AddressResponse,
    AgentPoolItem,
    AgentPoolLatest,
    AssetPrice,
    AvailableFassets,
    BestAgent,
    CommonBalance,
    CostonExpTokenBalance,
    CREvent,
    CREventExtended,
    CRFee,
    CRStatus,
    ExecutorResponse,
    FeeEstimate,
    HandshakeEvent,
    IndexerTokenBalances,
    LotSize,
    MaxCPTWithdraw,
    MaxLots,
    MaxWithdraw,
    MintingStatus,
    NativeBalanceItem,
    Progress,
    ProtocolFees,
    RedemptionDefaultStatus,
    RedemptionDefaultStatusGrouped,
    RedemptionFee,
    RedemptionFeeData,
    RedemptionStatus,
    RequestMint,
    RequestRedemption,
    submitTxResponse,
    TrailingFee,
    UTXOSLedger,
    VaultCollateralRedemption,
} from "../interfaces/requestResponse";
import { AssetManagerSettings, ChainId, CollateralClass, UserBotCommands } from "@flarelabs/fasset-bots-core";
import {
    BN_ZERO,
    DEFAULT_RETRIES,
    MAX_BIPS,
    artifacts,
    formatFixed,
    latestBlockTimestamp,
    prefix0x,
    requireNotNull,
    retry,
    sumBN,
    toBN,
    toBNExp,
    web3,
    web3DeepNormalize,
} from "@flarelabs/fasset-bots-core/utils";
import { requiredEventArgs } from "node_modules/@flarelabs/fasset-bots-core/dist/src/utils/events/truffle";
import { BotService } from "./bot.init.service";
import { EntityManager } from "@mikro-orm/core";
import { Minting } from "../entities/Minting";
import { Redemption } from "../entities/Redemption";
import { LotsException } from "../exceptions/lots.exception";
import { error } from "console";
import { Pool } from "../entities/Pool";
import { Liveness } from "../entities/AgentLiveness";
import { CollateralPrice } from "node_modules/@flarelabs/fasset-bots-core/dist/src/state/CollateralPrice";
import { TokenPriceReader } from "node_modules/@flarelabs/fasset-bots-core/dist/src/state/TokenPrice";
import { dateStringToTimestamp, formatBNToDisplayDecimals, sleep, timestampToDateString } from "src/utils/utils";
import { EXECUTION_FEE, NETWORK_SYMBOLS, RedemptionStatusEnum } from "src/utils/constants";
import {
    ClaimedPools,
    EcosystemData,
    FullRedeemData,
    RedeemData,
    RedemptionData,
    RedemptionIncomplete,
    SelectedUTXO,
    SelectedUTXOAddress,
    TimeData,
    TransactionBTC,
    UTXOBTC,
} from "src/interfaces/structure";
import BN from "bn.js";
import { logger } from "src/logger/winston.logger";
import { FullRedemption } from "src/entities/RedemptionWhole";
import { Collateral } from "src/entities/Collaterals";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import {
    ITransaction,
    TX_BLOCKED,
    TX_FAILED,
    TX_SUCCESS,
    TxInputOutput,
} from "node_modules/@flarelabs/fasset-bots-core/dist/src/underlying-chain/interfaces/IBlockChain";
import { BTC_MDU, BlockChainIndexerHelperError } from "node_modules/@flarelabs/fasset-bots-core/dist/src/underlying-chain/BlockchainIndexerHelper";
import { ExternalApiService } from "./external.api.service";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { CrRejectedCancelledEvent } from "src/entities/CollateralReservationRejected";
import { RedemptionRejected } from "src/entities/RedemptionRejected";
import { ConfigService } from "@nestjs/config";
import { lastValueFrom } from "rxjs";
import { HttpService } from "@nestjs/axios";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";

const IERC20 = artifacts.require("IERC20Metadata");
const CollateralPool = artifacts.require("CollateralPool");
const CollateraPoolToken = artifacts.require("CollateralPoolToken");

const REMAIN_SATOSHIS = toBN(0);
const NUM_RETRIES = 3;
const MAX_SEQUENCE = 4294967295;

const sigCollateralReserved = web3.utils.keccak256(
    "CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)"
);
const sigHandshake = web3.utils.keccak256("HandshakeRequired(address,address,uint256,string[],uint256,uint256)");

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
        private readonly externalApiService: ExternalApiService
    ) {
        this.envType = this.configService.get<string>("APP_TYPE");
        this.costonExplorerUrl = this.configService.get<string>("COSTON_EXPLORER_URL");
    }

    //TODO: add verification return and filter by agent with no verification first
    async getBestAgent(fasset: string, lots: number): Promise<BestAgent> {
        const bot = this.botService.getInfoBot(fasset);
        const bestAgent = await bot.findBestAgent(toBN(lots));
        if (bestAgent == null) {
            throw new LotsException("Agents need to increase collateral in the system to enable minting.");
        }
        const maxLots = await this.getMaxLots(fasset);
        if (toBN(maxLots.maxLots).eq(BN_ZERO)) {
            throw new LotsException("All FAssets are currently minted.");
        }
        if (toBN(lots).gt(toBN(maxLots.maxLots))) {
            throw new LotsException("Cannot mint more than " + maxLots.maxLots + " lots at once.");
        }
        const collateralReservationFee = await bot.context.assetManager.collateralReservationFee(lots);
        const agentInfo = await bot.context.assetManager.getAgentInfo(bestAgent);
        const feeBIPS = agentInfo.feeBIPS;
        const agentName = await bot.context.agentOwnerRegistry.getAgentName(agentInfo.ownerManagementAddress);
        const pool = await this.em.findOne(Pool, {
            vaultAddress: bestAgent,
        });
        return {
            agentAddress: bestAgent,
            feeBIPS: feeBIPS.toString(),
            collateralReservationFee: collateralReservationFee.toString(),
            maxLots: maxLots.maxLots,
            agentName: agentName,
            handshakeType: Number(agentInfo.handshakeType),
            underlyingAddress: agentInfo.underlyingAddressString,
            infoUrl: pool.infoUrl,
        };
    }

    async getCRTFee(fasset: string, lots: number): Promise<CRFee> {
        const bot = this.botService.getInfoBot(fasset);
        const collateralReservationFee = await bot.context.assetManager.collateralReservationFee(lots);
        return { collateralReservationFee: collateralReservationFee.toString() };
    }

    async getMaxLots(fasset: string): Promise<MaxLots> {
        const bot = this.botService.getInfoBot(fasset);
        const agents = await bot.getAvailableAgents();
        const settings = await bot.context.assetManager.getSettings();
        const tokenSupply = await bot.context.fAsset.totalSupply();
        let reserved = toBN(0);
        const lotSizeUBA = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
        const mintingCap = toBN(settings.mintingCapAMG).mul(toBN(settings.assetMintingGranularityUBA));
        if (mintingCap.toString() != "0") {
            for (const a of agents) {
                const info = await bot.context.assetManager.getAgentInfo(a.agentVault);
                reserved = reserved.add(toBN(info.reservedUBA));
            }
        }
        if (tokenSupply.gte(mintingCap) && mintingCap.toString() != "0") {
            throw new LotsException("The minting cap for " + fasset + " has been reached. No new minting is available.");
        }
        const availableToMintUBA = mintingCap.toString() === "0" ? toBN(0) : mintingCap.sub(tokenSupply.add(reserved));
        const availableToMintLots = mintingCap.toString() === "0" ? toBN(0) : availableToMintUBA.div(lotSizeUBA);
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
            return toBN(current.freeCollateralLots).toNumber() > max ? toBN(current.freeCollateralLots).toNumber() : max;
        }, Number.NEGATIVE_INFINITY);
        const lots = mintingCap.toString() === "0" ? Number(maxLots) : Math.min(Number(maxLots), availableToMintLots.toNumber());
        let lotsLimited = false;
        if (Number(maxLots) > availableToMintLots.toNumber() && mintingCap.toString() != "0") {
            lotsLimited = true;
        }
        return { maxLots: lots.toString(), lotsLimited: lotsLimited };
    }

    async getLotSize(fasset: string): Promise<LotSize> {
        const bot = this.botService.getInfoBot(fasset);
        const lotSize = await bot.getLotSize();
        const settings = await bot.context.assetManager.getSettings();
        const formatted = lotSize / 10 ** Number(settings.assetDecimals);
        return { lotSize: formatted };
    }

    async checkStateFassets(): Promise<any> {
        const stateF = [];
        for (const f of this.botService.fassetList) {
            const bot = this.botService.getInfoBot(f);
            const state = await bot.context.assetManager.emergencyPaused();
            const stateTransfer = await bot.context.assetManager.transfersEmergencyPaused();
            stateF.push({ fasset: f, state: state || stateTransfer });
        }
        return stateF;
    }

    //TODO: add trailing fee return
    //Trailing fee: transferAmount * transferFeeMillionths / 10^6 = transferFee, no fee on mint/redeem
    async getRedemptionFee(fasset: string): Promise<RedemptionFee> {
        const bot = this.botService.getInfoBot(fasset);
        const settings = await bot.context.assetManager.getSettings();
        return { redemptionFee: settings.redemptionFeeBIPS.toString() };
    }

    async getProtocolFees(fasset: string): Promise<ProtocolFees> {
        const bot = this.botService.getInfoBot(fasset);
        const settings = await bot.context.assetManager.getSettings();
        const trailingFee = toBN(await bot.context.assetManager.transferFeeMillionths());
        return { redemptionFee: settings.redemptionFeeBIPS.toString(), trailingFee: trailingFee.toString() };
    }

    async getTrailingFees(fasset: string): Promise<TrailingFee> {
        const bot = this.botService.getInfoBot(fasset);
        const trailingFee = toBN(await bot.context.assetManager.transferFeeMillionths());
        return { trailingFee: trailingFee.toString() };
    }

    async getAssetManagerAddress(fasset: string): Promise<AddressResponse> {
        const bot = this.botService.getInfoBot(fasset);
        return { address: bot.context.assetManager.address };
    }

    async getCollateralReservationFee(fasset: string, lots: number): Promise<any> {
        const bot = this.botService.getUserBot(fasset);
        return await bot.context.assetManager.collateralReservationFee(lots);
    }

    async getExecutorAddress(fasset: string): Promise<ExecutorResponse> {
        const bot = this.botService.getUserBot(fasset);
        const settings = await bot.context.assetManager.getSettings();
        return {
            executorAddress: bot.nativeAddress,
            executorFee: EXECUTION_FEE.toString(),
            redemptionFee: settings.redemptionFeeBIPS.toString(),
        };
    }

    private async getXRPTransaction(fasset: string, txHash: string) {
        const bot = this.botService.getUserBot(fasset);
        const transaction = await bot.context.blockchainIndexer.getTransaction(txHash);
        if (transaction != null) return transaction;
        let currentBlockHeight = await bot.context.blockchainIndexer.getLastFinalizedBlockNumber();
        const waitBlocks = 6 + currentBlockHeight;
        while (currentBlockHeight < waitBlocks) {
            await sleep(1000);
            const transaction = await bot.context.blockchainIndexer.getTransaction(txHash);
            if (transaction != null) return transaction;
            currentBlockHeight = await bot.context.blockchainIndexer.getLastFinalizedBlockNumber();
        }
        return null;
    }

    async requestMinting(requestMint: RequestMint): Promise<void> {
        const count = await this.em.count(Minting, { txhash: requestMint.txhash });
        if (count != 0) {
            throw new LotsException("Minting with this txhash already exists.");
        }
        if (requestMint.fasset.includes("XRP")) {
            const tx = await this.getXRPTransaction(requestMint.fasset, requestMint.txhash);
            if (tx == null) {
                logger.error(`Error in requestMinting - no tx ${requestMint.fasset} and ${requestMint.txhash}`);
                throw error;
            }
        }
        const vault = await this.em.findOne(Pool, { vaultAddress: requestMint.vaultAddress });
        /*if (vault == null) {
            logger.error(`Error in request minting - no vault found`);
            throw error;
        }*/
        const now = new Date();
        const timestamp = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const validUntil = timestamp.getTime();
        const hShake = vault.handshakeType == null ? 0 : Number(vault.handshakeType);
        // TODO if rejected based on type save minting as processed but for history
        let crEvent;
        let paymentAmount;
        if (hShake != 0) {
            crEvent = await this.em.findOne(CollateralReservationEvent, { collateralReservationId: requestMint.collateralReservationId });
            paymentAmount = crEvent.valueUBA;
        } else {
            crEvent = (await this.getCREventFromTxHash(requestMint.fasset, requestMint.nativeHash, true)) as CREventExtended;
            paymentAmount = crEvent.paymentAmount;
        }
        if (
            hShake == 0 &&
            (!(crEvent.from.toLocaleLowerCase() === requestMint.userAddress.toLocaleLowerCase()) ||
                !(crEvent.collateralReservationId === requestMint.collateralReservationId))
        ) {
            logger.error(`Error in requestMinting - userAddress or crID do not match`);
            throw error;
        }
        const bot = this.botService.getUserBot(requestMint.fasset);
        const settings = await bot.context.assetManager.getSettings();
        const amount = formatBNToDisplayDecimals(toBN(paymentAmount), requestMint.fasset.includes("XRP") ? 2 : 8, Number(settings.assetDecimals));
        const handshakeReq = hShake == 0 ? false : true;
        const minting = new Minting(
            requestMint.collateralReservationId,
            requestMint.txhash,
            requestMint.paymentAddress,
            requestMint.userUnderlyingAddress,
            false,
            validUntil,
            false,
            requestMint.fasset,
            requestMint.userAddress,
            amount,
            now.getTime(),
            handshakeReq,
            requestMint.vaultAddress
        );
        await this.em.persistAndFlush(minting);
    }

    async mintingStatus(txhash: string): Promise<MintingStatus> {
        const minting = await this.em.findOne(Minting, { txhash: txhash });
        const relay = this.botService.getRelay();
        const now = Math.floor(Date.now() / 1000);
        const currentRound = Number(await relay.getVotingRoundId(now));
        if (minting == null) {
            logger.error(`Error in mintingStatus - no minting ${txhash}`);
            throw error;
        }
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

    async requestRedemption(fasset: string, txhash: string, amount: string, userAddress: string): Promise<RequestRedemption> {
        const fullRedeemData = await this.getRedemptionRequestedEvents(fasset, txhash);
        const redemptions = fullRedeemData.redeemData;
        const now = new Date();
        const count = await this.em.count(FullRedemption, { txhash: txhash });
        if (count != 0) {
            throw new LotsException("Redemption with this txhash already exists.");
        }
        const timestamp = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const validUntil = timestamp.getTime();
        for (const redemptionEvent of redemptions) {
            const agent = await this.em.findOne(Pool, {
                vaultAddress: redemptionEvent.agentVault,
            });
            const redemption = new Redemption(
                txhash,
                false,
                redemptionEvent.underlyingAddress,
                redemptionEvent.paymentReference,
                redemptionEvent.amountUBA,
                redemptionEvent.firstUnderlyingBlock,
                redemptionEvent.lastUnderlyingBlock,
                redemptionEvent.lastUnderlyingTimestamp,
                redemptionEvent.requestId,
                validUntil,
                fasset,
                agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                false,
                false,
                false,
                now.getTime()
            );
            await this.em.persistAndFlush(redemption);
        }
        const fullRedemption = new FullRedemption(txhash, false, fasset, fullRedeemData.from, fullRedeemData.fullAmount, now.getTime());
        await this.em.persistAndFlush(fullRedemption);
        if (fullRedeemData.incomplete == true) {
            const incompleteRedemption = new IncompleteRedemption(
                txhash,
                fullRedeemData.dataIncomplete.redeemer,
                fullRedeemData.dataIncomplete.remainingLots,
                now.getTime()
            );
            await this.em.persistAndFlush(incompleteRedemption);
            return { incomplete: fullRedeemData.incomplete, remainingLots: fullRedeemData.dataIncomplete.remainingLots };
        }
        return { incomplete: fullRedeemData.incomplete };
    }

    async redemptionDefaultStatus(txhash: string): Promise<RedemptionDefaultStatusGrouped> {
        const redemptions = await this.em.find(Redemption, { txhash: txhash });
        const fullRedemption = await this.em.find(FullRedemption, { txhash: txhash });
        const now = new Date().getTime();
        if (redemptions.length == 0) {
            return { status: false };
        }
        for (const redemption of redemptions) {
            if (redemption.processed == false) {
                return { status: false };
            }
        }
        const redemptionDefaults = await this.em.find(RedemptionDefault, {
            txhash: txhash,
        });
        let underlyingPaid = toBN(0);
        const vaultCollateralPaid: VaultCollateralRedemption[] = [];
        let poolCollateralPaid = toBN(0);
        let vaultToken: string;
        let fasset: string;
        for (const redemption of redemptions) {
            if (redemption.defaulted == true) {
                const specificRedemptionDefault = redemptionDefaults.find((redemptionDefault) => redemptionDefault.requestId === redemption.requestId);
                let redDefEvent: RedemptionDefault;
                if (!specificRedemptionDefault) {
                    try {
                        redDefEvent = await this.getAndSaveRedemptionDefaultEvent(redemption, now);
                    } catch (error) {
                        logger.error("Error in redemption default status: ", error);
                        continue;
                    }
                } else {
                    redDefEvent = specificRedemptionDefault;
                }
                vaultToken = redDefEvent.collateralToken;
                fasset = redemption.fasset;
                const collateral = vaultCollateralPaid.find((paid) => paid.token === vaultToken);
                if (collateral) {
                    collateral.value = toBN(collateral.value).add(toBN(redDefEvent.redeemedVaultCollateralWei)).toString();
                } else {
                    vaultCollateralPaid.push({ token: vaultToken, value: toBN(redDefEvent.redeemedVaultCollateralWei).toString() });
                }
                //vaultCollateralPaid = vaultCollateralPaid.add(toBN(redDefEvent.redeemedVaultCollateralWei));
                poolCollateralPaid = poolCollateralPaid.add(toBN(redDefEvent.redeemedPoolCollateralWei));
            } else {
                underlyingPaid = underlyingPaid.add(toBN(redemption.amountUBA));
            }
        }
        const collaterals = await this.em.find(Collateral, {
            fasset: fasset,
        });
        vaultCollateralPaid.forEach((paid) => {
            const collateral = collaterals.find((collateral) => collateral.tokenFtsoSymbol === paid.token);
            paid.value = formatBNToDisplayDecimals(toBN(paid.value), vaultToken.includes("ETH") ? 6 : 3, collateral.decimals);
        });
        //const vaultCollateralRedeemed = formatBNToDisplayDecimals(toBN(vaultCollateralPaid), vaultToken == "testETH" ? 6 : 3, collateral[0].decimals);
        const poolCollateralRedeemed = formatBNToDisplayDecimals(toBN(poolCollateralPaid), 3, 18);
        const underlyingRedeemed = formatBNToDisplayDecimals(toBN(underlyingPaid), fasset.includes("XRP") ? 2 : 8, fasset.includes("XRP") ? 6 : 8);
        return {
            status: true,
            underlyingPaid: underlyingRedeemed,
            vaultCollateralPaid: vaultCollateralPaid,
            poolCollateralPaid: poolCollateralRedeemed,
            vaultCollateral: vaultToken,
            fasset: fasset,
            redeemedTokens: fullRedemption[0].amount,
        };
    }

    getUniqueAddresses(additionalAddress: string[], underlyingAddress: string): string[] {
        const filteredAddresses = additionalAddress.filter((address) => address !== underlyingAddress);
        const uniqueAddresses = new Set(filteredAddresses);
        return Array.from(uniqueAddresses);
    }

    async estimateFeeForBlocks(fasset: string): Promise<FeeEstimate> {
        const feeName = fasset.includes("BTC") ? "btcFee" : "dogeFee";
        let btcFee = await this.cacheManager.get(feeName);
        const bot = this.botService.getUserBot(fasset);
        if (this.envType == "dev") {
            if (btcFee === undefined) {
                try {
                    const blockHeight = Number(await this.externalApiService.getBlockBookHeight(fasset));
                    const feeData = await this.externalApiService.getFeeEstimationBlockHeight(fasset, blockHeight);
                    btcFee = toBN(feeData.decilesFeePerKb[feeData.decilesFeePerKb.length - 2]);
                } catch (error) {
                    btcFee = 1000000;
                }
                await this.cacheManager.set(feeName, btcFee.toString(), 600000);
            }
            //const fee = Math.min(Math.max(toBN(btcFee as string).divn(1000).toNumber(),5), 500);
            const fee = Math.max(
                toBN(btcFee as string)
                    .divn(1000)
                    .toNumber(),
                500
            );
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
            //const fee = Math.min(Math.max(toBN(btcFee as string).divn(1000).toNumber(),5), 500);
            const fee = Math.max(
                toBN(btcFee as string)
                    .divn(1000)
                    .toNumber(),
                500
            );
            const btcForBytes = 300 * fee;
            const extraBTC = btcForBytes / 10 ** 8;
            return { estimatedFee: fee.toFixed(0), extraBTC: extraBTC.toString() };
        }
    }

    async getXpubBalance(fasset: string, address: string) {
        try {
            const bot = this.botService.getUserBot(fasset);
            const balances = await this.externalApiService.getXpubBalanceBlockBook(fasset, address);
            const balance = toBN(balances.balance);
            if (fasset.includes("DOGE")) {
                return {
                    balance: formatFixed(toBN(balance), bot.context.chainInfo.decimals, {
                        decimals: 2,
                        groupDigits: true,
                        groupSeparator: ",",
                    }),
                };
            } else {
                return {
                    balance: formatFixed(toBN(balance), bot.context.chainInfo.decimals, {
                        decimals: 8,
                        groupDigits: true,
                        groupSeparator: ",",
                    }),
                };
            }
        } catch (error) {
            logger.error("Error in underlying balance xpub: ", error);
        }
    }

    async calculateUtxosForAmount(fasset: string, xpub: string, amount: string): Promise<UTXOSLedger> {
        const utxos = await this.externalApiService.getUtxosBlockBook(fasset, xpub, true);
        const fee = await this.estimateFeeForBlocks(fasset);
        const feeBTC = Math.floor(Number(fee.extraBTC) * 10 ** 8);
        const amountBN = toBN(Math.floor(Number(amount))).add(toBN(feeBTC));
        const sortedUtxos = utxos.sort((a, b) => {
            const valueA = toBN(a.value);
            const valueB = toBN(b.value);
            return valueB.sub(valueA).toNumber();
        });

        const selectedUtxos: SelectedUTXO[] = [];
        let totalSelectedAmount = toBN(0);

        const largestUtxo = sortedUtxos[0];
        selectedUtxos.push({
            txid: largestUtxo.txid,
            vout: largestUtxo.vout,
            value: largestUtxo.value,
            hexTx: await this.externalApiService.getTransactionHexBlockBook(fasset, largestUtxo.txid),
            path: largestUtxo.path,
            utxoAddress: largestUtxo.address,
        });
        totalSelectedAmount = totalSelectedAmount.add(toBN(largestUtxo.value));

        const remainingUtxos = sortedUtxos.slice(1);
        const randomUtxos = this.shuffleArray(remainingUtxos);

        for (const utxo of randomUtxos) {
            if (totalSelectedAmount.gte(amountBN.add(REMAIN_SATOSHIS))) {
                break;
            }
            selectedUtxos.push({
                txid: utxo.txid,
                vout: utxo.vout,
                value: utxo.value,
                hexTx: await this.externalApiService.getTransactionHexBlockBook(fasset, utxo.txid),
                path: utxo.path,
                utxoAddress: utxo.address,
            });
            totalSelectedAmount = totalSelectedAmount.add(toBN(utxo.value));
        }
        const change = totalSelectedAmount.sub(amountBN);
        if (totalSelectedAmount.lt(amountBN)) {
            throw new LotsException("Insufficient funds to cover the amount and fees.");
        }
        selectedUtxos.sort((a, b) => {
            const hashA = this.doubleKeccak256(a.utxoAddress);
            const hashB = this.doubleKeccak256(b.utxoAddress);
            return hashA.localeCompare(hashB);
        });
        const selectedAddresses = [];
        for (const u of selectedUtxos) {
            if (!selectedAddresses.includes(u.utxoAddress)) {
                selectedAddresses.push(u.utxoAddress);
            }
        }
        return { selectedUtxos: selectedUtxos, estimatedFee: feeBTC, returnAddresses: selectedAddresses };
    }

    shuffleArray<T>(array: T[]): T[] {
        const shuffledArray = array.slice();
        for (let i = shuffledArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
        }
        return shuffledArray;
    }

    //Sum balances if using /balanceHistory endpoint in blockbook
    async sumBalances(balances: TransactionBTC[]) {
        let totalReceived = toBN(0);
        let totalSent = toBN(0);
        let totalSentToSelf = toBN(0);
        if (balances.length == 0) {
            return null;
        }

        balances.forEach((transaction) => {
            totalReceived = totalReceived.add(toBN(transaction.received));
            totalSent = totalSent.add(toBN(transaction.sent));
            totalSentToSelf = totalSentToSelf.add(toBN(transaction.sentToSelf));
        });
        const netBalance = totalReceived.add(totalSentToSelf).sub(totalSent);
        return netBalance;
    }

    //Sum balances when using /utxo endpoint
    async sumUTXO(balances: UTXOBTC[]) {
        let value = toBN(0);
        if (balances.length == 0) {
            return null;
        }
        balances.forEach((transaction) => {
            if (Number(transaction.confirmations) >= 0) {
                value = value.add(toBN(transaction.value));
            }
        });
        return value;
    }

    //Get Balance if you use /address endpoint
    async getUnderlyingBalanceAddress(fasset: string, underlyingAddress: string, changeAddresses: string[], receiveAddresses: string[]) {
        //const mainAddressBalances = await this.getBalancesBlockBook(fasset, underlyingAddress);
        // First get balance of the connected account
        const mainAddressBalancesUTXO = await this.externalApiService.getAddressInfoBlockBook(fasset, underlyingAddress);
        let utxoBalance = toBN(mainAddressBalancesUTXO.balance);
        const changeBalancesUTXO = await Promise.all(changeAddresses.map((address) => this.externalApiService.getAddressInfoBlockBook(fasset, address)));
        const receiveBalancesUTXO = await Promise.all(receiveAddresses.map((address) => this.externalApiService.getAddressInfoBlockBook(fasset, address)));
        //Check if all addresses have some balance, if true return null as users need to accept window in bifrost
        let countReceiveUTXO = 0;
        let countChangeUTXO = 0;
        for (const u of changeBalancesUTXO) {
            if (u.txs == 0) {
                continue;
            }
            countChangeUTXO++;
            utxoBalance = utxoBalance.add(toBN(u.balance));
        }
        for (const u of receiveBalancesUTXO) {
            if (u.txs == 0) {
                continue;
            }
            countReceiveUTXO++;
            utxoBalance = utxoBalance.add(toBN(u.balance));
        }

        if (countReceiveUTXO == receiveBalancesUTXO.length || countChangeUTXO == changeBalancesUTXO.length) {
            return null;
        }
        return utxoBalance;
    }

    //Get Balance if you use /utxo endpoint
    async getUnderlyingBalanceUtxo(fasset: string, underlyingAddress: string, changeAddresses: string[], receiveAddresses: string[]) {
        //const mainAddressBalances = await this.getBalancesBlockBook(fasset, underlyingAddress);
        // First get balance of the connected account
        if (this.envType == "dev") {
            changeAddresses = changeAddresses.filter((address) => !address.startsWith("bc1"));
            receiveAddresses = receiveAddresses.filter((address) => !address.startsWith("bc1"));
        }
        const mainAddressBalancesUTXO = await this.externalApiService.getUtxosBlockBook(fasset, underlyingAddress, false);
        //let balance = await this.sumBalances(mainAddressBalances);
        let utxoBalance = await this.sumUTXO(mainAddressBalancesUTXO);
        if (utxoBalance == null) {
            utxoBalance = toBN(0);
        }

        //With getting utxos from blockbook for each address
        const changeBalancesUTXO = await Promise.all(changeAddresses.map((address) => this.externalApiService.getUtxosBlockBook(fasset, address, false)));
        const receiveBalancesUTXO = await Promise.all(receiveAddresses.map((address) => this.externalApiService.getUtxosBlockBook(fasset, address, false)));
        let countReceiveUTXO = 0;
        let countChangeUTXO = 0;
        for (const u of changeBalancesUTXO) {
            const sum = await this.sumUTXO(u);
            if (sum == null) {
                continue;
            }
            countChangeUTXO++;
            utxoBalance = utxoBalance.add(sum);
        }
        for (const u of receiveBalancesUTXO) {
            const sum = await this.sumUTXO(u);
            if (sum == null) {
                continue;
            }
            countReceiveUTXO++;
            utxoBalance = utxoBalance.add(sum);
        }
        if (countReceiveUTXO == receiveBalancesUTXO.length || countChangeUTXO == changeBalancesUTXO.length) {
            return null;
        }
        return utxoBalance;
    }

    //TODO add try catch
    async getUnderlyingBalance(
        fasset: string,
        underlyingAddress: string,
        additionalAddressReceive?: string[],
        additionalAddressChange?: string[]
    ): Promise<CommonBalance> {
        try {
            const bot = this.botService.getUserBot(fasset);
            if (fasset.includes("BTC") || fasset.includes("DOGE")) {
                //const utxos = this.getUniqueAddresses(additionalAddress,underlyingAddress);
                const changeAddresses = this.getUniqueAddresses(additionalAddressChange, underlyingAddress);
                const receiveAddresses = this.getUniqueAddresses(additionalAddressReceive, underlyingAddress);
                let balance = toBN(0);
                balance = await this.getUnderlyingBalanceUtxo(fasset, underlyingAddress, changeAddresses, receiveAddresses);
                if (balance == null) {
                    return { balance: null };
                }
                if (fasset.includes("DOGE")) {
                    return {
                        balance: formatFixed(toBN(balance), bot.context.chainInfo.decimals, { decimals: 2, groupDigits: true, groupSeparator: "," }),
                    };
                } else {
                    return {
                        balance: formatFixed(toBN(balance), bot.context.chainInfo.decimals, { decimals: 8, groupDigits: true, groupSeparator: "," }),
                    };
                }
            } else {
                for (let i = 0; i < NUM_RETRIES; i++) {
                    try {
                        const balance = await bot.context.wallet.getBalance(underlyingAddress);
                        return {
                            balance: formatFixed(toBN(balance), bot.context.chainInfo.decimals, { decimals: 2, groupDigits: true, groupSeparator: "," }),
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
            }
        } catch (error) {
            logger.error("Error in underlying balance: ", error);
        }
    }

    async getNativeBalances(address: string): Promise<NativeBalanceItem[]> {
        const bot = this.botService.getUserBot(this.botService.fassetList[0]);
        const settings = await bot.context.assetManager.getSettings();
        const priceReader = await TokenPriceReader.create(settings);
        const cflrPrice = await priceReader.getPrice(bot.context.nativeChainInfo.tokenSymbol, false, settings.maxTrustedPriceAgeSeconds);
        const priceUSD = cflrPrice.price.mul(toBNExp(1, 18));

        const collaterals: NativeBalanceItem[] = [];
        // Native balance
        const nativeBalanceWrapped = await web3.eth.getBalance(address);
        const balanceNative = formatBNToDisplayDecimals(toBN(nativeBalanceWrapped), 3, 18);
        const nativeUSD = toBN(nativeBalanceWrapped)
            .mul(priceUSD)
            .div(toBNExp(1, 18 + Number(cflrPrice.decimals)));
        const nativeUSDFormatted = formatFixed(nativeUSD, 18, {
            decimals: 3,
            groupDigits: true,
            groupSeparator: ",",
        });
        collaterals.push({
            symbol: bot.context.nativeChainInfo.tokenSymbol,
            balance: balanceNative,
            valueUSD: nativeUSDFormatted,
            wrapped: nativeBalanceWrapped,
        });
        //FBTC and other fassets
        const fassets = this.listAvailableFassets();
        for (const fasset of fassets.fassets) {
            const fBot = this.botService.getUserBot(fasset);
            const settingsAsset = await fBot.context.assetManager.getSettings();
            const redemptionFee = settings.redemptionFeeBIPS;
            const priceReaderAsset = await TokenPriceReader.create(settingsAsset);
            const priceAsset = await priceReaderAsset.getPrice(this.botService.getAssetSymbol(fasset), false, settingsAsset.maxTrustedPriceAgeSeconds);
            const fBalance = await fBot.context.fAsset.balanceOf(address);
            const assetUSD = toBN(toBN(fBalance).sub(toBN(fBalance).mul(toBN(redemptionFee)).divn(MAX_BIPS)))
                .mul(priceAsset.price)
                .div(toBNExp(1, Number(priceAsset.decimals)));
            const assetUSDFormatted = formatFixed(assetUSD, Number(settingsAsset.assetDecimals), {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            });
            const lotSizeUBA = toBN(settingsAsset.lotSizeAMG).mul(toBN(settingsAsset.assetMintingGranularityUBA));
            const lots = fBalance.div(lotSizeUBA);
            const fDecimals = Number(settingsAsset.assetDecimals);
            const fCollateral = {
                symbol: fBot.fAssetSymbol,
                balance: formatBNToDisplayDecimals(toBN(fBalance), 8, fDecimals),
                valueUSD: assetUSDFormatted,
                lots: lots.toString(),
            };
            collaterals.push(fCollateral);
        }
        //Vault collaterals
        const vaultCollaterals = this.botService.getCollateralList();
        for (const c of vaultCollaterals) {
            const collateralEntity = await this.em.findOne(Collateral, { tokenFtsoSymbol: c });
            const token = await IERC20.at(collateralEntity.token);
            const balance = await token.balanceOf(address);
            const decimals = (await token.decimals()).toNumber();
            collaterals.push({ symbol: c, balance: formatBNToDisplayDecimals(toBN(balance), 3, decimals) });
        }
        return collaterals;
    }

    //TODO: add getting rejection/cancel event from DB first and if present return false before reading CREvent from DB
    async getCrStatus(crId: string): Promise<CRStatus | null> {
        const [crRejected, crEvent] = await Promise.all([
            this.em.findOne(CrRejectedCancelledEvent, { collateralReservationId: crId }),
            this.em.findOne(CollateralReservationEvent, { collateralReservationId: crId }),
        ]);
        if (crEvent == null && crRejected == null) {
            return { status: false };
        }
        if (crRejected != null) {
            return {
                status: true,
                accepted: false,
            };
        }
        if (crEvent == null) {
            return { status: false };
        }
        const paymentAmount = toBN(crEvent.feeUBA).add(toBN(crEvent.valueUBA));
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
    async getCREventFromTxHash(fasset: string, txhash: string, local: boolean): Promise<CREvent | CREventExtended | HandshakeEvent> {
        const bot = this.botService.getUserBot(fasset);
        try {
            let receipt = await web3.eth.getTransactionReceipt(txhash);
            let i = 0;
            while (receipt == null) {
                await sleep(1000);
                receipt = await web3.eth.getTransactionReceipt(txhash);
                i++;
                if (i == 20) {
                    logger.error(`Error in getCREventFromTxHash - time exceeded for ${fasset} and ${txhash} `);
                    throw error;
                }
            }
            const inputsCollateralReserved = bot.context.assetManager.abi.find((item) => item.name === "CollateralReserved");
            const inputsHandshake = bot.context.assetManager.abi.find((item) => item.name === "HandshakeRequired");
            //const sigCollateralReserved = "0x7e28eb3b9a2077a4fa0559357b1647ec5eabf18d7adf1539c4e8fb1445a5fc09";
            //const sigHandshake = "0x5ed9d178ee4866ba21f1ed094f3ff1f16f635e25a3fb180d2989a5a579df73a9";
            for (const log of receipt.logs) {
                try {
                    let inputs;
                    if (log.topics[0] === sigCollateralReserved) {
                        inputs = inputsCollateralReserved.inputs;
                    } else if (log.topics[0] === sigHandshake) {
                        inputs = inputsHandshake.inputs;
                    } else {
                        return;
                    }
                    const decodedLog = web3.eth.abi.decodeLog(inputs, log.data, log.topics.slice(1));
                    const paymentAmount = toBN(decodedLog.feeUBA).add(toBN(decodedLog.valueUBA));
                    if (log.topics[0] === sigCollateralReserved) {
                        if (!local) {
                            return {
                                collateralReservationId: decodedLog.collateralReservationId,
                                paymentAmount: paymentAmount.toString(),
                                paymentAddress: decodedLog.paymentAddress,
                                paymentReference: decodedLog.paymentReference,
                            } as CREvent;
                        } else {
                            return {
                                collateralReservationId: decodedLog.collateralReservationId,
                                paymentAmount: decodedLog.valueUBA,
                                paymentAddress: decodedLog.paymentAddress,
                                paymentReference: decodedLog.paymentReference,
                                from: receipt.from,
                            } as CREventExtended;
                        }
                    } else {
                        if (log.topics[0] === sigHandshake) {
                            return {
                                collateralReservationId: decodedLog.collateralReservationId,
                            } as HandshakeEvent;
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

    // Gets all redemption requested events from txhash, TODO: add incomplete redemption, example 0x4a451fbb0792eb1299c9d5af7e0e1aa06fde285b032a4d67eb983a76d543df7d
    //TODO: add if rejected/takenOver/defaulted
    async getRedemptionRequestedEvents(fasset: string, txhash: string): Promise<FullRedeemData> {
        const bot = this.botService.getUserBot(fasset);
        const inputsRedemptionRequest = bot.context.assetManager.abi.find((item) => item.name === "RedemptionRequested");
        const inputsRedemptionIncomplete = bot.context.assetManager.abi.find((item) => item.name === "RedemptionRequestIncomplete");
        const sigRedemptionRequest = "0x8cbbd73a8d1b8b02a53c4c3b0ee34b472fe3099cc19bcfb57f1aae09e8a9847e";
        const sigRedemptionIncomplete = "0xffb29516defd624d1f4ff8436cc96282ba7b4294c3a18cf274c3bdf21c9ccd99";
        let receipt = await web3.eth.getTransactionReceipt(txhash);
        let i = 0;
        let incomplete = false;
        let dataIncomplete: RedemptionIncomplete = null;
        while (receipt == null) {
            await sleep(1000);
            receipt = await web3.eth.getTransactionReceipt(txhash);
            i++;
            if (i == 20) {
                logger.error(`Error in getRedemptionRequestedEvents ${fasset} and ${txhash}`);
                throw error;
            }
        }
        const redemptions = [];
        const timestamp = await latestBlockTimestamp();
        let amount = toBN(0);
        receipt.logs.forEach((log) => {
            try {
                let inputs;
                if (log.topics[0] === sigRedemptionRequest) {
                    inputs = inputsRedemptionRequest.inputs;
                } else if (log.topics[0] === sigRedemptionIncomplete) {
                    inputs = inputsRedemptionIncomplete.inputs;
                } else {
                    return;
                }
                const decodedLog = web3.eth.abi.decodeLog(inputs, log.data, log.topics.slice(1));
                if (Number(decodedLog.__length__) == 12) {
                    const amountUBA = toBN(decodedLog.valueUBA).sub(toBN(decodedLog.feeUBA));
                    amount = amount.add(toBN(decodedLog.valueUBA));
                    const redemption: RedemptionData = {
                        type: "redeem",
                        requestId: decodedLog.requestId,
                        amountUBA: amountUBA.toString(),
                        paymentReference: decodedLog.paymentReference,
                        firstUnderlyingBlock: decodedLog.firstUnderlyingBlock,
                        lastUnderlyingBlock: decodedLog.lastUnderlyingBlock,
                        lastUnderlyingTimestamp: decodedLog.lastUnderlyingTimestamp,
                        executorAddress: decodedLog.executor,
                        createdAt: timestampToDateString(timestamp),
                        underlyingAddress: decodedLog.paymentAddress,
                        agentVault: decodedLog.agentVault,
                    };
                    redemptions.push(redemption);
                }
                if (Number(decodedLog.__length__) == 2) {
                    incomplete = true;
                    dataIncomplete = { redeemer: decodedLog.redeemer, remainingLots: decodedLog.remainingLots };
                }
            } catch (error) {
                //logger.error(`Error in getRedemptionRequestedEvents (abi):`, error);
            }
        });
        const settings = await bot.context.assetManager.getSettings();
        const value = formatBNToDisplayDecimals(amount, fasset.includes("XRP") ? 2 : 8, Number(settings.assetDecimals));
        return { redeemData: redemptions, fullAmount: value, from: receipt.from, incomplete: incomplete, dataIncomplete: dataIncomplete };
    }

    async redemptionStatus(bot: UserBotCommands, state: RedeemData, timestamp: number, settings: AssetManagerSettings): Promise<RedemptionStatusEnum> {
        const stateTs = dateStringToTimestamp(state.createdAt);
        if (timestamp - stateTs >= Number(settings.attestationWindowSeconds)) {
            return RedemptionStatusEnum.EXPIRED;
        } else if (await this.findRedemptionPayment(bot, state)) {
            return RedemptionStatusEnum.SUCCESS;
        } else if (await this.redemptionTimeElapsed(bot, state)) {
            return RedemptionStatusEnum.DEFAULT;
        } else {
            return RedemptionStatusEnum.PENDING;
        }
    }

    private async handleInputsOutputs(bot: UserBotCommands, data: any, input: boolean): Promise<TxInputOutput[]> {
        const type = data.transactionType;
        const res = data.response;
        switch (bot.context.blockchainIndexer.chainId) {
            case ChainId.BTC:
            case ChainId.DOGE:
            case ChainId.testBTC:
            case ChainId.testDOGE:
                return await this.UTXOInputsOutputs(type, res, input);
            case ChainId.XRP:
            case ChainId.testXRP:
                return this.XRPInputsOutputs(bot, data, input);
            default:
                logger.error(`Block chain indexer helper error: invalid SourceId: ${bot.context.blockchainIndexer.chainId}`);
                throw new Error(`Invalid SourceId: ${bot.context.blockchainIndexer.chainId}.`);
        }
    }

    private toBnValue(value: number | undefined): BN {
        if (value === undefined) {
            return toBN(0);
        }
        return toBN(Math.round(value * BTC_MDU).toFixed(0));
    }

    private async UTXOInputsOutputs(type: string, data: any, input: boolean): Promise<TxInputOutput[]> {
        if (input) {
            if (type === "coinbase") {
                return [["", toBN(0)]];
            } else {
                const inputs: TxInputOutput[] = [];
                data.vin.map((vin: any) => {
                    const address = vin.prevout && vin.prevout.scriptPubKey.address ? vin.prevout.scriptPubKey.address : "";
                    const value = this.toBnValue(vin.prevout?.value || 0);
                    inputs.push([address, value]);
                });
                if (inputs.length == 0) return [["", toBN(0)]];
                return inputs;
            }
        } else {
            const outputs: TxInputOutput[] = [];
            data.vout.map((vout: any) => {
                outputs.push([vout.scriptPubKey.address, this.toBnValue(vout.value)]);
            });
            if (outputs.length == 0) return [["", toBN(0)]];
            return outputs;
        }
    }

    private XRPInputsOutputs(bot: UserBotCommands, data: any, input: boolean): TxInputOutput[] {
        const response = data.response.result;
        if (input) {
            if (data.isNativePayment) {
                return [[response.Account, toBN(response.Amount as any).add(toBN(response.Fee ? response.Fee : 0))]];
            }
            return [[response.Account, response.Fee ? toBN(response.Fee) : toBN(0)]];
        } else {
            if (data.isNativePayment && this.successStatus(bot, data) === TX_SUCCESS) {
                /* istanbul ignore next */
                const metaData = response.meta || (response as any).metaData;
                return [[response.Destination, toBN(metaData.delivered_amount as string)]];
            }
            return [["", toBN(0)]];
        }
    }

    // TODO: fix when real network
    private isUTXOchain(bot: UserBotCommands): boolean {
        return (
            bot.context.blockchainIndexer.chainId === ChainId.testBTC ||
            bot.context.blockchainIndexer.chainId === ChainId.testDOGE ||
            bot.context.blockchainIndexer.chainId === ChainId.LTC ||
            bot.context.blockchainIndexer.chainId === ChainId.BTC ||
            bot.context.blockchainIndexer.chainId === ChainId.DOGE
        );
    }

    private successStatus(bot: UserBotCommands, data: any): number {
        if (this.isUTXOchain(bot)) {
            return TX_SUCCESS;
        }
        // https://xrpl.org/transaction-results.html
        const response = data.response.result;
        /* istanbul ignore next */
        const metaData = response.meta || (response as any).metaData;
        const result = metaData.TransactionResult;
        if (result === "tesSUCCESS") {
            // https://xrpl.org/tes-success.html
            return TX_SUCCESS;
        }
        if (result.startsWith("tec")) {
            // https://xrpl.org/tec-codes.html
            switch (result) {
                case "tecDST_TAG_NEEDED":
                case "tecNO_DST":
                case "tecNO_DST_INSUF_XRP":
                case "tecNO_PERMISSION":
                    return TX_BLOCKED;
                default:
                    return TX_FAILED;
            }
        }
        // Other codes: tef, tel, tem, ter are not applied to ledgers
        return TX_FAILED;
    }

    async findRedemptionPayment(bot: UserBotCommands, state: RedeemData) {
        //const txs = await bot.context.blockchainIndexer.getTransactionsByReference(state.paymentReference);
        const txs = await bot.context.blockchainIndexer.getTransactionsByReference(state.paymentReference);
        for (const tx of txs) {
            const amount = sumBN(
                tx.outputs.filter((o) => o[0] === state.underlyingAddress),
                (o) => o[1]
            );
            if (amount.gte(toBN(state.amountUBA))) {
                return tx;
            }
        }
    }

    async redemptionTimeElapsed(bot: UserBotCommands, state: RedeemData): Promise<boolean> {
        const blockHeight = await bot.context.blockchainIndexer.getLastFinalizedBlockNumber();
        const lastBlock = requireNotNull(await bot.context.blockchainIndexer.getBlockAt(blockHeight));
        return blockHeight > Number(state.lastUnderlyingBlock) && lastBlock.timestamp > Number(state.lastUnderlyingTimestamp);
    }

    async getRedemptionStatus(fasset: string, txhash: string): Promise<RedemptionStatus> {
        const bot = this.botService.getUserBot(fasset);
        const fullRedeemData = await this.getRedemptionRequestedEvents(fasset, txhash);
        const takenOverRed = await this.em.find(Redemption, { txhash: txhash });
        let takenOver = false;
        let rejected = false;
        let rejectedDefaulted = false;
        for (let i = 0; i < takenOverRed.length; i++) {
            if (takenOverRed[i].amountUBA === "0") {
                continue;
            }
            const redemption: RedeemData = {
                type: "redeem",
                requestId: takenOverRed[i].requestId,
                amountUBA: takenOverRed[i].amountUBA.toString(),
                paymentReference: takenOverRed[i].paymentReference,
                firstUnderlyingBlock: takenOverRed[i].firstUnderlyingBlock,
                lastUnderlyingBlock: takenOverRed[i].lastUnderlyingBlock,
                lastUnderlyingTimestamp: takenOverRed[i].lastUnderlyingTimestamp,
                executorAddress: bot.nativeAddress,
                createdAt: (takenOverRed[i].timestamp / 1000).toString(),
                underlyingAddress: takenOverRed[i].underlyingAddress,
            };
            if (takenOverRed[i].takenOver) {
                takenOver = true;
            }
            if (takenOverRed[i].rejected) {
                rejected = true;
            }
            if (takenOverRed[i].rejectionDefault) {
                rejectedDefaulted = true;
            }
            const status = await this.redemptionStatus(bot, redemption, await latestBlockTimestamp(), await bot.context.assetManager.getSettings());
            switch (status) {
                case RedemptionStatusEnum.PENDING:
                    return { status: status, incomplete: fullRedeemData.incomplete, incompleteData: fullRedeemData.dataIncomplete };
                case "SUCCESS":
                    break;
                case RedemptionStatusEnum.DEFAULT:
                    return { status: RedemptionStatusEnum.DEFAULT, incomplete: fullRedeemData.incomplete, incompleteData: fullRedeemData.dataIncomplete };
                default:
                    break;
            }
        }
        return {
            status: RedemptionStatusEnum.SUCCESS,
            incomplete: fullRedeemData.incomplete,
            incompleteData: fullRedeemData.dataIncomplete,
            rejected: rejected,
            takenOver: takenOver,
            rejectedDefaulted: rejectedDefaulted,
        };
    }

    async getAgentLiveness(address: string, now: number): Promise<any> {
        const agentLiveness = await this.em.findOne(Liveness, {
            vaultAddress: address,
        });
        let status = true;
        if (agentLiveness == null) {
            status = false;
        } else {
            if (now - agentLiveness.lastTimestamp > 2 * 60 * 60 * 1000) {
                status = false;
            }
            /*if (agentLiveness.lastPinged == 0) {
        status = true;
      }*/
            /* if (agentLiveness.lastPinged != 0 && agentLiveness.lastTimestamp == 0) {
        status = false;
      }*/
        }
        return status;
    }

    //TODO: add verification return
    async getAgents(fassets: string[]): Promise<AgentPoolItem[]> {
        try {
            const pools = [];
            const now = Date.now();

            for (const fasset of fassets) {
                const agents = await this.em.find(Pool, { fasset });
                const bot = this.botService.getUserBot(fasset);

                for (const agent of agents) {
                    try {
                        if (!agent.publiclyAvailable) {
                            continue;
                        }
                        if (agent.status == 3) {
                            continue;
                        }
                        const status = await this.getAgentLiveness(agent.vaultAddress, now);
                        const vaultCollaterals = await this.em.find(Collateral, {
                            fasset: fasset,
                            token: agent.vaultToken,
                        });
                        const poolCollaterals = await this.em.find(Collateral, {
                            fasset: fasset,
                            tokenFtsoSymbol: bot.context.nativeChainInfo.tokenSymbol,
                        });
                        const vaultCollateral = vaultCollaterals[0];
                        const poolCollateral = poolCollaterals[0];
                        const agentPool = {
                            vault: agent.vaultAddress,
                            pool: agent.poolAddress,
                            totalPoolCollateral: agent.totalPoolCollateral,
                            poolCR: Number(agent.poolCR).toFixed(2),
                            vaultCR: Number(agent.vaultCR).toFixed(2),
                            feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                            agentName: agent.agentName,
                            vaultType: agent.vaultType,
                            poolExitCR: Number(agent.poolExitCR).toFixed(2),
                            freeLots: agent.freeLots,
                            status: status,
                            mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                            health: agent.status,
                            mintCount: agent.mintNumber,
                            numLiquidations: agent.numLiquidations,
                            redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                            url: agent.url,
                            poolCollateralUSD: agent.poolNatUsd,
                            vaultCollateral: agent.vaultCollateral,
                            collateralToken: agent.vaultCollateralToken,
                            poolTopupCR: Number(agent.poolTopupCR).toFixed(2),
                            mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                            mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                            vaultCCBCR: Number(vaultCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                            vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                            vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            poolCCBCR: Number(poolCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                            poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                            poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            handshakeType: agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                            description: agent.description,
                            mintedAssets: agent.mintedUBA,
                            mintedUSD: agent.mintedUSD,
                            remainingAssets: agent.remainingUBA,
                            remainingUSD: agent.remainingUSD,
                            allLots: agent.allLots,
                            poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                            vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                            totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                            limitUSD: agent.limitUSD,
                            infoUrl: agent.infoUrl,
                        };
                        pools.push(agentPool);
                    } catch (error) {
                        logger.error(`Error in getAgents (getAgentLiveness):`, error);
                        continue;
                    }
                }
            }
            return pools;
        } catch (error) {
            logger.error(`Error in getAgents:`, error);
            throw error;
        }
    }

    async getAgentSpecific(fasset: string, poolAddress: string): Promise<AgentPoolItem> {
        try {
            const pools = [];
            const now = Date.now();
            const agent = await this.em.findOne(Pool, { poolAddress: poolAddress });
            const status = await this.getAgentLiveness(agent.vaultAddress, now);
            const bot = this.botService.getUserBot(fasset);
            const vaultCollateral = await this.em.findOne(Collateral, {
                fasset: fasset,
                token: agent.vaultToken,
            });
            const poolCollateral = await this.em.findOne(Collateral, {
                fasset: fasset,
                tokenFtsoSymbol: bot.context.nativeChainInfo.tokenSymbol,
            });
            const agentPool: AgentPoolItem = {
                vault: agent.vaultAddress,
                pool: agent.poolAddress,
                tokenAddress: agent.tokenAddress,
                totalPoolCollateral: agent.totalPoolCollateral,
                poolCR: Number(agent.poolCR).toFixed(2),
                vaultCR: Number(agent.vaultCR).toFixed(2),
                feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                agentName: agent.agentName,
                vaultType: agent.vaultType,
                poolExitCR: Number(agent.poolExitCR).toFixed(2),
                freeLots: agent.freeLots,
                status: status,
                mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                health: agent.status,
                mintCount: agent.mintNumber,
                numLiquidations: agent.numLiquidations,
                redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                url: agent.url,
                poolCollateralUSD: agent.poolNatUsd,
                vaultCollateral: agent.vaultCollateral,
                collateralToken: agent.vaultCollateralToken,
                poolTopupCR: Number(agent.poolTopupCR).toFixed(2),
                mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                vaultCCBCR: Number(vaultCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                poolCCBCR: Number(poolCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                description: agent.description,
                mintedAssets: agent.mintedUBA,
                mintedUSD: agent.mintedUSD,
                remainingAssets: agent.remainingUBA,
                remainingUSD: agent.remainingUSD,
                allLots: agent.allLots,
                poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                limitUSD: agent.limitUSD,
                handshakeType: agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                infoUrl: agent.infoUrl,
            };
            return agentPool;
        } catch (error) {
            logger.error(`Error in getAgents:`, error);
            throw error;
        }
    }

    //TODO: add verification return
    async getAgentsLatest(fasset: string): Promise<AgentPoolLatest[]> {
        try {
            const agents = await this.em.find(Pool, { fasset });
            const infoBot = this.botService.getInfoBot(fasset);
            const pools: AgentPoolLatest[] = [];
            const now = Date.now();
            const vaults = await infoBot.getAvailableAgents();
            const settings = await infoBot.context.assetManager.getSettings();
            const tokenSupply = await infoBot.context.fAsset.totalSupply();
            const lotSizeUBA = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
            const mintingCap = toBN(settings.mintingCapAMG).mul(toBN(settings.assetMintingGranularityUBA));
            const availableToMintUBA = mintingCap.toString() === "0" ? toBN(0) : mintingCap.sub(tokenSupply);
            const availableToMintLots = mintingCap.toString() === "0" ? toBN(0) : availableToMintUBA.div(lotSizeUBA);
            for (const agent of agents) {
                try {
                    if (agent.status != 0 || !agent.publiclyAvailable) {
                        continue;
                    }
                    //const info = await infoBot.context.assetManager.getAgentInfo(agent.vaultAddress);
                    const info = vaults.find((v) => v.agentVault === agent.vaultAddress);
                    if (Number(info.freeCollateralLots) == 0) {
                        continue;
                    }
                    const status = await this.getAgentLiveness(agent.vaultAddress, now);
                    const poolcr = Number(agent.poolCR);
                    const vaultcr = Number(agent.vaultCR);
                    const poolExitCR = Number(agent.poolExitCR);
                    const feeBIPS = info.feeBIPS;
                    const lots =
                        mintingCap.toString() === "0"
                            ? Number(info.freeCollateralLots.toString())
                            : Math.min(Number(info.freeCollateralLots.toString()), availableToMintLots.toNumber());
                    const agentPool = {
                        vault: agent.vaultAddress,
                        totalPoolCollateral: agent.totalPoolCollateral,
                        poolCR: poolcr.toFixed(2),
                        vaultCR: vaultcr.toFixed(2),
                        feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                        agentName: agent.agentName,
                        vaultType: agent.vaultType,
                        poolExitCR: poolExitCR.toFixed(2),
                        freeLots: lots.toString(),
                        status: status,
                        mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                        health: Number(agent.status),
                        url: agent.url,
                        feeBIPS: feeBIPS.toString(),
                        handshakeType: agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                        underlyingAddress: agent.underlyingAddress,
                        infoUrl: agent.infoUrl,
                    };
                    pools.push(agentPool);
                } catch (error) {
                    logger.error(`Error in getAgentsLatest (getAgentLiveness):`, error);
                    continue;
                }
            }
            return pools;
        } catch (error) {
            logger.error(`Error in getAgentsLatest:`, error);
            throw error;
        }
    }

    async getTokenBalanceFromIndexer(userAddress: string): Promise<IndexerTokenBalances[]> {
        const data = await this.externalApiService.getUserCollateralPoolTokens(userAddress);
        return data;
    }

    async getTokenBalanceFromExplorer(userAddress: string): Promise<CostonExpTokenBalance[]> {
        const data = await lastValueFrom(this.httpService.get(this.costonExplorerUrl + "?module=account&action=tokenlist&address=" + userAddress));
        return data.data.result;
    }

    //TODO: add verification return
    async getPools(fassets: string[], address: string): Promise<AgentPoolItem[]> {
        if (address === "undefined") {
            return;
        }
        //const a = await web3.utils.toChecksumAddress(address);
        const cptokenBalances = await this.getTokenBalanceFromIndexer(address);
        //const allTokens = await this.getTokenBalanceFromExplorer(address);
        //const filteredTokens = allTokens.filter((token) => token.name.startsWith("FAsset Collateral Pool Token"));
        //const contractInfoMap = new Map<string, CostonExpTokenBalance>(filteredTokens.map((info) => [info.contractAddress.toLowerCase(), info]));
        for (let i = 0; i < NUM_RETRIES; i++) {
            try {
                const pools = [];
                //const contractInfoMap = new Map<string, IndexerTokenBalances>(cptokenBalances.map((info) => [info.token, info]));
                const now = Date.now();
                for (const fasset of fassets) {
                    const agents = await this.em.find(Pool, { fasset });

                    // prefetch
                    const livenessPromises = agents.map((agent) => this.getAgentLiveness(agent.vaultAddress, now));
                    const livenessData = await Promise.all(livenessPromises);

                    // calc userPoolNatBalance in USD
                    const bot = this.botService.getInfoBot(fasset);
                    const settings = await bot.context.assetManager.getSettings();
                    const price = await this.getPoolCollateralPrice(fasset, settings);
                    const priceReader = await TokenPriceReader.create(settings);
                    const priceAsset = await priceReader.getPrice(this.botService.getAssetSymbol(fasset), false, settings.maxTrustedPriceAgeSeconds);

                    for (let i = 0; i < agents.length; i++) {
                        const agent = agents[i];
                        try {
                            const status = livenessData[i];
                            const info = cptokenBalances[agent.tokenAddress];
                            //const info = contractInfoMap.get(agent.tokenAddress.toLowerCase());
                            if (!info && !agent.publiclyAvailable) {
                                continue;
                            }
                            const vaultCollaterals = await this.em.find(Collateral, {
                                fasset: fasset,
                                token: agent.vaultToken,
                            });
                            const poolCollaterals = await this.em.find(Collateral, {
                                fasset: fasset,
                                tokenFtsoSymbol: bot.context.nativeChainInfo.tokenSymbol,
                            });
                            const vaultCollateral = vaultCollaterals[0];
                            const poolCollateral = poolCollaterals[0];
                            if (!info) {
                                if (agent.status == 3) {
                                    continue;
                                }
                                const agentPool = {
                                    vault: agent.vaultAddress,
                                    pool: agent.poolAddress,
                                    totalPoolCollateral: agent.totalPoolCollateral,
                                    poolCR: Number(agent.poolCR).toFixed(2),
                                    vaultCR: Number(agent.vaultCR).toFixed(2),
                                    userPoolBalance: "0",
                                    userPoolFees: "0",
                                    feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                                    userPoolNatBalance: "0",
                                    userPoolNatBalanceInUSD: "0",
                                    agentName: agent.agentName,
                                    vaultType: agent.vaultType,
                                    poolExitCR: Number(agent.poolExitCR).toFixed(2),
                                    status: status,
                                    userPoolShare: "0",
                                    health: agent.status,
                                    freeLots: agent.freeLots,
                                    mintCount: agent.mintNumber,
                                    numLiquidations: agent.numLiquidations,
                                    redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                                    url: agent.url,
                                    poolCollateralUSD: agent.poolNatUsd,
                                    vaultCollateral: agent.vaultCollateral,
                                    collateralToken: agent.vaultCollateralToken,
                                    transferableTokens: "0",
                                    poolTopupCR: Number(agent.poolTopupCR).toFixed(2),
                                    tokenAddress: agent.tokenAddress,
                                    fassetDebt: "0",
                                    nonTimeLocked: "0",
                                    mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                                    mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                                    vaultCCBCR: Number(vaultCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                                    vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                                    vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    poolCCBCR: Number(poolCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                                    poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                                    poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                                    handshakeType: agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                                    description: agent.description,
                                    mintedAssets: agent.mintedUBA,
                                    mintedUSD: agent.mintedUSD,
                                    remainingAssets: agent.remainingUBA,
                                    remainingUSD: agent.remainingUSD,
                                    allLots: agent.allLots,
                                    poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                                    vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                                    userPoolFeesUSD: "0",
                                    totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                                    limitUSD: agent.limitUSD,
                                    infoUrl: agent.infoUrl,
                                    lifetimeClaimedPoolFormatted: "0",
                                    lifetimeClaimedPoolUSDFormatted: "0",
                                };
                                pools.push(agentPool);
                                continue;
                            }

                            const pool = await CollateralPool.at(agent.poolAddress);
                            const poolToken = await CollateraPoolToken.at(agent.tokenAddress);
                            const balance = toBN(await poolToken.balanceOf(address));
                            if (balance.eqn(0)) {
                                const claimedPools = await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress);
                                let lifetimeClaimedPool = "0";
                                if (Object.keys(claimedPools).length != 0) {
                                    const keys = Object.keys(claimedPools);
                                    const firstKey = keys[0];
                                    lifetimeClaimedPool = claimedPools[firstKey].value;
                                }
                                /*const lifetimeClaimedPool = (await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress))[0]
                                    .claimedUBA;*/
                                const lifetimeClaimedPoolFormatted = formatBNToDisplayDecimals(
                                    toBN(lifetimeClaimedPool),
                                    fasset.includes("XRP") ? 3 : 8,
                                    Number(settings.assetDecimals)
                                );
                                const lifetimeClaimedPoolUSD = toBN(lifetimeClaimedPool)
                                    .mul(priceAsset.price)
                                    .div(toBNExp(1, Number(priceAsset.decimals)));
                                const lifetimeClaimedPoolUSDFormatted = formatFixed(lifetimeClaimedPoolUSD, Number(settings.assetDecimals), {
                                    decimals: 3,
                                    groupDigits: true,
                                    groupSeparator: ",",
                                });
                                const agentPool = {
                                    vault: agent.vaultAddress,
                                    pool: agent.poolAddress,
                                    totalPoolCollateral: agent.totalPoolCollateral,
                                    poolCR: Number(agent.poolCR).toFixed(2),
                                    vaultCR: Number(agent.vaultCR).toFixed(2),
                                    //userPoolBalance: formatFixed(balance, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                    userPoolBalance: formatBNToDisplayDecimals(balance, 3, 18),
                                    //userPoolFees: formatFixed(fees, 6, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                    userPoolFees: "0",
                                    feeShare: (agent.feeShare * 100).toFixed(0),
                                    userPoolNatBalance: "0",
                                    userPoolNatBalanceInUSD: "0",
                                    agentName: agent.agentName,
                                    vaultType: agent.vaultType,
                                    poolExitCR: Number(agent.poolExitCR).toFixed(2),
                                    status: status,
                                    userPoolShare: "0",
                                    health: agent.status,
                                    freeLots: agent.freeLots,
                                    mintCount: agent.mintNumber,
                                    numLiquidations: agent.numLiquidations,
                                    redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                                    url: agent.url,
                                    poolCollateralUSD: agent.poolNatUsd,
                                    vaultCollateral: agent.vaultCollateral,
                                    collateralToken: agent.vaultCollateralToken,
                                    //transferableTokens: formatFixed(transferableTokens, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                    transferableTokens: "0",
                                    poolTopupCR: Number(agent.poolTopupCR).toFixed(2),
                                    tokenAddress: agent.tokenAddress,
                                    //fassetDebt: formatFixed(fassetDebt, 6, { decimals: 6, groupDigits: true, groupSeparator: "," })
                                    fassetDebt: "0",
                                    nonTimeLocked: "0",
                                    mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                                    mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                                    vaultCCBCR: Number(vaultCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                                    vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                                    vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    poolCCBCR: Number(poolCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                                    poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                                    poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                    mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                                    description: agent.description,
                                    mintedAssets: agent.mintedUBA,
                                    mintedUSD: agent.mintedUSD,
                                    remainingAssets: agent.remainingUBA,
                                    remainingUSD: agent.remainingUSD,
                                    allLots: agent.allLots,
                                    poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                                    vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                                    userPoolFeesUSD: "0",
                                    totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                                    limitUSD: agent.limitUSD,
                                    lifetimeClaimedPoolFormatted: lifetimeClaimedPoolFormatted,
                                    lifetimeClaimedPoolUSDFormatted: lifetimeClaimedPoolUSDFormatted,
                                };
                                pools.push(agentPool);
                                continue;
                            }
                            const balanceFormated = formatBNToDisplayDecimals(balance, 3, 18);
                            const poolNatBalance = toBN(await pool.totalCollateral()); // collateral in pool (for example # of SGB in pool)
                            const totalSupply = toBN(await poolToken.totalSupply()); // all issued collateral pool tokens
                            //If formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                            const userPoolNatBalance = balanceFormated.toString() == "0" ? "0" : toBN(balance).mul(poolNatBalance).div(totalSupply);
                            const fees = balanceFormated.toString() === "0" ? "0" : await pool.fAssetFeesOf(address);
                            const feesUSD = toBN(fees)
                                .mul(priceAsset.price)
                                .div(toBNExp(1, Number(priceAsset.decimals)));
                            const feesUSDFormatted =
                                balanceFormated.toString() === "0"
                                    ? "0"
                                    : formatFixed(feesUSD, Number(settings.assetDecimals), {
                                          decimals: 3,
                                          groupDigits: true,
                                          groupSeparator: ",",
                                      });
                            const transferableTokens = await poolToken.transferableBalanceOf(address);
                            const nonTimeLocked = await poolToken.nonTimelockedBalanceOf(address);
                            const totalSupplyNum = Number(totalSupply.div(toBNExp(1, 18)));
                            const balanceNum = Number(balance.div(toBNExp(1, 18)));
                            let percentage = (balanceNum / totalSupplyNum) * 100;
                            const fassetDebt = await pool.fAssetFeeDebtOf(address);
                            //If formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                            const userPoolNatBalanceUSD =
                                balanceFormated.toString() == "0" ? "0" : toBN(userPoolNatBalance).mul(price.tokenPrice.price).div(toBNExp(1, 18)); //still needs to be trimmed for price.tokenPrice.decimals in formatFixed
                            if (percentage < 0.01) {
                                percentage = 0.01;
                            }
                            const claimedPools = await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress);
                            let lifetimeClaimedPool = "0";
                            if (Object.keys(claimedPools).length != 0) {
                                const keys = Object.keys(claimedPools);
                                const firstKey = keys[0];
                                lifetimeClaimedPool = claimedPools[firstKey].value;
                            }
                            /*const lifetimeClaimedPool = (await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress))[0]
                                .claimedUBA;*/
                            const lifetimeClaimedPoolFormatted = formatBNToDisplayDecimals(
                                toBN(lifetimeClaimedPool),
                                fasset.includes("XRP") ? 3 : 8,
                                Number(settings.assetDecimals)
                            );
                            const lifetimeClaimedPoolUSD = toBN(lifetimeClaimedPool)
                                .mul(priceAsset.price)
                                .div(toBNExp(1, Number(priceAsset.decimals)));
                            const lifetimeClaimedPoolUSDFormatted = formatFixed(lifetimeClaimedPoolUSD, Number(settings.assetDecimals), {
                                decimals: 3,
                                groupDigits: true,
                                groupSeparator: ",",
                            });
                            const agentPool = {
                                vault: agent.vaultAddress,
                                pool: agent.poolAddress,
                                totalPoolCollateral: agent.totalPoolCollateral,
                                poolCR: Number(agent.poolCR).toFixed(2),
                                vaultCR: Number(agent.vaultCR).toFixed(2),
                                //userPoolBalance: formatFixed(balance, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                userPoolBalance: formatBNToDisplayDecimals(balance, 3, 18),
                                //userPoolFees: formatFixed(fees, 6, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                userPoolFees: formatBNToDisplayDecimals(toBN(fees), fasset.includes("XRP") ? 3 : 8, Number(settings.assetDecimals)),
                                feeShare: (agent.feeShare * 100).toFixed(0),
                                userPoolNatBalance: formatFixed(toBN(userPoolNatBalance), 18, {
                                    decimals: 3,
                                    groupDigits: true,
                                    groupSeparator: ",",
                                }),
                                userPoolNatBalanceInUSD: formatFixed(toBN(userPoolNatBalanceUSD), Number(price.tokenPrice.decimals), {
                                    decimals: 6,
                                    groupDigits: true,
                                    groupSeparator: ",",
                                }),
                                agentName: agent.agentName,
                                vaultType: agent.vaultType,
                                poolExitCR: Number(agent.poolExitCR).toFixed(2),
                                status: status,
                                userPoolShare: percentage.toFixed(2),
                                health: agent.status,
                                freeLots: agent.freeLots,
                                mintCount: agent.mintNumber,
                                numLiquidations: agent.numLiquidations,
                                redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                                url: agent.url,
                                poolCollateralUSD: agent.poolNatUsd,
                                vaultCollateral: agent.vaultCollateral,
                                collateralToken: agent.vaultCollateralToken,
                                //transferableTokens: formatFixed(transferableTokens, 18, { decimals: 3, groupDigits: true, groupSeparator: "," }),
                                transferableTokens: formatBNToDisplayDecimals(transferableTokens, 3, 18),
                                poolTopupCR: Number(agent.poolTopupCR).toFixed(2),
                                tokenAddress: agent.tokenAddress,
                                //fassetDebt: formatFixed(fassetDebt, 6, { decimals: 6, groupDigits: true, groupSeparator: "," })
                                fassetDebt: formatBNToDisplayDecimals(fassetDebt, Number(settings.assetDecimals), Number(settings.assetDecimals)),
                                nonTimeLocked: formatBNToDisplayDecimals(nonTimeLocked, 3, 18),
                                mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                                mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                                vaultCCBCR: Number(vaultCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                                vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                                vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                poolCCBCR: Number(poolCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                                poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                                poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                                mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                                handshakeType: agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                                description: agent.description,
                                mintedAssets: agent.mintedUBA,
                                mintedUSD: agent.mintedUSD,
                                remainingAssets: agent.remainingUBA,
                                remainingUSD: agent.remainingUSD,
                                allLots: agent.allLots,
                                poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                                vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                                userPoolFeesUSD: feesUSDFormatted,
                                totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                                limitUSD: agent.limitUSD,
                                infoUrl: agent.infoUrl,
                                lifetimeClaimedPoolFormatted: lifetimeClaimedPoolFormatted,
                                lifetimeClaimedPoolUSDFormatted: lifetimeClaimedPoolUSDFormatted,
                            };
                            pools.push(agentPool);
                        } catch (error) {
                            logger.error(`Error in getPools for specific user:`, error);
                            continue;
                        }
                    }
                }
                const parseUserPoolBalance = (balance: string): number => {
                    return parseFloat(balance.replace(/,/g, ""));
                };
                pools.sort((a, b) => parseUserPoolBalance(b.userPoolBalance) - parseUserPoolBalance(a.userPoolBalance));

                const end = Date.now();
                return pools;
            } catch (error) {
                logger.error(`Error in getPools, attempt ${i + 1} of ${NUM_RETRIES}: `, error);
                if (i < NUM_RETRIES - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                } else {
                    logger.error("Error in getPools: ", error);
                }
            }
        }
    }

    async getPoolsSpecific(fasset: string, address: string, pool: string): Promise<AgentPoolItem> {
        try {
            const agents = await this.em.find(Pool, { poolAddress: pool });
            const pools = [];
            const now = Date.now();
            const bot = this.botService.getInfoBot(fasset);
            const nativeSymbol = bot.context.nativeChainInfo.tokenSymbol;
            for (const agent of agents) {
                try {
                    const pool = await CollateralPool.at(agent.poolAddress);
                    const poolToken = await CollateraPoolToken.at(agent.tokenAddress);
                    const balance = toBN(await poolToken.balanceOf(address)); // number of collateral pool tokens
                    const balanceFormated = formatBNToDisplayDecimals(balance, 3, 18);
                    const status = await this.getAgentLiveness(agent.vaultAddress, now);
                    const vaultCollaterals = await this.em.find(Collateral, {
                        fasset: fasset,
                        token: agent.vaultToken,
                    });
                    const poolCollaterals = await this.em.find(Collateral, {
                        fasset: fasset,
                        tokenFtsoSymbol: nativeSymbol,
                    });
                    const vaultCollateral = vaultCollaterals[0];
                    const poolCollateral = poolCollaterals[0];
                    if (balance.eq(BN_ZERO)) {
                        const agentPool = {
                            vault: agent.vaultAddress,
                            pool: agent.poolAddress,
                            totalPoolCollateral: agent.totalPoolCollateral,
                            poolCR: Number(agent.poolCR).toFixed(2),
                            vaultCR: Number(agent.vaultCR).toFixed(2),
                            userPoolBalance: "0",
                            userPoolFees: "0",
                            feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                            userPoolNatBalance: "0",
                            userPoolNatBalanceInUSD: "0",
                            agentName: agent.agentName,
                            vaultType: agent.vaultType,
                            poolExitCR: Number(agent.poolExitCR).toFixed(2),
                            status: status,
                            userPoolShare: "0",
                            health: agent.status,
                            freeLots: agent.freeLots,
                            mintCount: agent.mintNumber,
                            numLiquidations: agent.numLiquidations,
                            redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                            url: agent.url,
                            poolCollateralUSD: agent.poolNatUsd,
                            vaultCollateral: agent.vaultCollateral,
                            collateralToken: agent.vaultCollateralToken,
                            transferableTokens: "0",
                            poolTopupCR: Number(agent.poolTopupCR).toFixed(2),
                            tokenAddress: agent.tokenAddress,
                            fassetDebt: "0",
                            nonTimeLocked: "0",
                            mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                            mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                            vaultCCBCR: Number(vaultCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                            vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                            vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            poolCCBCR: Number(poolCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                            poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                            poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                            mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                            handshakeType: agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                            description: agent.description,
                            mintedAssets: agent.mintedUBA,
                            mintedUSD: agent.mintedUSD,
                            remainingAssets: agent.remainingUBA,
                            remainingUSD: agent.remainingUSD,
                            allLots: agent.allLots,
                            poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                            vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                            userPoolFeesUSD: "0",
                            totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                            limitUSD: agent.limitUSD,
                            infoUrl: agent.infoUrl,
                            lifetimeClaimedPoolFormatted: "0",
                            lifetimeClaimedPoolUSDFormatted: "0",
                        };
                        pools.push(agentPool);
                        continue;
                    }
                    const poolNatBalance = toBN(await pool.totalCollateral()); // collateral in pool (for example # of SGB in pool)
                    const totalSupply = toBN(await poolToken.totalSupply()); // all issued collateral pool tokens
                    //IF formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                    const userPoolNatBalance = balanceFormated.toString() == "0" ? "0" : toBN(balance).mul(poolNatBalance).div(totalSupply);
                    const bot = this.botService.getInfoBot(fasset);
                    const settings = await bot.context.assetManager.getSettings();
                    const priceReader = await TokenPriceReader.create(settings);
                    const priceAsset = await priceReader.getPrice(this.botService.getAssetSymbol(fasset), false, settings.maxTrustedPriceAgeSeconds);
                    const fees = balanceFormated.toString() == "0" ? "0" : await pool.fAssetFeesOf(address);
                    const feesUSD = toBN(fees)
                        .mul(priceAsset.price)
                        .div(toBNExp(1, Number(priceAsset.decimals)));
                    const feesUSDFormatted =
                        balanceFormated.toString() === "0"
                            ? "0"
                            : formatFixed(feesUSD, Number(settings.assetDecimals), {
                                  decimals: 3,
                                  groupDigits: true,
                                  groupSeparator: ",",
                              });
                    const transferableTokens = await poolToken.transferableBalanceOf(address);
                    const nonTimeLocked = await poolToken.nonTimelockedBalanceOf(address);
                    const fassetDebt = await pool.fAssetFeeDebtOf(address);
                    const totalSupplyNum = Number(totalSupply.div(toBNExp(1, 18)));
                    const balanceNum = Number(balance.div(toBNExp(1, 18)));
                    let percentage = (balanceNum / totalSupplyNum) * 100;
                    // calc userPoolNatBalance in USD
                    const price = await this.getPoolCollateralPrice(fasset, settings);
                    //IF formated balance of cpt is 0 (very low decimals) we treat pool balance (also in usd) as 0
                    const userPoolNatBalanceUSD =
                        balanceFormated.toString() == "0" ? "0" : toBN(userPoolNatBalance).mul(price.tokenPrice.price).div(toBNExp(1, 18)); //still needs to be trimmed for price.tokenPrice.decimals in formatFixed

                    if (percentage < 0.01) {
                        percentage = 0.01;
                    }
                    const claimedPools = await this.externalApiService.getUserTotalClaimedPoolFeesSpecific(address, agent.poolAddress);
                    let lifetimeClaimedPool = "0";
                    if (Object.keys(claimedPools).length != 0) {
                        const keys = Object.keys(claimedPools);
                        const firstKey = keys[0];
                        lifetimeClaimedPool = claimedPools[firstKey].value;
                    }
                    const lifetimeClaimedPoolFormatted = formatBNToDisplayDecimals(
                        toBN(lifetimeClaimedPool),
                        fasset.includes("XRP") ? 3 : 8,
                        Number(settings.assetDecimals)
                    );
                    const lifetimeClaimedPoolUSD = toBN(lifetimeClaimedPool)
                        .mul(priceAsset.price)
                        .div(toBNExp(1, Number(priceAsset.decimals)));
                    const lifetimeClaimedPoolUSDFormatted = formatFixed(lifetimeClaimedPoolUSD, Number(settings.assetDecimals), {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    });
                    const agentPool = {
                        vault: agent.vaultAddress,
                        pool: agent.poolAddress,
                        totalPoolCollateral: agent.totalPoolCollateral,
                        poolCR: Number(agent.poolCR).toFixed(2),
                        vaultCR: Number(agent.vaultCR).toFixed(2),
                        userPoolBalance: formatBNToDisplayDecimals(balance, 3, 18),
                        userPoolFees: formatBNToDisplayDecimals(toBN(fees), fasset.includes("XRP") ? 3 : 8, Number(settings.assetDecimals)),
                        feeShare: (Number(agent.feeShare) * 100).toFixed(0),
                        userPoolNatBalance: formatFixed(toBN(userPoolNatBalance), 18, {
                            decimals: 3,
                            groupDigits: true,
                            groupSeparator: ",",
                        }),
                        userPoolNatBalanceInUSD: formatFixed(toBN(userPoolNatBalanceUSD), Number(price.tokenPrice.decimals), {
                            decimals: 6,
                            groupDigits: true,
                            groupSeparator: ",",
                        }),
                        agentName: agent.agentName,
                        vaultType: agent.vaultType,
                        poolExitCR: Number(agent.poolExitCR).toFixed(2),
                        status: status,
                        userPoolShare: percentage.toFixed(2),
                        health: agent.status,
                        freeLots: agent.freeLots,
                        mintCount: agent.mintNumber,
                        numLiquidations: agent.numLiquidations,
                        redeemRate: (Number(agent.redeemSuccessRate) * 100).toFixed(2),
                        url: agent.url,
                        poolCollateralUSD: agent.poolNatUsd,
                        vaultCollateral: agent.vaultCollateral,
                        collateralToken: agent.vaultCollateralToken,
                        transferableTokens: formatBNToDisplayDecimals(transferableTokens, 3, 18),
                        poolTopupCR: Number(agent.poolTopupCR).toFixed(2),
                        tokenAddress: agent.tokenAddress,
                        fassetDebt: formatBNToDisplayDecimals(fassetDebt, Number(settings.assetDecimals), Number(settings.assetDecimals)),
                        nonTimeLocked: formatBNToDisplayDecimals(nonTimeLocked, 3, 18),
                        mintingPoolCR: Number(agent.mintingPoolCR).toFixed(2),
                        mintingVaultCR: Number(agent.mintingVaultCR).toFixed(2),
                        vaultCCBCR: Number(vaultCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                        vaultMinCR: Number(vaultCollateral.minCollateralRatioBIPS).toFixed(2),
                        vaultSafetyCR: Number(vaultCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                        poolCCBCR: Number(poolCollateral.ccbMinCollateralRatioBIPS).toFixed(2),
                        poolMinCR: Number(poolCollateral.minCollateralRatioBIPS).toFixed(2),
                        poolSafetyCR: Number(poolCollateral.safetyMinCollateralRatioBIPS).toFixed(2),
                        mintFee: (Number(agent.mintFee) * 100).toFixed(2),
                        handshakeType: agent.handshakeType == null ? 0 : Number(agent.handshakeType),
                        description: agent.description,
                        mintedAssets: agent.mintedUBA,
                        mintedUSD: agent.mintedUSD,
                        remainingAssets: agent.remainingUBA,
                        remainingUSD: agent.remainingUSD,
                        allLots: agent.allLots,
                        poolOnlyCollateralUSD: agent.poolOnlyCollateralUSD,
                        vaultOnlyCollateralUSD: agent.vaultOnlyCollateralUSD,
                        userPoolFeesUSD: feesUSDFormatted,
                        totalPortfolioValueUSD: agent.totalPortfolioValueUSD,
                        limitUSD: agent.limitUSD,
                        infoUrl: agent.infoUrl,
                        lifetimeClaimedPoolFormatted: lifetimeClaimedPoolFormatted,
                        lifetimeClaimedPoolUSDFormatted: lifetimeClaimedPoolUSDFormatted,
                    };
                    pools.push(agentPool);
                } catch (error) {
                    logger.error(`Error in getPoolsSpecific for specific user:`, error);
                    continue;
                }
            }
            return pools[0];
        } catch (error) {
            throw error;
        }
    }

    async getMaxWithdraw(fasset: string, poolAddress: string, userAddress: string, value: number): Promise<MaxWithdraw> {
        try {
            const bot = this.botService.getInfoBot(fasset);
            const settings = await bot.context.assetManager.getSettings();
            const agent = await this.em.findOne(Pool, { poolAddress: poolAddress });
            const valueWei = toBNExp(value, 18);
            const pool = await CollateralPool.at(poolAddress);
            const poolToken = await IERC20.at(agent.tokenAddress);
            const poolNatBalance = await pool.totalCollateral();
            const fees = await pool.fAssetFeesOf(userAddress);
            const totalSupply = toBN(await poolToken.totalSupply());

            const userPoolNatReturn = toBN(valueWei).mul(poolNatBalance).div(totalSupply);
            const assetData = await bot.context.assetManager.assetPriceNatWei();
            const assetPriceMul = assetData[0];
            const assetPriceDiv = assetData[1];
            const exitCRBIPS = await pool.exitCollateralRatioBIPS();
            const agentBackedFassets = await bot.context.assetManager.getFAssetsBackedByPool(agent.vaultAddress);
            const a = poolNatBalance.sub(userPoolNatReturn).mul(toBN(assetPriceDiv));
            const b = agentBackedFassets.mul(assetPriceMul).mul(exitCRBIPS.div(toBN(MAX_BIPS)));

            /*//poolNatBalance.sub(userPoolNatReturn) >=
      const c = poolNatBalance.sub(agentBackedFassets.mul(assetPriceMul).mul(exitCRBIPS.div(toBN(MAX_BIPS))).div(toBN(assetPriceDiv)));
      const cpts = c.mul(totalSupply).div(poolNatBalance);
      console.log(formatFixed(c, 18, { decimals: 3, groupDigits: true, groupSeparator: ","  }));
      console.log(formatFixed(cpts, 18, { decimals: 3, groupDigits: true, groupSeparator: ","  }));*/
            if (a.gte(b)) {
                return {
                    natReturn: formatFixed(userPoolNatReturn, 18, {
                        decimals: 3,
                        groupDigits: true,
                        groupSeparator: ",",
                    }),
                    fees: formatBNToDisplayDecimals(toBN(fees), fasset.includes("XRP") ? 3 : 8, Number(settings.assetDecimals)),
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
            const bot = this.botService.getInfoBot(fasset);
            const agent = await this.em.findOne(Pool, { poolAddress: poolAddress });
            const pool = await CollateralPool.at(poolAddress);
            const poolToken = await IERC20.at(agent.tokenAddress);
            const poolNatBalance = await pool.totalCollateral();
            const totalSupply = toBN(await poolToken.totalSupply());
            const assetData = await bot.context.assetManager.assetPriceNatWei();
            const assetPriceMul = assetData[0];
            const assetPriceDiv = assetData[1];
            const exitCRBIPS = await pool.exitCollateralRatioBIPS();
            const agentBackedFassets = await bot.context.assetManager.getFAssetsBackedByPool(agent.vaultAddress);
            const maxNatWith = poolNatBalance.sub(
                agentBackedFassets
                    .mul(assetPriceMul)
                    .mul(exitCRBIPS.div(toBN(MAX_BIPS)))
                    .div(toBN(assetPriceDiv))
            );
            const maxCptWith = maxNatWith.mul(totalSupply).div(poolNatBalance);
            return { maxWithdraw: formatBNToDisplayDecimals(maxCptWith, 3, 18) };
        } catch (error) {
            logger.error(`Error in getMaxCPTWithdraw:`, error);
            throw error;
        }
    }

    async getPoolBalances(address: string): Promise<CommonBalance> {
        const agents = await this.em.find(Pool, {});
        let userNatPosition = BN_ZERO;
        const cptokenBalances = await this.getTokenBalanceFromIndexer(address);
        //const contractInfoMap = new Map<string, IndexerTokenBalances>(cptokenBalances.map((info) => [info.token, info]));
        //const allTokens = await this.getTokenBalanceFromExplorer(address);
        //const filteredTokens = allTokens.filter((token) => token.name.startsWith("FAsset Collateral Pool Token"));
        //const contractInfoMap = new Map<string, CostonExpTokenBalance>(filteredTokens.map((info) => [info.contractAddress.toLowerCase(), info]));
        for (const agent of agents) {
            try {
                const info = cptokenBalances[agent.tokenAddress];
                //const info = contractInfoMap.get(agent.tokenAddress.toLowerCase());
                if (!info) {
                    continue;
                }

                const pool = await CollateralPool.at(agent.poolAddress);
                const poolToken = await IERC20.at(agent.tokenAddress);

                const balance = toBN(await poolToken.balanceOf(address));
                if (balance.eqn(0)) {
                    continue;
                }
                const poolNatBalance = toBN(await pool.totalCollateral());
                const totalSupply = toBN(await poolToken.totalSupply());
                const userPoolNatBalance = toBN(balance).mul(poolNatBalance).div(totalSupply);
                userNatPosition = userNatPosition.add(userPoolNatBalance);
            } catch (error) {
                logger.error(`Error in getPoolBalances:`, error);
                continue;
            }
        }
        return {
            balance: formatFixed(toBN(userNatPosition), 18, {
                decimals: 3,
                groupDigits: true,
                groupSeparator: ",",
            }),
        };
    }

    async getPoolCollateralPrice(fasset: string, settings: AssetManagerSettings): Promise<CollateralPrice> {
        const bot = this.botService.getInfoBot(fasset);
        const [priceReader, poolCollateral] = await Promise.all([
            TokenPriceReader.create(settings),
            bot.context.assetManager.getCollateralType(CollateralClass.POOL, await bot.context.assetManager.getWNat()),
        ]);
        return await CollateralPrice.forCollateral(priceReader, settings, poolCollateral);
    }

    async getVaultCollateralPrice(fasset: string, settings: AssetManagerSettings, vaultCollateralToken: string): Promise<CollateralPrice> {
        const bot = this.botService.getInfoBot(fasset);
        const [priceReader, vaultCollateral] = await Promise.all([
            TokenPriceReader.create(settings),
            bot.context.assetManager.getCollateralType(CollateralClass.VAULT, vaultCollateralToken),
        ]);
        return await CollateralPrice.forCollateral(priceReader, settings, vaultCollateral);
    }

    listAvailableFassets(): AvailableFassets {
        return { fassets: this.botService.fassetList };
    }

    async getAndSaveRedemptionDefaultEvent(ticket: Redemption, timestamp: number): Promise<RedemptionDefault> {
        try {
            const defaultEventDB = await this.em.findOne(RedemptionDefaultEvent, {
                requestId: ticket.requestId,
            });
            if (defaultEventDB) {
                const agent = await this.em.find(Pool, {
                    vaultAddress: defaultEventDB.agentVault,
                });
                const value = formatBNToDisplayDecimals(toBN(ticket.amountUBA), ticket.fasset.includes("XRP") ? 2 : 8, ticket.fasset.includes("XRP") ? 6 : 8);
                const defEvent = new RedemptionDefault(
                    ticket.txhash,
                    defaultEventDB.agentVault,
                    defaultEventDB.redeemer,
                    value,
                    toBN(defaultEventDB.redeemedVaultCollateralWei).toString(),
                    toBN(defaultEventDB.redeemedPoolCollateralWei).toString(),
                    ticket.requestId,
                    ticket.fasset,
                    agent[0].vaultCollateralToken,
                    timestamp
                );
                await this.em.persistAndFlush(defEvent);
                return defEvent;
            } else {
                const indexerEvent = await this.externalApiService.getDefaultEvent(ticket.fasset, ticket.requestId);
                const agent = await this.em.find(Pool, {
                    vaultAddress: indexerEvent.data.redemptionRequested.agentVault.address.hex,
                });
                const value = formatBNToDisplayDecimals(toBN(ticket.amountUBA), ticket.fasset.includes("XRP") ? 2 : 8, ticket.fasset.includes("XRP") ? 6 : 8);
                const defEvent = new RedemptionDefault(
                    ticket.txhash,
                    indexerEvent.data.redemptionRequested.agentVault.address.hex,
                    indexerEvent.data.redemptionRequested.redeemer.hex,
                    value,
                    toBN(indexerEvent.data.redeemedVaultCollateralWei).toString(),
                    toBN(indexerEvent.data.redeemedPoolCollateralWei).toString(),
                    ticket.requestId,
                    ticket.fasset,
                    agent[0].vaultCollateralToken,
                    timestamp
                );
                await this.em.persistAndFlush(defEvent);
                return defEvent;
            }
        } catch (error) {
            logger.error(`Error in processRedemptions (proof):`, error);
            throw error;
        }
    }

    async getProgress(userAddress: string): Promise<Progress[]> {
        const mints = await this.em.find(Minting, { userAddress: userAddress });
        const redeems = await this.em.find(FullRedemption, {
            userAddress: userAddress.toLocaleLowerCase(),
        });
        const incompleteRedeems = await this.em.find(IncompleteRedemption, {
            redeemer: userAddress,
        });
        //const redeemTickets = await this.em.find(Redemption, { userAddress: userAddress.toLocaleLowerCase() })
        const userProgress: Progress[] = [];
        const now = new Date();
        const date = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).getTime();
        const nowTimestamp = now.getTime();
        for (const mint of mints) {
            if (Number(mint.timestamp) < date) {
                continue;
            }
            const progress = {
                action: "MINT",
                timestamp: Number(mint.timestamp),
                amount: mint.amount,
                fasset: mint.fasset,
                status: mint.processed,
                txhash: mint.txhash,
                defaulted: false,
            };
            userProgress.push(progress);
        }
        for (const redeem of redeems) {
            if (Number(redeem.timestamp) < date) {
                continue;
            }
            // All tickets need to be processed for a redemption to have status true to be regarded as completed
            const redeemTickets = await this.em.find(Redemption, {
                txhash: redeem.txhash,
            });
            //Check if redemption was incomplete
            const incompleteData = incompleteRedeems.find((red) => red.txhash === redeem.txhash);
            let incomplete = false;
            if (incompleteData) {
                incomplete = true;
            }
            //Preparation for each default ticket
            for (const ticket of redeemTickets) {
                if (ticket.defaulted == true && ticket.processed == true) {
                    const defaultEvent = await this.em.find(RedemptionDefault, {
                        requestId: ticket.requestId,
                    });
                    let redDefEvent: RedemptionDefault;
                    if (defaultEvent.length == 0) {
                        try {
                            redDefEvent = await this.getAndSaveRedemptionDefaultEvent(ticket, nowTimestamp);
                        } catch (error) {
                            logger.error("Error in progress: ", error);
                            continue;
                        }
                    } else {
                        redDefEvent = defaultEvent[0];
                    }
                    //const amount = formatBNToDisplayDecimals(toBN(ticket.amountUBA), redeem.fasset == "FTestXRP" ? 2 : 8, redeem.fasset == "FTestXRP" ? 6 : 8);
                    const collateral = await this.em.find(Collateral, {
                        tokenFtsoSymbol: redDefEvent.collateralToken,
                    });
                    const vaultCollateralRedeemed = formatBNToDisplayDecimals(
                        toBN(redDefEvent.redeemedVaultCollateralWei),
                        redDefEvent.collateralToken.includes("ETH") ? 6 : 3,
                        collateral[0].decimals
                    );
                    const poolCollateralRedeemed = formatBNToDisplayDecimals(toBN(redDefEvent.redeemedPoolCollateralWei), 3, 18);
                    const progress = {
                        action: "REDEEM",
                        timestamp: Number(redeem.timestamp),
                        amount: redeem.amount,
                        fasset: redeem.fasset,
                        status: ticket.processed,
                        defaulted: ticket.defaulted,
                        txhash: redeem.txhash,
                        ticketID: ticket.requestId,
                        vaultToken: redDefEvent.collateralToken,
                        vaultTokenValueRedeemed: vaultCollateralRedeemed,
                        poolTokenValueRedeemed: poolCollateralRedeemed,
                        underlyingPaid: "0",
                        incomplete: incomplete,
                        remainingLots: incompleteData?.remainingLots ?? null,
                        rejected: ticket.rejected,
                        takenOver: ticket.takenOver,
                        rejectionDefaulted: ticket.rejectionDefault,
                    };
                    userProgress.push(progress);
                } else {
                    const amount = formatBNToDisplayDecimals(
                        toBN(ticket.amountUBA),
                        redeem.fasset.includes("XRP") ? 2 : 8,
                        redeem.fasset.includes("XRP") ? 6 : 8
                    );

                    const progress = {
                        action: "REDEEM",
                        timestamp: Number(redeem.timestamp),
                        amount: redeem.amount,
                        fasset: redeem.fasset,
                        status: ticket.processed,
                        defaulted: ticket.defaulted,
                        txhash: redeem.txhash,
                        ticketID: ticket.requestId,
                        underlyingPaid: amount,
                        incomplete: incomplete,
                        remainingLots: incompleteData?.remainingLots ?? null,
                        rejected: ticket.rejected,
                        takenOver: ticket.takenOver,
                        rejectionDefaulted: ticket.rejectionDefault,
                    };
                    userProgress.push(progress);
                }
            }
        }
        userProgress.sort((a, b) => b.timestamp - a.timestamp);
        return userProgress;
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
            const pool = await CollateralPool.at(agent.poolAddress);
            const fees = toBN(await pool.fAssetFeesOf(address));
            if (!cl) {
                claimedP.push({ fasset: agent.fasset, claimed: fees.toString() });
            } else {
                cl.claimed = toBN(cl.claimed).add(fees).toString();
            }
        }
        //TODO fix for real or testnet
        for (const fasset of fassets) {
            const netw = NETWORK_SYMBOLS.find((item) => (this.envType == "dev" ? item.test : item.real) === fasset);
            const claim = claimed[netw.real];
            if (!claim) {
                claimedUSD.push({ fasset: fasset, claimed: "0" });
                continue;
            }
            const cl = claimedP.find((c) => c.fasset === fasset);
            if (cl) {
                claim.value = toBN(claim.value).add(toBN(cl.claimed)).toString();
            }
            const bot = this.botService.getInfoBot(fasset);
            const settings = await bot.context.assetManager.getSettings();
            const priceReader = await TokenPriceReader.create(settings);
            const price = await priceReader.getPrice(this.botService.getAssetSymbol(fasset), false, settings.maxTrustedPriceAgeSeconds);
            const priceMul = price.price.mul(toBNExp(1, 18));
            const value = toBN(claim.value)
                .mul(priceMul)
                .div(toBNExp(1, 18 + Number(settings.assetDecimals)));
            claimedUSD.push({
                fasset: fasset,
                claimed: formatFixed(value, price.decimals.toNumber(), {
                    decimals: 3,
                    groupDigits: true,
                    groupSeparator: ",",
                }),
            });
        }
        return claimedUSD;
    }

    async getTimeData(time: string): Promise<TimeData> {
        return this.botService.getTimeSeries(time);
    }

    async prepareUtxosForAmount(
        fasset: string,
        amount: string,
        recipient: string,
        memo: string,
        fee: string,
        changeAddresses: string[],
        selectedUtxos: SelectedUTXOAddress[]
    ): Promise<any> {
        const amountBN = toBN(Math.floor(Number(amount))).add(toBN(fee));
        let totalSelectedAmount = toBN(0);
        for (const u of selectedUtxos) {
            totalSelectedAmount = totalSelectedAmount.add(toBN(u.value));
        }

        if (totalSelectedAmount.lt(amountBN)) {
            throw new Error("Insufficient funds to cover the amount with a minimum of 10k satoshis for change.");
        }
        const psbt = await this.createPsbt(fasset, selectedUtxos, toBN(amount), changeAddresses, recipient, totalSelectedAmount, memo, fee);
        return { psbt, selectedUtxos };
    }
    private async createSelectedUtxo(fasset: string, utxo: any, address: string, index: number): Promise<SelectedUTXOAddress> {
        return {
            txid: utxo.txid,
            vout: utxo.vout,
            value: utxo.value,
            hexTx: await this.externalApiService.getTransactionHexBlockBook(fasset, utxo.txid),
            path: utxo.path,
            utxoAddress: address,
            address: address,
            index: index,
        };
    }

    private async createPsbt(
        fasset: string,
        selectedUtxos: SelectedUTXOAddress[],
        amountBN: BN,
        changeAddresses: string[],
        recipient: string,
        totalSelectedAmount: BN,
        memo: string,
        fee: string
    ): Promise<any> {
        if (fasset.includes("BTC")) {
            const bitcoin = await import("bitcoinjs-lib");
            const network = this.envType == "dev" ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

            const psbt = new bitcoin.Psbt({ network });

            for (let i = 0; i < selectedUtxos.length; i++) {
                const utxo = selectedUtxos[i];
                const isSegWit = utxo.address.startsWith("bc1") || utxo.address.startsWith("tb1");
                if (isSegWit) {
                    psbt.addInput({
                        hash: utxo.txid,
                        index: utxo.vout,
                        witnessUtxo: {
                            value: BigInt(utxo.value),
                            script: bitcoin.address.toOutputScript(utxo.utxoAddress, network),
                        },
                        sequence: MAX_SEQUENCE - 1,
                    });
                } else {
                    psbt.addInput({
                        hash: utxo.txid,
                        index: utxo.vout,
                        nonWitnessUtxo: Buffer.from(utxo.hexTx, "hex"),
                        sequence: MAX_SEQUENCE - 1,
                    });
                }
            }

            psbt.addOutput({
                address: recipient,
                value: BigInt(amountBN.toString()),
            });

            const embedMemo = bitcoin.payments.embed({
                data: [Buffer.from(memo, "hex")],
                network: network,
            });
            psbt.addOutput({
                script: embedMemo.output!,
                value: BigInt(0),
            });
            const changeAmount = totalSelectedAmount.sub(amountBN).sub(toBN(fee));
            let changeAddress = changeAddresses[0];
            for (const a of changeAddresses) {
                const mainAddressBalancesUTXO = await this.externalApiService.getAddressInfoBlockBook(fasset, a);
                const utxoBalance = toBN(mainAddressBalancesUTXO.balance);
                if (utxoBalance.eqn(0)) {
                    changeAddress = a;
                }
            }
            if (changeAmount.gte(REMAIN_SATOSHIS)) {
                psbt.addOutput({
                    address: changeAddress,
                    value: BigInt(changeAmount.toString()),
                });
            }
            return psbt.toBase64();
        }
        if (fasset.includes("DOGE")) {
            const bitcoin = await import("bitcoinjs-lib");
            const getNetwork = (isTestnet: boolean) => ({
                messagePrefix: "\x19Dogecoin Signed Message:\n",
                bech32: "doge",
                bip32: isTestnet ? { public: 0x043587cf, private: 0x04358394 } : { public: 0x02facafd, private: 0x02fac398 },
                pubKeyHash: isTestnet ? 0x71 : 0x1e,
                scriptHash: isTestnet ? 0xc4 : 0x16,
                wif: isTestnet ? 0xf1 : 0x9e,
            });
            const network = getNetwork(this.envType == "dev");
            const psbt = new bitcoin.Psbt({ network });
            for (let i = 0; i < selectedUtxos.length; i++) {
                const utxo = selectedUtxos[i];
                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    nonWitnessUtxo: Buffer.from(utxo.hexTx, "hex"),
                    sequence: MAX_SEQUENCE - 1,
                });
            }

            psbt.addOutput({
                address: recipient,
                value: BigInt(amountBN.toString()),
            });

            if (memo) {
                const embedMemo = bitcoin.payments.embed({
                    data: [Buffer.from(memo, "hex")],
                });
                psbt.addOutput({
                    script: embedMemo.output!,
                    value: BigInt(0),
                });
            }

            const changeAmount = totalSelectedAmount.sub(amountBN).sub(toBN(fee));
            if (changeAmount.gte(REMAIN_SATOSHIS)) {
                const changeAddress = changeAddresses[0];
                psbt.addOutput({
                    address: changeAddress,
                    value: BigInt(changeAmount.toString()),
                });
            }

            return psbt.toBase64();
        }
    }

    async returnUtxosForAmount(fasset: string, amount: string, address: string, receiveAddresses: string[], changeAddresses: string[]): Promise<any> {
        let amountBN = toBN(Math.floor(Number(amount)));
        const selectedUtxos: string[] = [];
        const utxosAddresses: SelectedUTXOAddress[] = [];
        let totalSelectedAmount = toBN(0);
        const fee = await this.estimateFeeForBlocks(fasset);
        const feeBTC = Math.floor(Number(fee.extraBTC) * 10 ** 8);
        amountBN = amountBN.add(toBN(feeBTC));
        let ind = 0;
        const processUtxos = async (addresses: string[]): Promise<void> => {
            for (const addr of addresses) {
                if (totalSelectedAmount.gte(amountBN.add(REMAIN_SATOSHIS))) {
                    return;
                }

                const utxos = await this.externalApiService.getUtxosBlockBook(fasset, addr, false);
                const sortedUtxos = utxos.sort((a, b) => toBN(b.value).sub(toBN(a.value)).toNumber());

                if (sortedUtxos.length > 0) {
                    const largestUtxo = sortedUtxos[0];
                    totalSelectedAmount = totalSelectedAmount.add(toBN(largestUtxo.value));
                    utxosAddresses.push(await this.createSelectedUtxo(fasset, largestUtxo, addr, ind));
                    ind++;
                    if (!selectedUtxos.includes(addr)) {
                        selectedUtxos.push(addr);
                    }
                }

                const randomUtxos = this.shuffleArray(sortedUtxos.slice(1));
                for (const utxo of randomUtxos) {
                    if (totalSelectedAmount.gte(amountBN.add(REMAIN_SATOSHIS))) {
                        break;
                    }
                    totalSelectedAmount = totalSelectedAmount.add(toBN(utxo.value));
                    utxosAddresses.push(await this.createSelectedUtxo(fasset, utxo, addr, ind));
                    ind++;
                    if (!selectedUtxos.includes(addr)) {
                        selectedUtxos.push(addr);
                    }
                }
            }
        };

        await processUtxos([address]);
        await processUtxos(changeAddresses);
        await processUtxos(receiveAddresses);

        if (totalSelectedAmount.lt(amountBN)) {
            throw new LotsException("Insufficient funds to cover the amount and fees.");
        }
        selectedUtxos.sort((a, b) => {
            const hashA = this.doubleKeccak256(a);
            const hashB = this.doubleKeccak256(b);
            return hashA.localeCompare(hashB);
        });
        utxosAddresses.sort((a, b) => {
            const hashA = this.doubleKeccak256(a.address);
            const hashB = this.doubleKeccak256(b.address);
            return hashA.localeCompare(hashB);
        });
        for (let i = 0; i < utxosAddresses.length; i++) {
            utxosAddresses[i].index = i;
        }
        return { addresses: selectedUtxos, estimatedFee: feeBTC, utxos: utxosAddresses };
    }

    private doubleKeccak256(address: string): string {
        const firstHash = web3.utils.keccak256(address);
        return web3.utils.keccak256(firstHash);
    }

    async getRedemptionFeeData(): Promise<RedemptionFeeData[]> {
        const redemptionFeeData: RedemptionFeeData[] = [];
        for (const f of this.botService.fassetList) {
            const bot = this.botService.getInfoBot(f);
            const settings = await bot.context.assetManager.getSettings();
            const redemptionFee = Number(settings.redemptionFeeBIPS.toString()) / 100;
            const lotSize = await this.getLotSize(f);
            const fassetFee = (redemptionFee / 100) * lotSize.lotSize;
            const priceReader = await TokenPriceReader.create(settings);
            const price = await priceReader.getPrice(this.botService.getAssetSymbol(f), false, settings.maxTrustedPriceAgeSeconds);
            const priceMul = price.price.toNumber() / 10 ** price.decimals.toNumber();
            const valueUSD = fassetFee * priceMul;
            redemptionFeeData.push({ fasset: f, feePercentage: redemptionFee.toString(), feeUSD: valueUSD.toFixed(3) });
        }
        return redemptionFeeData;
    }

    async getAssetPrice(fasset: string): Promise<AssetPrice> {
        const bot = this.botService.getInfoBot(fasset);
        const settings = await bot.context.assetManager.getSettings();
        const priceReader = await TokenPriceReader.create(settings);
        const price = await priceReader.getPrice(this.botService.getAssetSymbol(fasset), false, settings.maxTrustedPriceAgeSeconds);
        const priceMul = price.price.toNumber() / 10 ** price.decimals.toNumber();
        return { price: priceMul };
    }
}
