import { Injectable } from "@nestjs/common";
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from "@nestjs/terminus";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { logger } from "src/logger/winston.logger";
import { Minting } from "src/entities/Minting";

@Injectable()
export class MikroOrmHealthIndicator extends HealthIndicator {
    constructor(private readonly orm: MikroORM) {
        super();
    }

    async isHealthy(key: string): Promise<HealthIndicatorResult> {
        const em: EntityManager = this.orm.em.fork();
        try {
            await em.findOne(Minting, { processed: false });
            return this.getStatus(key, true);
        } catch (err) {
            logger.error(`Error in MikroORM health check`, err);
            throw new HealthCheckError("MikroORM health check failed", err);
        }
    }
}
