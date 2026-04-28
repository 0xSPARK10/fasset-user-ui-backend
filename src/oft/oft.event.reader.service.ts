import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ethers, FetchRequest } from "ethers";
import {
    AM_REDEMPTION_REQUESTED_EVENT,
    AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT,
    EXECUTOR_FEE_WEI,
    FAssetRedeemComposerEvents,
    FAssetRedeemComposerABI,
    coston2OFTConfig,
    EndpointV2Events,
    flareOFTConfig,
    OFTAdapterEvents,
    OFTConfig,
    OFTLogs,
} from "./utils/constants";
import { logger } from "src/logger/winston.logger";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { IndexerState } from "src/entities/IndexerState";
import { OFTSent } from "src/entities/OFTSent";
import { OFTReceived } from "src/entities/OFTReceived";
import { OFTRedemption } from "src/entities/OFTRedemption";
import { OFTRedemptionFailed } from "src/entities/OFTRedemptionFailed";
import { ERC20__factory } from "src/typechain-ethers-v6";
import { NativeBalanceItemTokenAddress } from "src/interfaces/requestResponse";
import { formatBigIntToStringForceDecimals } from "src/utils/utils";

@Injectable()
export class OFTEventReaderService implements OnModuleInit {
    private provider: ethers.JsonRpcProvider;
    private network: string;
    private oftConfig: OFTConfig;
    private em: EntityManager;
    private envType: string;
    private fasset: string;
    private composerContract: ethers.Contract;
    // In-memory cache of ERC20 metadata (symbol + decimals) for each token
    // address returned by the composer's `getBalances()`. We only fetch metadata
    // once per token address and reuse it on subsequent calls. The symbol is
    // pre-normalized (e.g. `USDT` → `USDT0`) to match the rest of the API.
    private tokenMetadataCache: Map<string, { symbol: string; decimals: number }> = new Map();

    constructor(
        private readonly configService: ConfigService,
        private readonly orm: MikroORM
    ) {}

    async onModuleInit() {
        this.em = this.orm.em.fork();
        const rpcUrl = this.configService.get<string>("RPC_URL", "");
        const rpcKey = this.configService.get<string>("NATIVE_RPC", "");
        this.network = this.configService.get<string>("NETWORK", "coston2");
        const connection = new FetchRequest(rpcUrl);
        if (rpcKey !== undefined) {
            connection.setHeader("x-api-key", rpcKey);
            connection.setHeader("x-apikey", rpcKey);
        }
        this.provider = new ethers.JsonRpcProvider(connection);
        this.oftConfig = this.network == "coston2" ? coston2OFTConfig : flareOFTConfig;
        this.envType = this.configService.get<string>("APP_TYPE");
        this.fasset = this.envType == "dev" ? "FTestXRP" : "FXRP";
        this.composerContract = new ethers.Contract(this.oftConfig.FAssetRedeemComposerAddress, FAssetRedeemComposerABI, this.provider);
        void this.startReadingEvents();
    }

