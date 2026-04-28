import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { ethers, Interface, LogDescription } from "ethers";
import { IndexerState } from "src/entities/IndexerState";
import { Liveness } from "src/entities/AgentLiveness";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { Minting } from "src/entities/Minting";
import { formatBigIntToDisplayDecimals } from "src/utils/utils";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { Redemption } from "src/entities/Redemption";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { MintingDefaultEvent } from "src/entities/MintingDefaultEvent";
import { RedemptionBlocked } from "src/entities/RedemptionBlockedEvent";
import { DirectMintingExecutedEvent } from "src/entities/DirectMintingExecutedEvent";
import { DirectMintingExecutedToSmartAccountEvent } from "src/entities/DirectMintingExecutedToSmartAccountEvent";
import { DirectMintingPaymentTooSmallForFeeEvent } from "src/entities/DirectMintingPaymentTooSmallForFeeEvent";
import { DirectMintingDelayedEvent } from "src/entities/DirectMintingDelayedEvent";
import { LargeDirectMintingDelayedEvent } from "src/entities/LargeDirectMintingDelayedEvent";
import { RedemptionWithTagRequestedEvent } from "src/entities/RedemptionWithTagRequestedEvent";
import { RedemptionAmountIncompleteEvent } from "src/entities/RedemptionAmountIncompleteEvent";
import { logger } from "src/logger/winston.logger";
import { EthersService } from "./ethers.service";
import { ContractService } from "./contract.service";
import { FassetConfigService } from "./fasset.config.service";
import { IIAssetManager__factory } from "../typechain-ethers-v6";
import type { IIAssetManager } from "../typechain-ethers-v6";

/** Maps an asset-manager address (lower-cased) to its fasset metadata. */
interface AssetManagerEntry {
    fasset: string;
    address: string;
    decimals: number;
}

@Injectable()
export class EventReaderService implements OnApplicationBootstrap {
    eventTopics: string[] = [];
    executorAddress: string;
    assetManagerAddresses: string[] = [];
    private assetManagerMap = new Map<string, AssetManagerEntry>();
    private iface: Interface;
    private em: EntityManager;

    constructor(
        private readonly ethersService: EthersService,
        private readonly contractService: ContractService,
        private readonly fassetConfigService: FassetConfigService,
        private readonly orm: MikroORM
    ) {
        // Build event topic hashes using ethers.id (keccak256 of UTF-8 string)
        this.eventTopics = [
            ethers.id("AgentPingResponse(address,address,uint256,string)"),
            ethers.id("CollateralReserved(address,address,uint256,uint256,uint256,uint256,uint256,uint256,string,bytes32,address,uint256)"),
            ethers.id("RedemptionRequested(address,address,uint256,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256)"),
            ethers.id("RedemptionDefault(address,address,uint256,uint256,uint256,uint256)"),
            ethers.id("RedemptionRequestIncomplete(address,uint256)"),
            ethers.id("MintingPaymentDefault(address,address,uint256,uint256)"),
            ethers.id("RedemptionPaymentBlocked(address,address,uint256,bytes32,uint256,int256)"),
            // Direct minting events
            ethers.id("DirectMintingExecuted(bytes32,address,address,uint256,uint256,uint256)"),
            ethers.id("DirectMintingExecutedToSmartAccount(bytes32,string,address,uint256,uint256,bytes)"),
            ethers.id("DirectMintingPaymentTooSmallForFee(bytes32,uint256,uint256)"),
            ethers.id("DirectMintingDelayed(bytes32,uint256,uint256)"),
            ethers.id("LargeDirectMintingDelayed(bytes32,uint256,uint256)"),
            // Redemption with tag events
            ethers.id("RedemptionWithTagRequested(address,address,uint256,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256,uint256)"),
            ethers.id("RedemptionAmountIncomplete(address,uint256)"),
        ];

        // Reuse one shared Interface instance for decoding all AssetManager events
        this.iface = IIAssetManager__factory.createInterface();
    }

    async onApplicationBootstrap() {
        this.em = this.orm.em.fork();
        this.executorAddress = this.ethersService.getExecutorAddress();

        // Build the asset-manager address list and fasset→address mapping
        // from ContractService (deployment entries named "AssetManager_<fasset>")
        // and FassetConfigService (for token decimals).
        await this.buildAssetManagerMap();

        void this.startReadingEvents();
    }

