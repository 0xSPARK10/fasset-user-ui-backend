import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { BotService } from "./bot.init.service";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { web3 } from "@flarelabs/fasset-bots-core/utils";
import { IndexerState } from "src/entities/IndexerState";
import { BlockNumber, Log } from "web3-core";
import { EvmEvent, toBN } from "@flarelabs/fasset-bots-core";
import { Web3ContractEventDecoder } from "@flarelabs/fasset-bots-core";
import { Truffle } from "@flarelabs/fasset-bots-core/types";
import { Liveness } from "src/entities/AgentLiveness";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { Minting } from "src/entities/Minting";
import { formatBNToDisplayDecimals } from "src/utils/utils";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { Redemption } from "src/entities/Redemption";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { MintingDefaultEvent } from "src/entities/MintingDefaultEvent";
import { RedemptionBlocked } from "src/entities/RedemptionBlockedEvent";
import { logger } from "src/logger/winston.logger";

@Injectable()
export class EventReaderService implements OnApplicationBootstrap {
    eventTopics: string[] = [];
    executorAddress: string;
    assetManagerList: string[];
    private em: EntityManager;
    constructor(
        private readonly botService: BotService,
        private readonly orm: MikroORM
    ) {
        this.eventTopics = [
            web3.utils.keccak256("AgentPingResponse(address,address,uint256,string)"),
            web3.utils.keccak256("CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)"),
            web3.utils.keccak256("RedemptionRequested(address,address,uint256,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256)"),
            web3.utils.keccak256("RedemptionDefault(address,address,uint256,uint256,uint256,uint256)"),
            web3.utils.keccak256("RedemptionRequestIncomplete(address,uint256)"),
            web3.utils.keccak256("MintingPaymentDefault(address,address,uint256,uint256)"),
            web3.utils.keccak256("RedemptionPaymentBlocked(address,address,uint256,bytes32,uint256,int256)"),
        ];
    }

    onApplicationBootstrap() {
        //start when everything is initialized
        this.em = this.orm.em.fork();
        const bot = this.botService.getUserBot(this.botService.fassetList[0]);
        this.executorAddress = bot.nativeAddress;
        this.assetManagerList = this.botService.assetManagerAddressList;
        void this.startReadingEvents();
    }

