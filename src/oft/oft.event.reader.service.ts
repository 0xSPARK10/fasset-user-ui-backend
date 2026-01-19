import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ethers, FetchRequest } from "ethers";
import { readFileSync } from "fs";
import { Secrets } from "@flarelabs/fasset-bots-core";
import { join } from "path";
import {
    AM_REDEMPTION_REQUESTED_EVENT,
    ComposerEvents,
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
import { GuidRedemption } from "src/entities/OFTRedemptionGUID";

@Injectable()
export class OFTEventReaderService implements OnModuleInit {
    private provider: ethers.JsonRpcProvider;
    private network: string;
    private oftConfig: OFTConfig;
    private em: EntityManager;
    private envType: string;
    private executorAddress: string;
    private fasset: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly orm: MikroORM
    ) {}

    async onModuleInit() {
        this.em = this.orm.em.fork();
        const [rpcUrl, rpcKey] = await this.getRpcData();
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
        void this.startReadingEvents();
    }

    async getRpcData(): Promise<[string, string]> {
        const filePathSecrets = join(__dirname, "../..", "src", "secrets.json");
        const filePathConfig = join(__dirname, "../..", "src", this.configService.get<string>("NETWORK", "coston2") + "-bot.json");
        const configFileContent = readFileSync(filePathConfig, "utf-8");
        const config = JSON.parse(configFileContent);
        const secrets = await Secrets.load(filePathSecrets);
        const rpcUrl = config.rpcUrl;
        this.executorAddress = secrets.data.user.native.address;
        const rpcKey = Array.isArray(secrets.data.apiKey.native_rpc) ? secrets.data.apiKey.native_rpc[0] : secrets.data.apiKey.native_rpc;
        return [rpcUrl, rpcKey];
    }

    // TODO optimize event reading so there is no need to fetch receipts.
    async fetchEvents(fromBlock: number, toBlock: number): Promise<OFTLogs> {
        const oftSentFilter = {
            address: this.oftConfig.OFTAdapterAddress,
            topics: [OFTAdapterEvents.getEvent("OFTSent").topicHash],
        };

        const oftReceivedFilter = {
            address: this.oftConfig.OFTAdapterAddress,
            topics: [OFTAdapterEvents.getEvent("OFTReceived").topicHash],
        };

        const redemptionTriggeredFilter = {
            address: this.oftConfig.OFTComposerContractAddress,
            topics: [ComposerEvents.getEvent("RedemptionTriggered").topicHash],
        };
        /*const redemptionRequestedFilter = {
            address: this.oftConfig.AssetManagerAddress,
            topics: [AM_REDEMPTION_REQUESTED_EVENT.getEvent("RedemptionRequested").topicHash],
        };*/
        const packetSentFilter = {
            address: this.oftConfig.EndpointV2Address,
            topics: [EndpointV2Events.getEvent("PacketSent").topicHash],
        };
        const composeDeliveredFilter = {
            address: this.oftConfig.EndpointV2Address,
            topics: [EndpointV2Events.getEvent("ComposeDelivered").topicHash],
        };
        const [oftSentLogs, oftReceivedLogs, redemptionTriggeredLogs, redemptionRequestedLogs, packetSentLogs, composeDeliveredLogs] = await Promise.all([
            this.provider.getLogs({ fromBlock: fromBlock, toBlock: toBlock, address: oftSentFilter.address, topics: oftSentFilter.topics }),
            this.provider.getLogs({ fromBlock: fromBlock, toBlock: toBlock, address: oftReceivedFilter.address, topics: oftReceivedFilter.topics }),
            this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: redemptionTriggeredFilter.address,
                topics: redemptionTriggeredFilter.topics,
            }),
            /*this.provider.getLogs({
                fromBlock: fromBlock,
                toBlock: toBlock,
                address: redemptionRequestedFilter.address,
                topics: redemptionRequestedFilter.topics,
            }),*/
            [],
            this.provider.getLogs({ fromBlock: fromBlock, toBlock: toBlock, address: packetSentFilter.address, topics: packetSentFilter.topics }),
            this.provider.getLogs({ fromBlock: fromBlock, toBlock: toBlock, address: composeDeliveredFilter.address, topics: composeDeliveredFilter.topics }),
        ]);
        return {
            oftSent: oftSentLogs,
            oftReceived: oftReceivedLogs,
            redemptionTriggered: redemptionTriggeredLogs,
            redemptionRequested: redemptionRequestedLogs,
            packetSent: packetSentLogs,
            composeDelivered: composeDeliveredLogs,
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
                    //await this.saveOFTRedemptionGuid(logs);
                }
                if (!lastBlockDB) {
                    const lbDB = new IndexerState("oftLastBlock", lastBlock + 1);
                    await this.em.persistAndFlush(lbDB);
                } else {
                    lastBlockDB.lastBlock = lastBlock + 1;
                    await this.em.persistAndFlush(lastBlockDB);
                }
            } catch (error) {
                logger.error(`'Error in oft event reader:`, error);
            }
        }
    }

    // Todo optimize persist and flush to persist at the end.
    async saveOFTSentEvents(allLogs: OFTLogs): Promise<void> {
        const logs = allLogs.oftSent;
        const packetMap = new Map<string, ethers.Log>();
        allLogs.packetSent.forEach((p) => packetMap.set(p.transactionHash, p));
        const now = Date.now();
        for (const log of logs) {
            try {
                // TODO when more chains put into if eid is hyperevm to check for hypercore
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

    async saveOFTRedemptionGuid(allLogs: OFTLogs): Promise<void> {
        const logs = allLogs.redemptionTriggered;
        const now = Date.now();
        const composeMap = new Map<string, ethers.Log>();
        allLogs.composeDelivered.forEach((p) => composeMap.set(p.transactionHash, p));
        const redReqMap = new Map<string, ethers.Log[]>();
        allLogs.redemptionRequested.forEach((p) => {
            const existing = redReqMap.get(p.transactionHash) || [];
            redReqMap.set(p.transactionHash, [...existing, p]);
        });
        for (const log of logs) {
            try {
                const redTriggeredLog = ComposerEvents.parseLog(log);
                const requestIds = [];
                let guid = "";
                let executorTagged = true;
                let redemptionReqLog = redReqMap.get(log.transactionHash);
                const composeDeliveredLog = composeMap.get(log.transactionHash);
                if (!redemptionReqLog || !composeDeliveredLog) {
                    const txReceipt = await log.getTransactionReceipt();
                    redemptionReqLog = [];
                    for (const l of txReceipt.logs) {
                        try {
                            if (l.topics[0] === AM_REDEMPTION_REQUESTED_EVENT.getEvent("RedemptionRequested").topicHash) {
                                redemptionReqLog.push(l);
                            }
                            if (l.topics[0] === EndpointV2Events.getEvent("ComposeDelivered").topicHash) {
                                const parsed = EndpointV2Events.parseLog(l);
                                guid = parsed.args[2];
                            }
                        } catch {}
                    }
                } else {
                    const parsedComposeDeliveredLog = EndpointV2Events.parseLog(composeDeliveredLog);
                    guid = parsedComposeDeliveredLog.args[2];
                }
                if (redemptionReqLog) {
                    for (const reqLog of redemptionReqLog) {
                        const parsed = AM_REDEMPTION_REQUESTED_EVENT.parseLog(reqLog);
                        if (this.executorAddress.toLowerCase() !== parsed.args[10].toLowerCase()) {
                            executorTagged = false;
                            break;
                        }
                        requestIds.push(parsed.args[2].toString());
                    }
                }
                if (!executorTagged || !guid || requestIds.length === 0) {
                    continue;
                }
                for (const req of requestIds) {
                    const redGuid = new GuidRedemption(guid, req, redTriggeredLog.args[0], this.fasset, now, log.transactionHash);
                    await this.em.persistAndFlush(redGuid);
                }
            } catch (error) {
                logger.error(`'Error in oft redemption triggered processing:`, error);
            }
        }
    }
}