    async fetchEvents(fromBlock: number, toBlock: number): Promise<OFTLogs> {
        const oftSentFilter = {
            address: this.oftConfig.OFTAdapterAddress,
            topics: [OFTAdapterEvents.getEvent("OFTSent").topicHash],
        };

        const oftReceivedFilter = {
            address: this.oftConfig.OFTAdapterAddress,
            topics: [OFTAdapterEvents.getEvent("OFTReceived").topicHash],
        };

        const fAssetRedeemedFilter = {
            address: this.oftConfig.FAssetRedeemComposerAddress,
            topics: [FAssetRedeemComposerEvents.getEvent("FAssetRedeemed").topicHash],
        };
        const redemptionRequestedFilter = {
            address: this.oftConfig.AssetManagerAddress,
            topics: [AM_REDEMPTION_REQUESTED_EVENT.getEvent("RedemptionRequested").topicHash],
        };
        // The AssetManager emits `RedemptionWithTagRequested` (13 fields, trailing
        // `destinationTag`) instead of the plain `RedemptionRequested` event when
        // the redeemer asked for a destination tag. We need both streams to
        // correctly match composer redemptions to their AM request event.
        const redemptionWithTagRequestedFilter = {
            address: this.oftConfig.AssetManagerAddress,
            topics: [AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT.getEvent("RedemptionWithTagRequested").topicHash],
        };
        const packetSentFilter = {
            address: this.oftConfig.EndpointV2Address,
            topics: [EndpointV2Events.getEvent("PacketSent").topicHash],
        };
        const composeDeliveredFilter = {
            address: this.oftConfig.EndpointV2Address,
            topics: [EndpointV2Events.getEvent("ComposeDelivered").topicHash],
        };
        const fAssetRedeemFailedFilter = {
            address: this.oftConfig.FAssetRedeemComposerAddress,
            topics: [FAssetRedeemComposerEvents.getEvent("FAssetRedeemFailed").topicHash],
        };
        const [
            oftSentLogs,
            oftReceivedLogs,
            fAssetRedeemedLogs,
            redemptionRequestedLogs,
            redemptionWithTagRequestedLogs,
            packetSentLogs,
            composeDeliveredLogs,
            fAssetRedeemFailedLogs,
        ] = await Promise.all([
            this.provider.getLogs({ fromBlock: fromBlock, toBlock: toBlock, address: oftSentFilter.address, topics: oftSentFilter.topics }),
            this.provider.getLogs({ fromBlock: fromBlock, toBlock: toBlock, address: oftReceivedFilter.address, topics: oftReceivedFilter.topics }),
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: fAssetRedeemedFilter.address,
                topics: fAssetRedeemedFilter.topics,
            }),
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: redemptionRequestedFilter.address,
                topics: redemptionRequestedFilter.topics,
            }),
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: redemptionWithTagRequestedFilter.address,
                topics: redemptionWithTagRequestedFilter.topics,
            }),
            this.provider.getLogs({ fromBlock: fromBlock, toBlock: toBlock, address: packetSentFilter.address, topics: packetSentFilter.topics }),
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: composeDeliveredFilter.address,
                topics: composeDeliveredFilter.topics,
            }),
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: fAssetRedeemFailedFilter.address,
                topics: fAssetRedeemFailedFilter.topics,
            }),
        ]);
        return {
            oftSent: oftSentLogs,
            oftReceived: oftReceivedLogs,
            fAssetRedeemed: fAssetRedeemedLogs,
            redemptionRequested: redemptionRequestedLogs,
            redemptionWithTagRequested: redemptionWithTagRequestedLogs,
            packetSent: packetSentLogs,
            composeDelivered: composeDeliveredLogs,
            fAssetRedeemFailed: fAssetRedeemFailedLogs,
        };
    }

    async startReadingEvents(): Promise<void> {
        const blockReadOffset = 30;
        while (true) {
            try {
                const lastBlock = (await this.provider.getBlockNumber()) - 4;
                const lastBlockDB = await this.em.findOne(IndexerState, { name: "oftLastBlock" });
                let lastEventBlock: number;
                if (lastBlockDB) {
                    lastEventBlock = lastBlockDB.lastBlock;
                } else {
                    lastEventBlock = lastBlock;
                    const lbDB = new IndexerState("oftLastBlock", lastBlock);
                    await this.em.persistAndFlush(lbDB);
                }
                if (lastEventBlock >= lastBlock) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
                for (let lastBlockRead = lastEventBlock; lastBlockRead <= lastBlock; lastBlockRead += blockReadOffset) {
                    const logs = await this.fetchEvents(lastBlockRead, Math.min(lastBlockRead + blockReadOffset - 1, lastBlock));
                    await this.saveOFTSentEvents(logs);
                    await this.saveOFTReceivedEvents(logs.oftReceived);
                    await this.saveOFTRedemptions(logs);
                    await this.saveOFTRedemptionFailedEvents(logs.fAssetRedeemFailed);
                }
                if (!lastBlockDB) {
                    const lbDB = new IndexerState("oftLastBlock", lastBlock + 1);
                    await this.em.persistAndFlush(lbDB);
                } else {
                    lastBlockDB.lastBlock = lastBlock + 1;
                    await this.em.persistAndFlush(lastBlockDB);
                }
            } catch (error) {
                logger.error(`Error in oft event reader:`, error);
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    async saveOFTSentEvents(allLogs: OFTLogs): Promise<void> {
        const logs = allLogs.oftSent;
        const packetMap = new Map<string, ethers.Log>();
        allLogs.packetSent.forEach((p) => packetMap.set(p.transactionHash, p));
        const now = Date.now();
        for (const log of logs) {
            try {
                let isToHypercore = false;
                const packetSentLog = packetMap.get(log.transactionHash);
                if (!packetSentLog) {
                    const txReceipt = await log.getTransactionReceipt();
                    for (const l of txReceipt.logs) {
                        try {
                            if (l.topics[0] === EndpointV2Events.getEvent("PacketSent").topicHash) {
                                const parsed = EndpointV2Events.parseLog(l);
                                isToHypercore = this.checkPacketSentForComposer(parsed);
                            }
                        } catch {}
                    }
                } else {
                    const parsed = EndpointV2Events.parseLog(packetSentLog);
                    isToHypercore = this.checkPacketSentForComposer(parsed);
                }
                const event = OFTAdapterEvents.parseLog(log);
                const oftSent = new OFTSent(
                    event.args[0],
                    Number(event.args[1]),
                    event.args[2],
                    event.args[3].toString(),
                    event.args[4].toString(),
                    this.fasset,
                    now,
                    log.transactionHash,
                    isToHypercore
                );
                await this.em.persistAndFlush(oftSent);
            } catch (error) {
                logger.error(`'Error in oft send processing:`, error);
            }
        }
    }

    checkPacketSentForComposer(parsed: ethers.LogDescription): boolean {
        const payload = parsed.args[0];
        const receiver = ethers.dataSlice(payload, 113, 145);
        const receiverAddress = ethers.getAddress(ethers.dataSlice(receiver, 12));
        if (receiverAddress.toLowerCase() === this.oftConfig.HypeComposerAddress) {
            return true;
        }
        return false;
    }

    async saveOFTReceivedEvents(logs: ethers.Log[]): Promise<void> {
        const now = Date.now();
        for (const log of logs) {
            try {
                const event = OFTAdapterEvents.parseLog(log);
                const oftReceived = new OFTReceived(
                    event.args[0],
                    Number(event.args[1]),
                    event.args[2],
                    event.args[3].toString(),
                    this.fasset,
                    now,
                    log.transactionHash
                );
                await this.em.persistAndFlush(oftReceived);
            } catch (error) {
                logger.error(`'Error in oft received processing:`, error);
            }
        }
    }

    async saveOFTRedemptions(allLogs: OFTLogs): Promise<void> {
        const logs = allLogs.fAssetRedeemed;
        const now = Date.now();
        // Merge both plain and tag AM redemption-request events into a single
        // per-tx map so the composer `FAssetRedeemed` matcher can find either.
        const redReqMap = new Map<string, ethers.Log[]>();
        const appendReqLog = (p: ethers.Log) => {
            const existing = redReqMap.get(p.transactionHash) || [];
            existing.push(p);
            redReqMap.set(p.transactionHash, existing);
        };
        allLogs.redemptionRequested.forEach(appendReqLog);
        allLogs.redemptionWithTagRequested.forEach(appendReqLog);

        // Cache topic0 hashes for branch decoding below.
        const plainTopic = AM_REDEMPTION_REQUESTED_EVENT.getEvent("RedemptionRequested").topicHash;
        const tagTopic = AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT.getEvent("RedemptionWithTagRequested").topicHash;

        for (const log of logs) {
            try {
                const fAssetRedeemedEvent = FAssetRedeemComposerEvents.parseLog(log);
                const guid = fAssetRedeemedEvent.args[0];
                const srcEid = Number(fAssetRedeemedEvent.args[1]);
                const redeemer = fAssetRedeemedEvent.args[2];
                const redeemerAccount = fAssetRedeemedEvent.args[3];

                let redemptionReqLogs = redReqMap.get(log.transactionHash);
                if (!redemptionReqLogs) {
                    // Fallback: re-fetch the tx receipt and pick out any
                    // AM redemption-request logs (plain OR tagged) by topic0.
                    const txReceipt = await log.getTransactionReceipt();
                    redemptionReqLogs = [];
                    for (const l of txReceipt.logs) {
                        try {
                            if (l.topics[0] === plainTopic || l.topics[0] === tagTopic) {
                                redemptionReqLogs.push(l);
                            }
                        } catch {}
                    }
                }

                if (!redemptionReqLogs || redemptionReqLogs.length === 0) {
                    continue;
                }

                for (const reqLog of redemptionReqLogs) {
                    // Branch on topic0 to choose the correct Interface for decoding.
                    // Args 0..9 are the same in both events — only the tag event
                    // carries a 13th arg (`destinationTag`, args[12]).
                    const isTagEvent = reqLog.topics[0] === tagTopic;
                    const parsed = isTagEvent ? AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT.parseLog(reqLog) : AM_REDEMPTION_REQUESTED_EVENT.parseLog(reqLog);
                    const destinationTag = isTagEvent ? parsed.args[12].toString() : null;
                    const oftRedemption = new OFTRedemption(
                        parsed.args[0], // agentVault
                        redeemer, // redeemer (user address from FAssetRedeemed)
                        parsed.args[2].toString(), // requestId
                        parsed.args[3], // paymentAddress
                        parsed.args[4].toString(), // valueUBA
                        parsed.args[5].toString(), // feeUBA
                        parsed.args[9], // paymentReference
                        now, // timestamp
                        log.transactionHash, // txhash
                        this.fasset, // fasset
                        guid, // guid
                        redeemerAccount, // personalRedeemerAddress
                        srcEid, // srcEid
                        destinationTag // destinationTag (null unless tag event)
                    );
                    await this.em.persistAndFlush(oftRedemption);
                }
            } catch (error) {
                logger.error(`Error in oft redemption processing:`, error);
            }
        }
    }

    /** Parses FAssetRedeemFailed logs and persists each as an OFTRedemptionFailed entity. */
    async saveOFTRedemptionFailedEvents(logs: ethers.Log[]): Promise<void> {
        const now = Date.now();
        for (const log of logs) {
            try {
                const event = FAssetRedeemComposerEvents.parseLog(log);
                const oftRedemptionFailed = new OFTRedemptionFailed(
                    event.args[2], // redeemer
                    event.args[4].toString(), // amountToRedeemAfterFee
                    now, // timestamp
                    log.transactionHash, // txhash
                    this.fasset, // fasset
                    event.args[0], // guid
                    event.args[3], // personalRedeemerAddress
                    Number(event.args[1]) // srcEid
                );
                await this.em.persistAndFlush(oftRedemptionFailed);
            } catch (error) {
                logger.error(`Error in oft redemption failed processing:`, error);
            }
        }
    }

    async getComposerFeePPM(srcEid: number): Promise<string> {
        const fee: bigint = await this.composerContract.getComposerFeePPM(srcEid);
        return fee.toString();
    }

    /** Fetches the default executor address from the FAssetRedeemComposer contract. */
    async getDefaultExecutor(): Promise<string> {
        const executorAddress: string = await this.composerContract.defaultExecutor();
        return executorAddress;
    }

    /**
     * Returns the executor fee in native wei. Always "0" on coston2 (testnet), so
     * manual testing doesn't require sending a real fee; on all other networks
     * returns the `EXECUTOR_FEE_WEI` constant from `./utils/constants.ts`.
     */
    getExecutorFee(): string {
        return this.network === "coston2" ? "0" : EXECUTOR_FEE_WEI;
    }

    async getRedeemerAccountAddress(redeemer: string): Promise<string> {
        return this.composerContract.getRedeemerAccountAddress(redeemer);
    }

    /**
     * Resolves ERC20 metadata (symbol + decimals) for a token address, caching
     * the result per-address so we only ever do one RPC roundtrip per token.
     * Applies the same symbol normalization used by `UserService.getNativeBalancesWithAddresses`
     * (renaming `USDT` → `USDT0`) so the FE receives consistent token labels.
     */
    private async getTokenMetadata(tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
        const key = tokenAddress.toLowerCase();
        const cached = this.tokenMetadataCache.get(key);
        if (cached) return cached;
        const token = ERC20__factory.connect(tokenAddress, this.provider);
        const [rawSymbol, rawDecimals] = await Promise.all([token.symbol(), token.decimals()]);
        const symbol = rawSymbol === "USDT" ? "USDT0" : rawSymbol;
        const decimals = Number(rawDecimals);
        const metadata = { symbol, decimals };
        this.tokenMetadataCache.set(key, metadata);
        return metadata;
    }

    /**
     * Fetches the redeemer account's fAsset / stableCoin / wNat balances via the
     * composer's `getBalances()` and formats them as `NativeBalanceItemTokenAddress[]`
     * in the order [wNat, fAsset, stableCoin] to mirror the existing frontend
     * ordering (wnat → fasset → collateral).
     */
    async getRedeemerAccountBalances(account: string): Promise<NativeBalanceItemTokenAddress[]> {
        const balances: {
            fAsset: { token: string; balance: bigint };
            stableCoin: { token: string; balance: bigint };
            wNat: { token: string; balance: bigint };
        } = await this.composerContract.getBalances(account);

        // Resolve (and cache) metadata for all three tokens in parallel.
        const [wNatMeta, fAssetMeta, stableCoinMeta] = await Promise.all([
            this.getTokenMetadata(balances.wNat.token),
            this.getTokenMetadata(balances.fAsset.token),
            this.getTokenMetadata(balances.stableCoin.token),
        ]);

        // Assemble in the same order the FE expects: wnat → fasset → collateral.
        return [
            {
                symbol: wNatMeta.symbol,
                balance: formatBigIntToStringForceDecimals(balances.wNat.balance, 2, wNatMeta.decimals),
                exact: balances.wNat.balance.toString(),
                address: balances.wNat.token,
                type: "wnat",
            },
            {
                symbol: fAssetMeta.symbol,
                balance: formatBigIntToStringForceDecimals(balances.fAsset.balance, 2, fAssetMeta.decimals),
                exact: balances.fAsset.balance.toString(),
                address: balances.fAsset.token,
                type: "fasset",
            },
            {
                symbol: stableCoinMeta.symbol,
                balance: formatBigIntToStringForceDecimals(balances.stableCoin.balance, 2, stableCoinMeta.decimals),
                exact: balances.stableCoin.balance.toString(),
                address: balances.stableCoin.token,
                type: "collateral",
            },
        ];
    }
}
