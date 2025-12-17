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
    ExecutorResponse,
    FassetStatus,
    FeeEstimate,
    IndexerTokenBalances,
    LotSize,
    MaxCPTWithdraw,
    MaxLots,
    MaxWithdraw,
    MintingStatus,
    NativeBalanceItem,
    ProtocolFees,
    RedemptionDefaultStatusGrouped,
    RedemptionFee,
    RedemptionFeeData,
    RedemptionQueue,
    RedemptionStatus,
    RequestMint,
    RequestRedemption,
    submitTxResponse,
    VaultCollateralRedemption,
} from "../interfaces/requestResponse";
import { AssetManagerSettings, ChainId, CollateralClass, TokenPriceReader, UserBotCommands } from "@flarelabs/fasset-bots-core";
import { BN_ZERO, MAX_BIPS, artifacts, formatFixed, latestBlockTimestamp, requireNotNull, sumBN, toBN, toBNExp, web3 } from "@flarelabs/fasset-bots-core/utils";
import { BotService } from "./bot.init.service";
import { EntityManager } from "@mikro-orm/core";
import { Minting } from "../entities/Minting";
import { Redemption } from "../entities/Redemption";
import { LotsException } from "../exceptions/lots.exception";
import { error } from "console";
import { Pool } from "../entities/Pool";
import { CollateralPrice } from "@flarelabs/fasset-bots-core";
import {
    calculateExpirationMinutes,
    calculateUSDValue,
    dateStringToTimestamp,
    formatBNToDisplayDecimals,
    isValidWalletAddress,
    sleep,
    timestampToDateString,
} from "src/utils/utils";
import { EXECUTION_FEE, NETWORK_SYMBOLS, RedemptionStatusEnum } from "src/utils/constants";
import {
    ClaimedPools,
    EcosystemData,
    FullRedeemData,
    RedeemData,
    RedemptionData,
    RedemptionIncomplete,
    TimeData,
    TransactionBTC,
    UTXOBTC,
} from "src/interfaces/structure";
import BN from "bn.js";
import { logger } from "src/logger/winston.logger";
import { FullRedemption } from "src/entities/RedemptionWhole";
import { Collateral } from "src/entities/Collaterals";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { ExternalApiService } from "./external.api.service";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { ConfigService } from "@nestjs/config";
import { lastValueFrom } from "rxjs";
import { HttpService } from "@nestjs/axios";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { XRPLApiService } from "./xrpl-api.service";
import { ChainType, Wallet } from "src/entities/Wallet";

const IERC20 = artifacts.require("IERC20Metadata");
const CollateralPool = artifacts.require("CollateralPool");
const NUM_RETRIES = 3;