    async startReadingEvents(): Promise<void> {
        const blockReadOffset = 30;
        const bot = this.botService.getInfoBot(this.botService.fassetList[0]);
        while (true) {
            try {
                const timestamp = Date.now();
                const lastBlock = (await web3.eth.getBlockNumber()) - 4;
                const lastBlockDB = await this.em.findOne(IndexerState, { name: "lastBlock" });
                let lastEventBlock: number;
                if (lastBlockDB) {
                    lastEventBlock = lastBlockDB.lastBlock;
                } else {
                    lastEventBlock = lastBlock;
                    const lbDB = new IndexerState("lastBlock", lastBlock);
                    await this.em.persistAndFlush(lbDB);
                }
                if (lastEventBlock >= lastBlock) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    continue;
                }
                //logger.info(`Reading events for from: ${lastEventBlock} to ${lastBlock.toString()}`);
                for (let lastBlockRead = lastEventBlock; lastBlockRead <= lastBlock; lastBlockRead += blockReadOffset) {
                    const allEvents = await this.readEventsFrom(
                        bot.context.assetManager,
                        lastBlockRead,
                        Math.min(lastBlockRead + blockReadOffset - 1, lastBlock)
                    );
                    for (const e of allEvents) {
                        const event = e as any;
                        const am = this.botService.assetManagerList.find((am) => am.assetManager === event.address);
                        if (!am) {
                            continue;
                        }
                        if (event.event === "AgentPingResponse") {
                            const vaultAddress = event.args.agentVault;
                            const agent = await this.em.findOne(Liveness, {
                                vaultAddress: vaultAddress,
                            });
                            if (agent == null) {
                                const agentLiveness = new Liveness(vaultAddress, am.fasset, timestamp, timestamp, false);
                                await this.em.persistAndFlush(agentLiveness);
                                continue;
                            }
                            agent.lastTimestamp = timestamp;
                            await this.em.persistAndFlush(agent);
                        } else {
                            if (event.event === "CollateralReserved") {
                                if (event.args.executor != this.executorAddress) {
                                    continue;
                                }
                                const count = await this.em.count(CollateralReservationEvent, {
                                    txhash: event.transactionHash,
                                    collateralReservationId: event.args.collateralReservationId,
                                });
                                if (count == 0) {
                                    const crEvent = new CollateralReservationEvent(
                                        event.args.collateralReservationId,
                                        event.args.agentVault,
                                        event.args.minter,
                                        event.args.valueUBA,
                                        event.args.feeUBA,
                                        event.args.firstUnderlyingBlock,
                                        event.args.lastUnderlyingBlock,
                                        event.args.lastUnderlyingTimestamp,
                                        event.args.paymentAddress,
                                        event.args.paymentReference,
                                        event.args.executor,
                                        event.args.executorFeeNatWei,
                                        timestamp,
                                        event.transactionHash
                                    );
                                    await this.em.persistAndFlush(crEvent);
                                }
                                const mint = await this.em.count(Minting, {
                                    txhash: event.transactionHash,
                                    collateralReservationId: event.args.collateralReservationId,
                                });
                                if (mint == 0) {
                                    const paymentAmount = toBN(event.args.valueUBA);
                                    const amount = formatBNToDisplayDecimals(toBN(paymentAmount), am.fasset.includes("XRP") ? 2 : 8, am.decimals);
                                    const time = new Date(timestamp + 7 * 24 * 60 * 60 * 1000);
                                    const validUntil = time.getTime();
                                    const tx = await this.em.findOne(UnderlyingPayment, {
                                        paymentReference: event.args.paymentReference,
                                    });
                                    const minting = new Minting(
                                        event.args.collateralReservationId,
                                        tx ? tx.underlyingHash : null,
                                        event.args.paymentAddress,
                                        event.args.minter,
                                        false,
                                        validUntil,
                                        false,
                                        am.fasset,
                                        event.args.minter,
                                        amount,
                                        timestamp,
                                        event.args.agentVault,
                                        event.args.paymentReference
                                    );
                                    await this.em.persistAndFlush(minting);
                                }
                            } else {
                                if (event.event === "RedemptionRequested") {
                                    if (event.args.executor != this.executorAddress) {
                                        continue;
                                    }
                                    const count = await this.em.count(RedemptionRequested, {
                                        txhash: event.transactionHash,
                                        requestId: event.args.requestId,
                                    });
                                    if (count != 0) {
                                        continue;
                                    }
                                    const redemptionRequestedEvent = new RedemptionRequested(
                                        event.args.agentVault,
                                        event.args.redeemer,
                                        event.args.requestId,
                                        event.args.paymentAddress,
                                        event.args.valueUBA,
                                        event.args.feeUBA,
                                        event.args.firstUnderlyingBlock,
                                        event.args.lastUnderlyingBlock,
                                        event.args.lastUnderlyingTimestamp,
                                        event.args.paymentReference,
                                        timestamp,
                                        event.transactionHash,
                                        am.fasset
                                    );
                                    await this.em.persistAndFlush(redemptionRequestedEvent);
                                    const red = await this.em.count(Redemption, {
                                        txhash: event.transactionHash,
                                        requestId: event.args.requestId,
                                    });
                                    if (red == 0) {
                                        const amountUBA = toBN(event.args.valueUBA).sub(toBN(event.args.feeUBA));
                                        const time = new Date(timestamp + 7 * 24 * 60 * 60 * 1000);
                                        const validUntil = time.getTime();
                                        const redemption = new Redemption(
                                            event.transactionHash,
                                            false,
                                            event.args.paymentAddress,
                                            event.args.paymentReference,
                                            amountUBA.toString(),
                                            event.args.firstUnderlyingBlock,
                                            event.args.lastUnderlyingBlock,
                                            event.args.lastUnderlyingTimestamp,
                                            event.args.requestId,
                                            validUntil,
                                            am.fasset,
                                            timestamp
                                        );
                                        await this.em.persistAndFlush(redemption);
                                    }
                                } else {
                                    if (event.event == "RedemptionDefault") {
                                        const redemptionDefaultEvent = new RedemptionDefaultEvent(
                                            event.args.agentVault,
                                            event.args.redeemer,
                                            event.args.requestId,
                                            event.args.redemptionAmountUBA,
                                            event.args.redeemedVaultCollateralWei,
                                            event.args.redeemedPoolCollateralWei,
                                            timestamp,
                                            event.transactionHash
                                        );
                                        await this.em.persistAndFlush(redemptionDefaultEvent);
                                    } else {
                                        if (event.event == "RedemptionRequestIncomplete") {
                                            const redemptionIncompleteEvent = new IncompleteRedemption(
                                                event.transactionHash,
                                                event.args.redeemer,
                                                event.args.remainingLots,
                                                timestamp
                                            );
                                            await this.em.persistAndFlush(redemptionIncompleteEvent);
                                        } else {
                                            if (event.event == "MintingPaymentDefault") {
                                                const mintingDefault = new MintingDefaultEvent(
                                                    event.args.agentVault,
                                                    event.args.minter,
                                                    event.args.collateralReservationId,
                                                    event.args.reservedAmountUBA,
                                                    timestamp,
                                                    event.transactionHash
                                                );
                                                await this.em.persistAndFlush(mintingDefault);
                                            } else {
                                                if (event.event == "RedemptionPaymentBlocked") {
                                                    const redemptionBlocked = new RedemptionBlocked(
                                                        event.args.agentVault,
                                                        event.args.redeemer,
                                                        event.args.requestId,
                                                        event.args.transactionHash,
                                                        event.args.redemptionAmountUBA,
                                                        event.args.spentUnderlyingUBA,
                                                        timestamp,
                                                        event.transactionHash
                                                    );
                                                    await this.em.persistAndFlush(redemptionBlocked);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                //this.lastEventBlockMap.set(fasset, lastBlock);
                //this.lastEventBlock = lastBlock + 1;
                if (!lastBlockDB) {
                    const lbDB = new IndexerState("lastBlock", lastBlock + 1);
                    await this.em.persistAndFlush(lbDB);
                } else {
                    lastBlockDB.lastBlock = lastBlock + 1;
                    await this.em.persistAndFlush(lastBlockDB);
                }
                //logger.info(`Finish reading events.`);
            } catch (error) {
                logger.error(`'Error in event reader:`, error);
            }
        }
    }
    async getPastLogsFromAssetManagers(fromBlock: BlockNumber, toBlock: BlockNumber, topics: string[]): Promise<Log[]> {
        const logs = await web3.eth.getPastLogs({
            address: this.assetManagerList,
            fromBlock: fromBlock,
            toBlock: toBlock,
            topics: [topics],
        });
        return logs;
    }

    async readEventsFrom(contract: Truffle.ContractInstance, fromBlock: BlockNumber, toBlock: BlockNumber): Promise<EvmEvent[]> {
        const eventDecoder = new Web3ContractEventDecoder({ contract });
        const allLogs = await this.getPastLogsFromAssetManagers(fromBlock, toBlock, this.eventTopics);
        return eventDecoder.decodeEvents(allLogs);
    }
}
