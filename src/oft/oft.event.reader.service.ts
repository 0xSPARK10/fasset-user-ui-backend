import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ethers, FetchRequest } from "ethers";
import * as cron from "node-cron";
import {
    AM_REDEMPTION_REQUESTED_EVENT,
    AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT,
    AM_SYSTEM_REDEMPTION_FEE_PAID_EVENT,
    EXECUTOR_FEE_WEI,
    FAssetRedeemComposerEvents,
    FAssetRedeemComposerABI,
    coston2OFTConfig,
    EndpointV2Events,
    flareOFTConfig,
    OFTAdapterABI,
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
import { OFTComposerFeeCollected } from "src/entities/OFTComposerFeeCollected";
import { ERC20__factory } from "src/typechain-ethers-v6";
import { NativeBalanceItemTokenAddress, OFTLimitsResponse } from "src/interfaces/requestResponse";
import { formatBigIntToStringForceDecimals } from "src/utils/utils";

export const OFT_LAST_BLOCK_STATE = "oftLastBlock";
export const OFT_FIRST_TRUSTED_BLOCK_STATE = "oftFirstTrustedBlock";

const OFT_BLOCK_READ_OFFSET = 30;
const PACKET_GUID_OFFSET = 81;
const PACKET_MESSAGE_OFFSET = 113;

@Injectable()
export class OFTEventReaderService implements OnModuleInit, OnModuleDestroy {
    private provider: ethers.JsonRpcProvider;
    private network: string;
    private oftConfig: OFTConfig;
    private em: EntityManager;
    private envType: string;
    private fasset: string;
    private composerContract: ethers.Contract;
    private adapterContract: ethers.Contract;
    private limits: OFTLimitsResponse = {};
    private isRunningLimits: boolean = false;
    private limitsCron: { stop(): void };
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
        this.adapterContract = new ethers.Contract(this.oftConfig.OFTAdapterAddress, OFTAdapterABI, this.provider);
        void this.startReadingEvents();
        await this.updateLimits();
        this.limitsCron = cron.schedule("*/1 * * * *", () => {
            void this.updateLimits();
        });
    }

    onModuleDestroy(): void {
        this.limitsCron?.stop();
    }

    private async updateLimits(): Promise<void> {
        if (this.isRunningLimits) {
            return;
        }
        this.isRunningLimits = true;
        try {
            const limits = await Promise.all(
                this.oftConfig.DstEids.map(async (dstEid) => {
                    const [incoming, outgoing] = await Promise.all([
                        this.adapterContract.getAmountCanBeReceived(dstEid),
                        this.adapterContract.getAmountCanBeSent(dstEid),
                    ]);
                    return [
                        dstEid,
                        {
                            incomingRemainingDrops: incoming[1].toString(),
                            outgoingRemainingDrops: outgoing[1].toString(),
                        },
                    ] as const;
                })
            );
            this.limits = Object.fromEntries(limits);
        } catch (error) {
            logger.error("Error fetching OFT limits:", error);
        } finally {
            this.isRunningLimits = false;
        }
    }

    getLimits(): OFTLimitsResponse {
        return this.limits;
    }

    async getPaused(): Promise<boolean> {
        return this.adapterContract.paused();
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
        const systemRedemptionFeePaidFilter = {
            address: this.oftConfig.AssetManagerAddress,
            topics: [AM_SYSTEM_REDEMPTION_FEE_PAID_EVENT.getEvent("SystemRedemptionFeePaid").topicHash],
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
        // Composer fee event — only emitted when the per-redemption composer fee
        // is greater than zero, so the result set may be smaller than fAssetRedeemed.
        const composerFeeCollectedFilter = {
            address: this.oftConfig.FAssetRedeemComposerAddress,
            topics: [FAssetRedeemComposerEvents.getEvent("ComposerFeeCollected").topicHash],
        };
        const [
            oftSentLogs,
            oftReceivedLogs,
            fAssetRedeemedLogs,
            redemptionRequestedLogs,
            redemptionWithTagRequestedLogs,
            systemRedemptionFeePaidLogs,
            packetSentLogs,
            composeDeliveredLogs,
            fAssetRedeemFailedLogs,
            composerFeeCollectedLogs,
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
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: systemRedemptionFeePaidFilter.address,
                topics: systemRedemptionFeePaidFilter.topics,
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
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: composerFeeCollectedFilter.address,
                topics: composerFeeCollectedFilter.topics,
            }),
        ]);
        return {
            oftSent: oftSentLogs,
            oftReceived: oftReceivedLogs,
            fAssetRedeemed: fAssetRedeemedLogs,
            redemptionRequested: redemptionRequestedLogs,
            redemptionWithTagRequested: redemptionWithTagRequestedLogs,
            systemRedemptionFeePaid: systemRedemptionFeePaidLogs,
            packetSent: packetSentLogs,
            composeDelivered: composeDeliveredLogs,
            fAssetRedeemFailed: fAssetRedeemFailedLogs,
            composerFeeCollected: composerFeeCollectedLogs,
        };
    }

    async startReadingEvents(): Promise<void> {
        while (true) {
            try {
                const lastBlock = (await this.provider.getBlockNumber()) - 4;
                const lastEventBlock = await this.initializeIndexerState(lastBlock);
                if (lastEventBlock > lastBlock) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
                for (let rangeStart = lastEventBlock; rangeStart <= lastBlock; rangeStart += OFT_BLOCK_READ_OFFSET) {
                    const rangeEnd = Math.min(rangeStart + OFT_BLOCK_READ_OFFSET - 1, lastBlock);
                    const logs = await this.fetchEvents(rangeStart, rangeEnd);
                    await this.persistRange(logs, rangeStart, rangeEnd);
                }
            } catch (error) {
                logger.error(`Error in oft event reader:`, error);
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    private async initializeIndexerState(initialBlock: number): Promise<number> {
        const stateEm = this.orm.em.fork();
        return stateEm.transactional(async (em) => {
            let cursor = await em.findOne(IndexerState, { name: OFT_LAST_BLOCK_STATE });
            if (!cursor) {
                cursor = new IndexerState(OFT_LAST_BLOCK_STATE, initialBlock);
                await em.persistAndFlush(cursor);
            }

            const firstTrustedBlock = await em.findOne(IndexerState, { name: OFT_FIRST_TRUSTED_BLOCK_STATE });
            if (!firstTrustedBlock) {
                // Earlier blocks may have been scanned by the former best-effort
                // writer, so only the current next-unread block starts trusted coverage.
                await em.persistAndFlush(new IndexerState(OFT_FIRST_TRUSTED_BLOCK_STATE, cursor.lastBlock));
            }

            return cursor.lastBlock;
        });
    }

    /** Persists one complete range and its next-unread cursor in the same transaction. */
    async persistRange(logs: OFTLogs, rangeStart: number, rangeEnd: number): Promise<void> {
        const rangeEm = this.orm.em.fork();
        await rangeEm.transactional(async (em) => {
            const cursor = await em.findOne(IndexerState, { name: OFT_LAST_BLOCK_STATE });
            if (!cursor || cursor.lastBlock !== rangeStart) {
                throw new Error(`Unexpected OFT cursor while persisting range ${rangeStart}-${rangeEnd}: ${cursor?.lastBlock ?? "missing"}`);
            }

            await this.saveOFTSentEvents(logs, em);
            await this.saveOFTReceivedEvents(logs.oftReceived, em);
            await this.saveOFTRedemptions(logs, em);
            await this.saveOFTRedemptionFailedEvents(logs.fAssetRedeemFailed, em);

            cursor.lastBlock = rangeEnd + 1;
            await em.persistAndFlush(cursor);
        });
    }

    async saveOFTSentEvents(allLogs: OFTLogs, em: EntityManager = this.em): Promise<void> {
        const logs = allLogs.oftSent;
        const packetMap = new Map<string, ethers.LogDescription>();
        for (const packetLog of allLogs.packetSent) {
            const parsed = EndpointV2Events.parseLog(packetLog);
            const guid = this.getPacketGuid(parsed);
            if (packetMap.has(guid)) {
                throw new Error(`Multiple PacketSent events found for guid ${guid}`);
            }
            packetMap.set(guid, parsed);
        }
        const now = Date.now();
        for (const log of logs) {
            try {
                const event = OFTAdapterEvents.parseLog(log);
                const guid = (event.args[0] as string).toLowerCase();
                const packetSent = packetMap.get(guid);
                if (!packetSent) {
                    throw new Error(`Missing PacketSent event for OFTSent guid ${guid}`);
                }
                const oftSent = new OFTSent(
                    event.args[0],
                    Number(event.args[1]),
                    event.args[2],
                    event.args[3].toString(), // amountSentLD
                    event.args[4].toString(), // amountReceivedLD
                    this.fasset,
                    now,
                    log.transactionHash,
                    this.checkPacketSentForComposer(packetSent)
                );
                await em.persistAndFlush(oftSent);
            } catch (error) {
                logger.error(`'Error in oft send processing:`, error);
                throw error;
            }
        }
    }

    private getPacketGuid(parsed: ethers.LogDescription): string {
        return ethers.dataSlice(parsed.args[0], PACKET_GUID_OFFSET, PACKET_MESSAGE_OFFSET).toLowerCase();
    }

    checkPacketSentForComposer(parsed: ethers.LogDescription): boolean {
        const payload = parsed.args[0];
        const receiver = ethers.dataSlice(payload, PACKET_MESSAGE_OFFSET, PACKET_MESSAGE_OFFSET + 32);
        const receiverAddress = ethers.getAddress(ethers.dataSlice(receiver, 12));
        if (receiverAddress.toLowerCase() === this.oftConfig.HypeComposerAddress) {
            return true;
        }
        return false;
    }

    async saveOFTReceivedEvents(logs: ethers.Log[], em: EntityManager = this.em): Promise<void> {
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
                await em.persistAndFlush(oftReceived);
            } catch (error) {
                logger.error(`'Error in oft received processing:`, error);
                throw error;
            }
        }
    }

    async saveOFTRedemptions(allLogs: OFTLogs, em: EntityManager = this.em): Promise<void> {
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

        const systemFeeKey = (transactionHash: string, requestId: string, agentVault: string) =>
            `${transactionHash.toLowerCase()}:${requestId}:${agentVault.toLowerCase()}`;
        const systemFeeByRequest = new Map<string, string>();
        for (const feeLog of allLogs.systemRedemptionFeePaid ?? []) {
            const parsed = AM_SYSTEM_REDEMPTION_FEE_PAID_EVENT.parseLog(feeLog);
            const key = systemFeeKey(feeLog.transactionHash, parsed.args[1].toString(), parsed.args[0]);
            if (systemFeeByRequest.has(key)) {
                throw new Error(`Multiple SystemRedemptionFeePaid events found for redemption request ${key}`);
            }
            systemFeeByRequest.set(key, parsed.args[2].toString());
        }

        // Cache the tagged topic hash for branch decoding below.
        const tagTopic = AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT.getEvent("RedemptionWithTagRequested").topicHash;

        for (const log of logs) {
            try {
                const fAssetRedeemedEvent = FAssetRedeemComposerEvents.parseLog(log);
                const guid = fAssetRedeemedEvent.args[0];
                const srcEid = Number(fAssetRedeemedEvent.args[1]);
                const redeemer = fAssetRedeemedEvent.args[2];
                const redeemerAccount = fAssetRedeemedEvent.args[3];

                const redemptionReqLogs = redReqMap.get(log.transactionHash);
                if (!redemptionReqLogs || redemptionReqLogs.length === 0) {
                    throw new Error(`Missing AssetManager redemption request for FAssetRedeemed transaction ${log.transactionHash}`);
                }

                for (const reqLog of redemptionReqLogs) {
                    // Branch on topic0 to choose the correct Interface for decoding.
                    // Args 0..9 are the same in both events — only the tag event
                    // carries a 13th arg (`destinationTag`, args[12]).
                    const isTagEvent = reqLog.topics[0] === tagTopic;
                    const parsed = isTagEvent ? AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT.parseLog(reqLog) : AM_REDEMPTION_REQUESTED_EVENT.parseLog(reqLog);
                    const destinationTag = isTagEvent ? parsed.args[12].toString() : null;
                    const systemRedemptionFeeUBA =
                        systemFeeByRequest.get(systemFeeKey(reqLog.transactionHash, parsed.args[2].toString(), parsed.args[0])) ?? "0";
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
                        destinationTag, // destinationTag (null unless tag event)
                        systemRedemptionFeeUBA
                    );
                    await em.persistAndFlush(oftRedemption);
                }
            } catch (error) {
                logger.error(`Error in oft redemption processing:`, error);
                throw error;
            }
        }

        // Persist `ComposerFeeCollected` events from the same fetch window. The
        // composer emits these only when the per-redemption fee is > 0, so the
        // count here is <= number of FAssetRedeemed logs. Each row is linked back
        // to its redemption later via `guid` (one composer redemption → one fee).
        for (const log of allLogs.composerFeeCollected) {
            try {
                const event = FAssetRedeemComposerEvents.parseLog(log);
                const guid = event.args[0];
                const srcEid = Number(event.args[1]);
                const composerFeeRecipient = event.args[2];
                const composerFee = event.args[3].toString();
                const row = new OFTComposerFeeCollected(guid, srcEid, composerFeeRecipient, composerFee, this.fasset, now, log.transactionHash);
                await em.persistAndFlush(row);
            } catch (error) {
                logger.error(`Error in oft composer fee processing:`, error);
                throw error;
            }
        }
    }

    /** Parses FAssetRedeemFailed logs and persists each as an OFTRedemptionFailed entity. */
    async saveOFTRedemptionFailedEvents(logs: ethers.Log[], em: EntityManager = this.em): Promise<void> {
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
                await em.persistAndFlush(oftRedemptionFailed);
            } catch (error) {
                logger.error(`Error in oft redemption failed processing:`, error);
                throw error;
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