const sigCollateralReserved = web3.utils.keccak256(
    "CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)"
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
        private readonly xrplService: XRPLApiService
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
        const settings = await bot.context.assetManager.getSettings();
        const lotSize = Number(settings.lotSizeAMG) * Number(settings.assetMintingGranularityUBA);
        const formatted = lotSize / 10 ** Number(settings.assetDecimals);
        return { lotSize: formatted };
    }

    async checkStateFassets(): Promise<any> {
        const stateF = [];
        for (const f of this.botService.fassetList) {
            const bot = this.botService.getInfoBot(f);
            const state = await bot.context.assetManager.emergencyPaused();
            stateF.push({ fasset: f, state: state });
        }
        return stateF;
    }

    //TODO: add trailing fee return
    //Trailing fee: transferAmount * transferFeeMillionths / 10^6 = transferFee, no fee on mint/redeem
    async getRedemptionFee(fasset: string): Promise<RedemptionFee> {
        const bot = this.botService.getInfoBot(fasset);
        const settings = await bot.context.assetManager.getSettings();
        if (fasset.includes("XRP")) {
            const redQueue = await this.getRedemptionQueue(fasset);
            return {
                redemptionFee: settings.redemptionFeeBIPS.toString(),
                maxLotsOneRedemption: redQueue.maxLotsOneRedemption,
                maxRedemptionLots: redQueue.maxLots,
            };
        }
        return { redemptionFee: settings.redemptionFeeBIPS.toString(), maxLotsOneRedemption: -1, maxRedemptionLots: -1 };
    }

    async getProtocolFees(fasset: string): Promise<ProtocolFees> {
        const bot = this.botService.getInfoBot(fasset);
        const settings = await bot.context.assetManager.getSettings();
        return { redemptionFee: settings.redemptionFeeBIPS.toString() };
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

    async mintingStatus(txhash: string): Promise<MintingStatus> {
        const minting = await this.em.findOne(Minting, { txhash: txhash });
        const relay = this.botService.getRelay();
        const now = Math.floor(Date.now() / 1000);
        const currentRound = Number(await relay.getVotingRoundId(now));
        if (!minting) {
            return { status: false, step: 0 };
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
        if (fullRedeemData.incomplete == true) {
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
        if (fasset.includes("XRP")) {
            return { estimatedFee: "1000", extraBTC: "0.0045" };
        }
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
                fasset.includes("BTC") ? 50 : 500
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
                fasset.includes("BTC") ? 25 : 500
            );
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
        /*if (this.envType == "dev") {
            changeAddresses = changeAddresses.filter((address) => !address.startsWith("bc1"));
            receiveAddresses = receiveAddresses.filter((address) => !address.startsWith("bc1"));
        }*/
        //const isBTC = fasset.includes("BTC") ? false : false;
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
                        const accountInfo = await this.xrplService.accountReceiveBlocked(underlyingAddress);
                        return {
                            balance: formatFixed(toBN(balance), bot.context.chainInfo.decimals, { decimals: 2, groupDigits: true, groupSeparator: "," }),
                            accountInfo: accountInfo,
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
        const nativeUSDFormatted = calculateUSDValue(toBN(nativeBalanceWrapped), priceUSD, 18 + Number(cflrPrice.decimals), 18, 3);
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
            const assetUSDFormatted = calculateUSDValue(
                toBN(toBN(fBalance).sub(toBN(fBalance).mul(toBN(redemptionFee)).divn(MAX_BIPS))),
                priceAsset.price,
                Number(priceAsset.decimals),
                Number(settingsAsset.assetDecimals),
                3
            );
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
            collaterals.push({ symbol: c == "USDT" ? "USDT0" : c, balance: formatBNToDisplayDecimals(toBN(balance), 3, decimals) });
        }
        return collaterals;
    }

    //TODO: add getting rejection/cancel event from DB first and if present return false before reading CREvent from DB
    async getCrStatus(crId: string): Promise<CRStatus | null> {
        const [crEvent] = await Promise.all([this.em.findOne(CollateralReservationEvent, { collateralReservationId: crId })]);
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
    async getCREventFromTxHash(fasset: string, txhash: string, local: boolean): Promise<CREvent | CREventExtended> {
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
            for (const log of receipt.logs) {
                try {
                    let inputs;
                    if (log.topics[0] === sigCollateralReserved) {
                        inputs = inputsCollateralReserved.inputs;
                    } else {
                        return;
                    }
                    const decodedLog = web3.eth.abi.decodeLog(inputs, log.data, log.topics.slice(1));
                    const paymentAmount = toBN(decodedLog.feeUBA).add(toBN(decodedLog.valueUBA));
                    if (!local) {
                        return {
                            collateralReservationId: decodedLog.collateralReservationId,
                            paymentAmount: paymentAmount.toString(),
                            paymentAddress: decodedLog.paymentAddress,
                            paymentReference: decodedLog.paymentReference,
                            lastUnderlyingBlock: decodedLog.lastUnderlyingBlock,
                            expirationMinutes: calculateExpirationMinutes(decodedLog.lastUnderlyingTimestamp),
                        } as CREvent;
                    } else {
                        return {
                            collateralReservationId: decodedLog.collateralReservationId,
                            paymentAmount: decodedLog.valueUBA,
                            paymentAddress: decodedLog.paymentAddress,
                            paymentReference: decodedLog.paymentReference,
                            lastUnderlyingBlock: decodedLog.lastUnderlyingBlock,
                            expirationMinutes: calculateExpirationMinutes(decodedLog.lastUnderlyingTimestamp),
                            from: receipt.from,
                        } as CREventExtended;
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
        let success = false;
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
            const status = await this.redemptionStatus(bot, redemption, await latestBlockTimestamp(), await bot.context.assetManager.getSettings());
            switch (status) {
                case RedemptionStatusEnum.PENDING:
                    return { status: status, incomplete: fullRedeemData.incomplete, incompleteData: fullRedeemData.dataIncomplete };
                case "SUCCESS":
                    success = true;
                    break;
                case RedemptionStatusEnum.DEFAULT:
                    return { status: RedemptionStatusEnum.DEFAULT, incomplete: fullRedeemData.incomplete, incompleteData: fullRedeemData.dataIncomplete };
                default:
                    break;
            }
        }
        return {
            status: success ? RedemptionStatusEnum.SUCCESS : RedemptionStatusEnum.PENDING,
            incomplete: fullRedeemData.incomplete,
            incompleteData: fullRedeemData.dataIncomplete,
        };
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
                decimals: 2,
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
            claimedUSD.push({
                fasset: fasset,
                claimed: calculateUSDValue(toBN(claim.value), priceMul, 18 + Number(settings.assetDecimals), price.decimals.toNumber(), 3),
            });
        }
        return claimedUSD;
    }

    async getTimeData(time: string): Promise<TimeData> {
        return this.botService.getTimeSeries(time);
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

    async getMintingEnabled(): Promise<FassetStatus[]> {
        const fassetStatus: FassetStatus[] = [];
        for (const f of this.botService.fassetList) {
            const bot = this.botService.getInfoBot(f);
            const pause = await bot.context.assetManager.emergencyPaused();
            fassetStatus.push({ fasset: f, status: !pause });
        }
        return fassetStatus;
    }

    async getRedemptionQueue(fasset: string): Promise<RedemptionQueue> {
        const maxLotsSingleRedeem = await this.cacheManager.get(fasset + "maxLotsSingleRedeem");
        const maxLotsTotalRedeem = await this.cacheManager.get(fasset + "maxLotsTotalRedeem");
        return { maxLots: Number(maxLotsTotalRedeem), maxLotsOneRedemption: Number(maxLotsSingleRedeem) };
    }
    async mintingUnderlyingTransactionExists(fasset: string, paymentReference: string): Promise<boolean> {
        const bot = this.botService.getUserBot(fasset);
        const txs = await bot.context.blockchainIndexer.getTransactionsByReference(paymentReference);
        const crData = await this.em.findOne(CollateralReservationEvent, {
            paymentReference: paymentReference,
        });
        if (!crData) {
            return true;
        }
        for (const tx of txs) {
            const amount = sumBN(
                tx.outputs.filter((o) => o[0] === crData.paymentAddress),
                (o) => o[1]
            );
            if (amount.gte(toBN(crData.valueUBA).add(toBN(crData.feeUBA)))) {
                return true;
            }
        }
        const underlyingBlockNumber = await bot.context.blockchainIndexer.getLastFinalizedBlockNumber();
        const lastUnderlyingBlock = await bot.context.blockchainIndexer.getBlockAt(underlyingBlockNumber);
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
    }
}