    /**
     * Populates assetManagerAddresses and assetManagerMap by matching
     * ContractService deployment keys like "AssetManager_FTestXRP" with
     * FassetConfigService fasset names, then reading assetDecimals from the contract.
     */
    private async buildAssetManagerMap(): Promise<void> {
        const fassetNames = this.fassetConfigService.getFAssetNames();
        const contractNames = this.contractService.getContractNames();

        for (const fasset of fassetNames) {
            const deploymentKey = `AssetManager_${fasset}`;
            if (!contractNames.includes(deploymentKey)) {
                logger.warn(`No deployment found for ${deploymentKey}, skipping`);
                continue;
            }

            const assetManager = this.contractService.get<IIAssetManager>(deploymentKey);
            const address = typeof assetManager.target === "string" ? assetManager.target : await assetManager.getAddress();

            // Read on-chain decimals from settings
            const settings = await assetManager.getSettings();
            const decimals = Number(settings.assetDecimals);

            const entry: AssetManagerEntry = { fasset, address, decimals };
            this.assetManagerMap.set(address.toLowerCase(), entry);
            this.assetManagerAddresses.push(address);
        }
    }

    async startReadingEvents(): Promise<void> {
        const blockReadOffset = 30;
        const provider = this.ethersService.getProvider();

        while (true) {
            try {
                const timestamp = Date.now();
                const lastBlock = (await provider.getBlockNumber()) - 4;
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
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
                for (let lastBlockRead = lastEventBlock; lastBlockRead <= lastBlock; lastBlockRead += blockReadOffset) {
                    const toBlock = Math.min(lastBlockRead + blockReadOffset - 1, lastBlock);
                    const decodedEvents = await this.readEventsFrom(lastBlockRead, toBlock);

                    for (const decoded of decodedEvents) {
                        const am = this.assetManagerMap.get(decoded.address.toLowerCase());
                        if (!am) {
                            continue;
                        }
                        const event = decoded.parsed;
                        const txHash = decoded.transactionHash;

                        if (event.name === "AgentPingResponse") {
                            const vaultAddress = event.args.agentVault as string;
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
                        } else if (event.name === "CollateralReserved") {
                            if (event.args.executor != this.executorAddress) {
                                continue;
                            }
                            const collateralReservationId = (event.args.collateralReservationId as bigint).toString();
                            const count = await this.em.count(CollateralReservationEvent, {
                                txhash: txHash,
                                collateralReservationId: collateralReservationId,
                            });
                            if (count == 0) {
                                const crEvent = new CollateralReservationEvent(
                                    collateralReservationId,
                                    event.args.agentVault as string,
                                    event.args.minter as string,
                                    (event.args.valueUBA as bigint).toString(),
                                    (event.args.feeUBA as bigint).toString(),
                                    (event.args.firstUnderlyingBlock as bigint).toString(),
                                    (event.args.lastUnderlyingBlock as bigint).toString(),
                                    (event.args.lastUnderlyingTimestamp as bigint).toString(),
                                    event.args.paymentAddress as string,
                                    event.args.paymentReference as string,
                                    event.args.executor as string,
                                    (event.args.executorFeeNatWei as bigint).toString(),
                                    timestamp,
                                    txHash
                                );
                                await this.em.persistAndFlush(crEvent);
                            }
                            const mint = await this.em.count(Minting, {
                                txhash: txHash,
                                collateralReservationId: collateralReservationId,
                            });
                            if (mint == 0) {
                                const paymentAmount = event.args.valueUBA as bigint;
                                const amount = formatBigIntToDisplayDecimals(paymentAmount, am.fasset.includes("XRP") ? 2 : 8, am.decimals);
                                const time = new Date(timestamp + 7 * 24 * 60 * 60 * 1000);
                                const validUntil = time.getTime();
                                const tx = await this.em.findOne(UnderlyingPayment, {
                                    paymentReference: event.args.paymentReference as string,
                                });
                                const minting = new Minting(
                                    collateralReservationId,
                                    tx ? tx.underlyingHash : null,
                                    event.args.paymentAddress as string,
                                    event.args.minter as string,
                                    false,
                                    validUntil,
                                    false,
                                    am.fasset,
                                    event.args.minter as string,
                                    amount,
                                    timestamp,
                                    event.args.agentVault as string,
                                    event.args.paymentReference as string
                                );
                                await this.em.persistAndFlush(minting);
                            }
                        } else if (event.name === "RedemptionRequested") {
                            const requestId = (event.args.requestId as bigint).toString();
                            const count = await this.em.count(RedemptionRequested, {
                                txhash: txHash,
                                requestId: requestId,
                            });
                            if (count != 0) {
                                continue;
                            }
                            const redemptionRequestedEvent = new RedemptionRequested(
                                event.args.agentVault as string,
                                event.args.redeemer as string,
                                requestId,
                                event.args.paymentAddress as string,
                                (event.args.valueUBA as bigint).toString(),
                                (event.args.feeUBA as bigint).toString(),
                                (event.args.firstUnderlyingBlock as bigint).toString(),
                                (event.args.lastUnderlyingBlock as bigint).toString(),
                                (event.args.lastUnderlyingTimestamp as bigint).toString(),
                                event.args.paymentReference as string,
                                timestamp,
                                txHash,
                                am.fasset
                            );
                            await this.em.persistAndFlush(redemptionRequestedEvent);
                            const red = await this.em.count(Redemption, {
                                txhash: txHash,
                                requestId: requestId,
                            });
                            if (red == 0) {
                                const valueUBA = event.args.valueUBA as bigint;
                                const feeUBA = event.args.feeUBA as bigint;
                                const amountUBA = valueUBA - feeUBA;
                                const time = new Date(timestamp + 7 * 24 * 60 * 60 * 1000);
                                const validUntil = time.getTime();
                                const redemption = new Redemption(
                                    txHash,
                                    false,
                                    event.args.paymentAddress as string,
                                    event.args.paymentReference as string,
                                    amountUBA.toString(),
                                    (event.args.firstUnderlyingBlock as bigint).toString(),
                                    (event.args.lastUnderlyingBlock as bigint).toString(),
                                    (event.args.lastUnderlyingTimestamp as bigint).toString(),
                                    requestId,
                                    validUntil,
                                    am.fasset,
                                    timestamp
                                );
                                await this.em.persistAndFlush(redemption);
                            }
                        } else if (event.name === "RedemptionDefault") {
                            const redemptionDefaultEvent = new RedemptionDefaultEvent(
                                event.args.agentVault as string,
                                event.args.redeemer as string,
                                (event.args.requestId as bigint).toString(),
                                (event.args.redemptionAmountUBA as bigint).toString(),
                                (event.args.redeemedVaultCollateralWei as bigint).toString(),
                                (event.args.redeemedPoolCollateralWei as bigint).toString(),
                                timestamp,
                                txHash
                            );
                            await this.em.persistAndFlush(redemptionDefaultEvent);
                        } else if (event.name === "RedemptionRequestIncomplete") {
                            const redemptionIncompleteEvent = new IncompleteRedemption(
                                txHash,
                                event.args.redeemer as string,
                                (event.args.remainingLots as bigint).toString(),
                                timestamp
                            );
                            await this.em.persistAndFlush(redemptionIncompleteEvent);
                        } else if (event.name === "MintingPaymentDefault") {
                            const mintingDefault = new MintingDefaultEvent(
                                event.args.agentVault as string,
                                event.args.minter as string,
                                (event.args.collateralReservationId as bigint).toString(),
                                (event.args.reservedAmountUBA as bigint).toString(),
                                timestamp,
                                txHash
                            );
                            await this.em.persistAndFlush(mintingDefault);
                        } else if (event.name === "RedemptionPaymentBlocked") {
                            const redemptionBlocked = new RedemptionBlocked(
                                event.args.agentVault as string,
                                event.args.redeemer as string,
                                (event.args.requestId as bigint).toString(),
                                event.args.transactionHash as string,
                                (event.args.redemptionAmountUBA as bigint).toString(),
                                (event.args.spentUnderlyingUBA as bigint).toString(),
                                timestamp,
                                txHash
                            );
                            await this.em.persistAndFlush(redemptionBlocked);
                        } else if (event.name === "DirectMintingExecuted") {
                            const transactionId = (event.args.transactionId as string).toLowerCase();
                            const count = await this.em.count(DirectMintingExecutedEvent, { transactionId, txhash: txHash });
                            if (count === 0) {
                                const entity = new DirectMintingExecutedEvent(
                                    transactionId,
                                    event.args.targetAddress as string,
                                    event.args.executor as string,
                                    (event.args.mintedAmountUBA as bigint).toString(),
                                    (event.args.mintingFeeUBA as bigint).toString(),
                                    (event.args.executorFeeUBA as bigint).toString(),
                                    timestamp,
                                    txHash,
                                    am.fasset
                                );
                                await this.em.persistAndFlush(entity);
                            }
                        } else if (event.name === "DirectMintingExecutedToSmartAccount") {
                            const transactionId = (event.args.transactionId as string).toLowerCase();
                            const count = await this.em.count(DirectMintingExecutedToSmartAccountEvent, { transactionId, txhash: txHash });
                            if (count === 0) {
                                const entity = new DirectMintingExecutedToSmartAccountEvent(
                                    transactionId,
                                    event.args.sourceAddress as string,
                                    event.args.executor as string,
                                    (event.args.mintedAmountUBA as bigint).toString(),
                                    (event.args.mintingFeeUBA as bigint).toString(),
                                    event.args.memoData as string,
                                    timestamp,
                                    txHash,
                                    am.fasset
                                );
                                await this.em.persistAndFlush(entity);
                            }
                        } else if (event.name === "DirectMintingPaymentTooSmallForFee") {
                            const transactionId = (event.args.transactionId as string).toLowerCase();
                            const count = await this.em.count(DirectMintingPaymentTooSmallForFeeEvent, { transactionId, txhash: txHash });
                            if (count === 0) {
                                const entity = new DirectMintingPaymentTooSmallForFeeEvent(
                                    transactionId,
                                    (event.args.receivedAmount as bigint).toString(),
                                    (event.args.mintingFeeUBA as bigint).toString(),
                                    timestamp,
                                    txHash,
                                    am.fasset
                                );
                                await this.em.persistAndFlush(entity);
                            }
                        } else if (event.name === "DirectMintingDelayed") {
                            const transactionId = (event.args.transactionId as string).toLowerCase();
                            const count = await this.em.count(DirectMintingDelayedEvent, { transactionId, txhash: txHash });
                            if (count === 0) {
                                const entity = new DirectMintingDelayedEvent(
                                    transactionId,
                                    (event.args.amount as bigint).toString(),
                                    Number(event.args.executionAllowedAt as bigint),
                                    timestamp,
                                    txHash,
                                    am.fasset
                                );
                                await this.em.persistAndFlush(entity);
                            }
                        } else if (event.name === "LargeDirectMintingDelayed") {
                            const transactionId = (event.args.transactionId as string).toLowerCase();
                            const count = await this.em.count(LargeDirectMintingDelayedEvent, { transactionId, txhash: txHash });
                            if (count === 0) {
                                const entity = new LargeDirectMintingDelayedEvent(
                                    transactionId,
                                    (event.args.amount as bigint).toString(),
                                    Number(event.args.executionAllowedAt as bigint),
                                    timestamp,
                                    txHash,
                                    am.fasset
                                );
                                await this.em.persistAndFlush(entity);
                            }
                        } else if (event.name === "RedemptionWithTagRequested") {
                            const requestId = (event.args.requestId as bigint).toString();
                            const count = await this.em.count(RedemptionWithTagRequestedEvent, { txhash: txHash, requestId });
                            if (count === 0) {
                                const entity = new RedemptionWithTagRequestedEvent(
                                    event.args.agentVault as string,
                                    event.args.redeemer as string,
                                    requestId,
                                    event.args.paymentAddress as string,
                                    (event.args.valueUBA as bigint).toString(),
                                    (event.args.feeUBA as bigint).toString(),
                                    (event.args.firstUnderlyingBlock as bigint).toString(),
                                    (event.args.lastUnderlyingBlock as bigint).toString(),
                                    (event.args.lastUnderlyingTimestamp as bigint).toString(),
                                    event.args.paymentReference as string,
                                    (event.args.destinationTag as bigint).toString(),
                                    timestamp,
                                    txHash,
                                    am.fasset
                                );
                                await this.em.persistAndFlush(entity);
                            }
                        } else if (event.name === "RedemptionAmountIncomplete") {
                            const count = await this.em.count(RedemptionAmountIncompleteEvent, { txhash: txHash, redeemer: event.args.redeemer as string });
                            if (count === 0) {
                                const entity = new RedemptionAmountIncompleteEvent(
                                    event.args.redeemer as string,
                                    (event.args.remainingAmountUBA as bigint).toString(),
                                    timestamp,
                                    txHash,
                                    am.fasset
                                );
                                await this.em.persistAndFlush(entity);
                            }
                        }
                    }
                }
                if (!lastBlockDB) {
                    const lbDB = new IndexerState("lastBlock", lastBlock + 1);
                    await this.em.persistAndFlush(lbDB);
                } else {
                    lastBlockDB.lastBlock = lastBlock + 1;
                    await this.em.persistAndFlush(lastBlockDB);
                }
            } catch (error) {
                logger.error(`'Error in event reader:`, error);
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }

    /** Fetch logs from all asset managers and decode them via IIAssetManager interface. */
    async readEventsFrom(fromBlock: number, toBlock: number): Promise<Array<{ address: string; transactionHash: string; parsed: LogDescription }>> {
        const logs = await this.ethersService.getProvider().getLogs({
            address: this.assetManagerAddresses,
            fromBlock,
            toBlock,
            topics: [this.eventTopics],
        });

        const results: Array<{ address: string; transactionHash: string; parsed: LogDescription }> = [];
        for (const log of logs) {
            try {
                const parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
                if (parsed) {
                    results.push({
                        address: log.address,
                        transactionHash: log.transactionHash,
                        parsed,
                    });
                }
            } catch {
                // Skip logs that don't match the ABI
            }
        }
        return results;
    }
}
