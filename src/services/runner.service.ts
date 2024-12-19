/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Minting } from "../entities/Minting";
import { Redemption } from "../entities/Redemption";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { requiredEventArgs } from "node_modules/@flarelabs/fasset-bots-core/dist/src/utils/events/truffle";
import { latestBlockTimestamp, requireNotNull, sumBN, toBN, web3, web3DeepNormalize } from "@flarelabs/fasset-bots-core/utils";
import { AssetManagerSettings, ChainId, UserBotCommands } from "@flarelabs/fasset-bots-core";
import { BotService } from "./bot.init.service";
import { attestationProved } from "node_modules/@flarelabs/fasset-bots-core/dist/src/underlying-chain/AttestationHelper";
import { Liveness } from "../entities/AgentLiveness";
import { dateStringToTimestamp, formatBNToDisplayDecimals, sleep, timestampToDateString } from "src/utils/utils";
import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { RedeemData, RedemptionDefaultEvent } from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { TX_BLOCKED, TX_FAILED, TX_SUCCESS, TxInputOutput } from "node_modules/@flarelabs/fasset-bots-core/dist/src/underlying-chain/interfaces/IBlockChain";
import { BTC_MDU } from "node_modules/@flarelabs/fasset-bots-core/dist/src/underlying-chain/BlockchainIndexerHelper";
import BN from "bn.js";
import { Pool } from "src/entities/Pool";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { RedemptionRejected } from "src/entities/RedemptionRejected";
import { RedemptionTakenOver } from "src/entities/RedemptionTakenOver";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { AttestationNotProved } from "node_modules/@flarelabs/fasset-bots-core/dist/src/underlying-chain/interfaces/IFlareDataConnectorClient";

enum RedemptionStatus {
    EXPIRED = "EXPIRED",
    SUCCESS = "SUCCESS",
    DEFAULT = "DEFAULT",
    PENDING = "PENDING",
}

@Injectable()
export class RunnerService implements OnApplicationBootstrap {
    private em: EntityManager;
    private userBotMap: Map<string, UserBotCommands> = new Map();

    constructor(
        private readonly orm: MikroORM,
        private readonly botService: BotService
    ) {}

    onApplicationBootstrap() {
        //start when everything is initialized
        this.em = this.orm.em.fork();
        this.userBotMap = this.botService.getUserBotMap();
        const s = this.botService.getSecrets();
        web3.eth.accounts.wallet.add(s.data.user.native.private_key);
        void this.startProcessing();
    }

