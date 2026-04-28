import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { OFTRedemption } from "src/entities/OFTRedemption";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { RedemptionBlocked } from "src/entities/RedemptionBlockedEvent";
import { VerifierService, ChainId } from "src/services/verifier.service";
import { logger } from "src/logger/winston.logger";

@Injectable()
export class OFTRedemptionProcessor implements OnModuleInit {
    private em: EntityManager;
    private verifier: VerifierService;
    private fasset: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly orm: MikroORM
    ) {}

    async onModuleInit() {
        this.em = this.orm.em.fork();
        const envType = this.configService.get<string>("APP_TYPE");
        this.fasset = envType == "dev" ? "FTestXRP" : "FXRP";
        const chainId = envType == "dev" ? ChainId.testXRP : ChainId.XRP;
        const verifierUrls = (this.configService.get<string>("XRP_INDEXER_URLS") || "")
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean);
        const verifierApiKeys = (this.configService.get<string>("VERIFIER_API_KEY") || "").split(",").map((k) => k.trim());
        this.verifier = new VerifierService(chainId, verifierUrls, verifierApiKeys);
        void this.startProcessing();
    }

    async startProcessing(): Promise<void> {
        logger.info("Starting OFT redemption processor");
        while (true) {
            try {
                await this.processRedemptions();
            } catch (error) {
                logger.error(`Error in OFT redemption processor:`, error);
            }
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }

    private async processRedemptions(): Promise<void> {
        const redemptions = await this.em.find(OFTRedemption, { processed: false }, { orderBy: { id: "ASC" } });
        for (const redemption of redemptions) {
            try {
                // Check if payment exists on the underlying chain
                const paymentFound = await this.findPayment(redemption);
                if (paymentFound) {
                    redemption.processed = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }

                // Check for redemption default event in DB
                const defaultEvent = await this.em.findOne(RedemptionDefaultEvent, {
                    requestId: redemption.requestId,
                });
                if (defaultEvent) {
                    redemption.processed = true;
                    redemption.defaulted = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }

                // Check for redemption blocked event in DB
                const blocked = await this.em.findOne(RedemptionBlocked, {
                    requestId: redemption.requestId,
                });
                if (blocked) {
                    redemption.processed = true;
                    redemption.blocked = true;
                    await this.em.persistAndFlush(redemption);
                    continue;
                }
            } catch (error) {
                logger.error(`Error processing OFT redemption ${redemption.requestId}:`, error);
            }
        }
    }

    private async findPayment(redemption: OFTRedemption): Promise<boolean> {
        try {
            const txs = await this.verifier.getTransactionsByReference(redemption.paymentReference);
            const amountRequired = BigInt(redemption.valueUBA) - BigInt(redemption.feeUBA);
            for (const tx of txs) {
                const amount = tx.outputs.filter((o) => o[0] === redemption.paymentAddress).reduce((sum, o) => sum + o[1], 0n);
                if (amount >= amountRequired) {
                    return true;
                }
            }
        } catch (error) {
            logger.error(`Error finding payment for OFT redemption ${redemption.requestId}:`, error);
        }
        return false;
    }
}