    async startProcessing() {
        logger.info(`Starting runner.service`);
        while (true) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                for (const [fasset, userBot] of this.userBotMap) {
                    //TODO: make this in parallel for each fasset (when mysql will be used)
                    await this.processMintings(fasset);
                    await this.processRedemptions(fasset);
                    //await this.pingAgents(fasset);//TODO: fix: Error in start processing:  TransactionFailedError: Returned error: unknown account
                }
            } catch (error) {
                logger.error(`Starting runner.service run into error`, error);
            }
        }
    }

    private async pingAgents(fasset: string) {
        const time = Date.now();
        const agents = await this.em.find(Liveness, { publiclyAvailable: true, fasset: fasset }, { orderBy: { lastPinged: "asc" } });
        if (agents.length == 0) {
            return;
        }
        const agent = agents[0];
        if (time - agent.lastPinged < 1 * 60 * 60 * 1000) {
            return;
        }
        await this.userBotMap.get(fasset).context.assetManager.agentPing(agent.vaultAddress, 0, {
            from: this.userBotMap.get(fasset).nativeAddress,
        });
        const info = await this.userBotMap.get(fasset).context.assetManager.getAgentInfo(agent.vaultAddress);
        agent.lastPinged = time;
        agent.publiclyAvailable = info.publiclyAvailable;
        await this.em.persistAndFlush(agent);
    }

    private async executeMinting(fasset: string, proof: any, collateralReservationId: string) {
        const res = await this.userBotMap
            .get(fasset)
            .context.assetManager.executeMinting(web3DeepNormalize(proof), collateralReservationId, { from: this.userBotMap.get(fasset).nativeAddress });
        return requiredEventArgs(res, "MintingExecuted");
    }

    private async executeRedemptionDefault(fasset: string, proof: any, requestId: string) {
        const res = await this.userBotMap
            .get(fasset)
            .context.assetManager.redemptionPaymentDefault(web3DeepNormalize(proof), requestId, { from: this.userBotMap.get(fasset).nativeAddress });
        return requiredEventArgs(res, "RedemptionDefault");
    }

    private async executeRejectedRedemptionPaymentDefault(fasset: string, requestId: string) {
        const res = await this.userBotMap
            .get(fasset)
            .context.assetManager.rejectedRedemptionPaymentDefault(requestId, { from: this.userBotMap.get(fasset).nativeAddress });
        return requiredEventArgs(res, "RedemptionDefault");
    }

    private async getXRPTransaction(fasset: string, txHash: string) {
        const transaction = await this.userBotMap.get(fasset).context.blockchainIndexer.getTransaction(txHash);
        if (fasset.includes("BTC") || fasset.includes("DOGE")) {
            return transaction;
        }
        if (transaction != null) return transaction;
        let currentBlockHeight = await this.userBotMap.get(fasset).context.blockchainIndexer.getBlockHeight();
        const waitBlocks = 6 + currentBlockHeight;
        while (currentBlockHeight < waitBlocks) {
            await sleep(1000);
            const transaction = await this.userBotMap.get(fasset).context.blockchainIndexer.getTransaction(txHash);
            if (transaction != null) return transaction;
            currentBlockHeight = await this.userBotMap.get(fasset).context.blockchainIndexer.getBlockHeight();
        }
        return null;
    }

    private async processMintings(fasset: string) {
        //this.logger.debug('Looking for unprocessed minting...');
        //TODO fix query to get unprocessed mintings younger than 1 day.
        const mintings = await this.em.find(Minting, { processed: false, fasset: fasset }, { orderBy: { id: "ASC" } });
        const time = Date.now();
        for (const minting of mintings) {
            try {
                if (minting == null) {
                    //console.log("minting null");
                    continue;
                }
                if (minting.state == false) {
                    try {
                        const tx = await this.getXRPTransaction(fasset, minting.txhash);
                        if (tx == null) {
                            if (time - minting.timestamp > 1000 * 60 * 60 * 5) {
                                await this.em.removeAndFlush(minting);
                                continue;
                            }
                            //console.log("Not found");
                            //await this.em.removeAndFlush(minting);
                            continue;
                        }
                    } catch (error) {
                        logger.error(`Error in processMintings (get transaction):`, error);
                        continue;
                    }
                    /*if(tx == "tx") {
            continue;
          }*/
                    /*let underlyingAddress;
          if(fasset == "FTestBTC" || fasset == "FTestDOGE") {
            const tx = await this.userBotMap.get(fasset).context.blockchainIndexer.getTransaction(minting.txhash);
            underlyingAddress = tx.inputs[0][0];
          } else {
            underlyingAddress = minting.userUnderlyingAddress;
          }*/
                    let request;
                    if (fasset.includes("BTC") || fasset.includes("DOGE")) {
                        try {
                            request = await this.userBotMap
                                .get(fasset)
                                .context.attestationProvider.requestPaymentProof(minting.txhash, null, minting.paymentAddress);
                        } catch (error) {
                            logger.error(`Error in processMintings (request payment proof):`, error);
                            continue;
                        }
                    } else {
                        try {
                            request = await this.userBotMap
                                .get(fasset)
                                .context.attestationProvider.requestPaymentProof(minting.txhash, minting.userUnderlyingAddress, minting.paymentAddress);
                        } catch (error) {
                            logger.error(`Error in processMintings (request payment proof):`, error);
                            continue;
                        }
                    }
                    //const request = await this.userBotMap.get(fasset).context.attestationProvider.requestPaymentProof(minting.txhash, underlyingAddress, minting.paymentAddress);
                    if (request) {
                        //console.log("Payment proof is available");
                        minting.state = true;
                        minting.proofRequestData = request.data;
                        minting.proofRequestRound = request.round;
                        await this.em.persistAndFlush(minting);
                    } else {
                        //console.log("No payment proof, next minting.");
                        continue;
                    }
                }
                if (minting.state == true) {
                    try {
                        //await this.userService.proveAndExecuteMinting(minting.collateralReservationId, minting.txhash, minting.paymentAddress, minting.userUnderlyingAddress);
                        //console.log("Payment proof is available, obtaining proof");
                        let proof;
                        try {
                            proof = await this.userBotMap
                                .get(fasset)
                                .context.attestationProvider.obtainPaymentProof(minting.proofRequestRound, minting.proofRequestData);
                            // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        } catch (error) {
                            continue;
                        }
                        if (proof === AttestationNotProved.NOT_FINALIZED) {
                            //console.log("Proof not finalized");
                            continue;
                        }
                        if (proof === AttestationNotProved.DISPROVED) {
                            minting.proved = true;
                            minting.processed = true;
                            await this.em.persistAndFlush(minting);
                            //console.log("Proof not finalized");
                            continue;
                        }
                        if (attestationProved(proof)) {
                            //console.log("Executing minting");
                            minting.proved = true;
                            await this.em.persistAndFlush(minting);
                            try {
                                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                                const res = await this.executeMinting(fasset, proof, minting.collateralReservationId);
                                minting.processed = true;
                                await this.em.persistAndFlush(minting);
                            } catch (error) {
                                logger.error(`Error in processMintings (executeMinting):`, error);
                                if (error.message.includes("invalid crt id")) {
                                    minting.processed = true;
                                    await this.em.persistAndFlush(minting);
                                }
                                if (error.message.includes("invalid minting reference")) {
                                    minting.processed = true;
                                    await this.em.removeAndFlush(minting);
                                }
                                continue;
                            }
                        } else {
                            //console.log("Cannot obtain proof at this round");
                            continue;
                        }
                    } catch (error) {
                        logger.error(`Error in processMintings (proof):`, error);
                        continue;
                    }
                } else {
                    continue;
                }
            } catch (error) {
                logger.error(`Error in processMintings:`, error);
                continue;
            }
        }
    }

    //Add handling rejected/taken over/redemptions
    private async processRedemptions(fasset: string) {
        //this.logger.debug('Looking for unprocessed redemption...');
        const redemptions = await this.em.find(Redemption, { processed: false, fasset: fasset }, { orderBy: { id: "ASC" } });
        const settings = await this.userBotMap.get(fasset).context.assetManager.getSettings();
        const timestamp = await latestBlockTimestamp();
        const time = Date.now();
        for (const redemption of redemptions) {
            try {
                if (redemption == null) {
                    continue;
                }
                if (time > redemption.validUntil - 4 * 24 * 60 * 60 * 1000) {
                    redemption.processed = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }
                console.log(redemption.requestId);
                if (redemption.handshakeType != 0 && (redemption.takenOver == false || redemption.amountUBA != "0")) {
                    try {
                        if (
                            redemption.rejected == false &&
                            Number(redemption.timestamp) + (Number(settings.rejectRedemptionRequestWindowSeconds) + 10) * 1000 > Date.now()
                        ) {
                            const redemptionRejected = await this.em.findOne(RedemptionRejected, { requestId: redemption.requestId });
                            if (redemptionRejected === null) {
                                continue;
                            }
                            if (redemption.rejected == false) {
                                redemption.rejected = true;
                                await this.em.persistAndFlush(redemption);
                            }
                        }
                        if (redemption.rejected == true && (redemption.takenOver == false || redemption.amountUBA != "0")) {
                            const redemptionTakenOver = await this.em.findOne(RedemptionTakenOver, { requestId: redemption.requestId });
                            if (redemptionTakenOver === null || redemption.amountUBA != "0") {
                                const redemptionRejected = await this.em.findOne(RedemptionRejected, { requestId: redemption.requestId });
                                if (Number(redemptionRejected.timestamp) + Number(settings.takeOverRedemptionRequestWindowSeconds) * 1000 < Date.now()) {
                                    // Runner can call default
                                    const res = await this.executeRejectedRedemptionPaymentDefault(fasset, redemption.requestId);
                                    const event: RedemptionDefaultEvent = {
                                        agentVault: res.agentVault,
                                        redeemer: res.redeemer,
                                        requestId: toBN(res.requestId).toString(),
                                        redemptionAmountUBA: toBN(res.redemptionAmountUBA).toString(),
                                        redeemedVaultCollateralWei: toBN(res.redeemedVaultCollateralWei).toString(),
                                        redeemedPoolCollateralWei: toBN(res.redeemedPoolCollateralWei).toString(),
                                    };
                                    await this.saveRedemptionDefaultEvent(event, fasset, redemption);
                                    redemption.processed = true;
                                    redemption.defaulted = true;
                                    redemption.rejectionDefault = true;
                                    await this.em.persistAndFlush(redemption);
                                    continue;
                                }
                            }
                            //TODO update the request if takeover destroyed this request or update it
                            if (redemptionTakenOver != null && redemption.takenOver == false) {
                                redemption.takenOver = true;
                                const closedAmount = Number(redemption.amountUBA) - Number(redemptionTakenOver.valueTakenOverUBA);
                                const newRequest = await this.em.findOne(RedemptionRequested, { requestId: redemptionTakenOver.newRequestId });
                                const newAmountUBA = toBN(newRequest.valueUBA).sub(toBN(newRequest.feeUBA));
                                const newTakenOverRed = new Redemption(
                                    redemption.txhash,
                                    false,
                                    redemption.underlyingAddress,
                                    newRequest.paymentReference,
                                    newAmountUBA.toString(),
                                    newRequest.firstUnderlyingBlock,
                                    newRequest.lastUnderlyingBlock,
                                    newRequest.lastUnderlyingTimestamp,
                                    newRequest.requestId,
                                    redemption.validUntil,
                                    redemption.fasset,
                                    0,
                                    false,
                                    false,
                                    false,
                                    Date.now()
                                );
                                await this.em.persistAndFlush(newTakenOverRed);
                                if (closedAmount <= 0) {
                                    redemption.amountUBA = "0";
                                    redemption.processed = true;
                                    redemption.state = true;
                                    await this.em.persistAndFlush(redemption);
                                    continue;
                                } else {
                                    redemption.amountUBA = Math.floor(closedAmount).toString();
                                    await this.em.persistAndFlush(redemption);
                                    continue;
                                }
                            } else {
                                continue;
                            }
                        }
                    } catch (error) {
                        logger.error(`Error in processRedemptions handshake req:`, error);
                        continue;
                    }
                }
                if (redemption.defaulted == false && redemption.processed == false) {
                    try {
                        const createdAt = (redemption.validUntil - 7 * 24 * 60 * 60 * 1000) / 1000;
                        const redeemData: RedeemData = {
                            type: "redeem",
                            requestId: redemption.requestId,
                            amountUBA: redemption.amountUBA.toString(),
                            paymentReference: redemption.paymentReference,
                            firstUnderlyingBlock: redemption.firstUnderlyingBlock,
                            lastUnderlyingBlock: redemption.lastUnderlyingBlock,
                            lastUnderlyingTimestamp: redemption.lastUnderlyingTimestamp,
                            executorAddress: this.userBotMap.get(fasset).nativeAddress,
                            createdAt: timestampToDateString(createdAt),
                            underlyingAddress: redemption.underlyingAddress,
                        };
                        const settings = await this.userBotMap.get(fasset).context.assetManager.getSettings();
                        const status = await this.redemptionStatus(fasset, redeemData, timestamp, settings);
                        if (status == "SUCCESS" || status == "EXPIRED") {
                            redemption.processed = true;
                            await this.em.persistAndFlush(redemption);
                            continue;
                        }
                        if (status == "PENDING") {
                            continue;
                        }
                        if (status == "DEFAULT") {
                            redemption.defaulted = true;
                            await this.em.persistAndFlush(redemption);
                        }
                    } catch (error) {
                        logger.error(`Error in processRedemptions status:`, error);
                        continue;
                    }
                }
                if (redemption.state == false) {
                    //console.log("Requesting non payment proof");
                    let request;
                    try {
                        const createdAt = (redemption.validUntil - 7 * 24 * 60 * 60 * 1000) / 1000;
                        const redeemData: RedeemData = {
                            type: "redeem",
                            requestId: redemption.requestId,
                            amountUBA: redemption.amountUBA.toString(),
                            paymentReference: redemption.paymentReference,
                            firstUnderlyingBlock: redemption.firstUnderlyingBlock,
                            lastUnderlyingBlock: redemption.lastUnderlyingBlock,
                            lastUnderlyingTimestamp: redemption.lastUnderlyingTimestamp,
                            executorAddress: this.userBotMap.get(fasset).nativeAddress,
                            createdAt: timestampToDateString(createdAt),
                            underlyingAddress: redemption.underlyingAddress,
                        };
                        const settings = await this.userBotMap.get(fasset).context.assetManager.getSettings();
                        const status = await this.redemptionStatus(fasset, redeemData, timestamp, settings);
                        if (status == "SUCCESS" || status == "EXPIRED") {
                            redemption.processed = true;
                            redemption.defaulted = false;
                            await this.em.persistAndFlush(redemption);
                            continue;
                        }
                        if (status == "PENDING") {
                            redemption.defaulted = false;
                            await this.em.persistAndFlush(redemption);
                            continue;
                        }
                        request = await this.userBotMap
                            .get(fasset)
                            .context.attestationProvider.requestReferencedPaymentNonexistenceProof(
                                redemption.underlyingAddress.toString(),
                                redemption.paymentReference.toString(),
                                toBN(redemption.amountUBA),
                                Number(redemption.firstUnderlyingBlock),
                                Number(redemption.lastUnderlyingBlock),
                                Number(redemption.lastUnderlyingTimestamp)
                            );
                    } catch (error) {
                        if (!error.message.includes("overflow block not found")) {
                            logger.error(`Error in processRedemptions (requestReferencedPaymentNonexistenceProof):`, error);
                        }
                        continue;
                    }
                    if (request) {
                        //console.log("Reference payment nonexistence proof is available");
                        redemption.state = true;
                        redemption.proofRequestData = request.data;
                        redemption.proofRequestRound = request.round;
                        await this.em.persistAndFlush(redemption);
                    } else {
                        //console.log("No payment nonexistance yet proof, next redemption ticket.");
                        continue;
                    }
                }
                if (redemption.state == true) {
                    try {
                        //await this.userService.proveAndExecuteMinting(minting.collateralReservationId, minting.txhash, minting.paymentAddress, minting.userUnderlyingAddress);
                        //console.log("Payment nonexistance proof is available, obtaining proof");
                        const proof = await this.userBotMap
                            .get(fasset)
                            .context.attestationProvider.obtainReferencedPaymentNonexistenceProof(redemption.proofRequestRound, redemption.proofRequestData);
                        if (proof === AttestationNotProved.NOT_FINALIZED) {
                            //console.log("Redemption Proof not finalized");
                            continue;
                        }
                        if (proof === AttestationNotProved.DISPROVED) {
                            //console.log("Redemption Proof not finalized");
                            continue;
                        }
                        if (attestationProved(proof)) {
                            //console.log("Executing redemption default");
                            // eslint-disable-next-line @typescript-eslint/no-unused-vars
                            const res = await this.executeRedemptionDefault(fasset, proof, redemption.requestId);
                            const event: RedemptionDefaultEvent = {
                                agentVault: res.agentVault,
                                redeemer: res.redeemer,
                                requestId: toBN(res.requestId).toString(),
                                redemptionAmountUBA: toBN(res.redemptionAmountUBA).toString(),
                                redeemedVaultCollateralWei: toBN(res.redeemedVaultCollateralWei).toString(),
                                redeemedPoolCollateralWei: toBN(res.redeemedPoolCollateralWei).toString(),
                            };
                            await this.saveRedemptionDefaultEvent(event, fasset, redemption);
                            redemption.processed = true;
                            await this.em.persistAndFlush(redemption);
                        } else {
                            //console.log("Cannot obtain proof at this round");
                            continue;
                        }
                    } catch (error) {
                        logger.error(`Error in processRedemptions (proof):`, error);
                        continue;
                    }
                } else {
                    continue;
                }
            } catch (error) {
                logger.error(`Error in processRedemptions:`, error);
                continue;
            }
        }
    }

    async saveRedemptionDefaultEvent(event: RedemptionDefaultEvent, fasset: string, redemption: Redemption): Promise<void> {
        const now = new Date().getTime();
        const agent = await this.em.find(Pool, {
            vaultAddress: event.agentVault,
        });
        /*const collateral = await this.em.find(Collateral, {
      token: agent[0].vaultToken,
    });*/
        /*const vaultCollateralRedeemed = formatBNToDisplayDecimals(
      toBN(event.redeemedVaultCollateralWei),
      agent[0].vaultCollateralToken == "testETH" ? 6 : 3,
      collateral[0].decimals,
    );
    const poolCollateralRedeemed = formatBNToDisplayDecimals(
      toBN(event.redeemedPoolCollateralWei),
      3,
      18,
    );*/
        const value = formatBNToDisplayDecimals(toBN(redemption.amountUBA), fasset.includes("XRP") ? 2 : 8, fasset.includes("XRP") ? 6 : 8);
        const defEvent = new RedemptionDefault(
            redemption.txhash,
            event.agentVault,
            event.redeemer,
            value,
            toBN(event.redeemedVaultCollateralWei).toString(),
            toBN(event.redeemedPoolCollateralWei).toString(),
            redemption.requestId,
            redemption.fasset,
            agent[0].vaultCollateralToken,
            now
        );
        await this.em.persistAndFlush(defEvent);
        return;
    }

    async redemptionStatus(fasset: string, state: RedeemData, timestamp: number, settings: AssetManagerSettings): Promise<RedemptionStatus> {
        const stateTs = dateStringToTimestamp(state.createdAt);
        if (timestamp - stateTs >= Number(settings.attestationWindowSeconds)) {
            return RedemptionStatus.EXPIRED;
        } else if (await this.findRedemptionPayment(this.userBotMap.get(fasset), state)) {
            return RedemptionStatus.SUCCESS;
        } else if (await this.redemptionTimeElapsed(this.userBotMap.get(fasset), state)) {
            return RedemptionStatus.DEFAULT;
        } else {
            return RedemptionStatus.PENDING;
        }
    }

    /*async getTransactionsByReference(reference: string, from: number, bot: UserBotCommands): Promise<ITransaction[] | []> {
        const txs = await retry(this.getTransactionsByReferenceFromIndexer.bind(this), [bot, reference, from], DEFAULT_RETRIES);
        //logger.info(`Block chain indexer helper: retrieved transactions by reference ${reference}: ${formatArgs(txs)}`);
        return txs;
    }*/

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
        const blockHeight = await bot.context.blockchainIndexer.getBlockHeight();
        const lastBlock = requireNotNull(await bot.context.blockchainIndexer.getBlockAt(blockHeight));
        return blockHeight > Number(state.lastUnderlyingBlock) && lastBlock.timestamp > Number(state.lastUnderlyingTimestamp);
    }
}
