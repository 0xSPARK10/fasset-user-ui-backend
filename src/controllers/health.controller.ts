import { Controller, Get } from "@nestjs/common";
import { HealthCheckService, HealthCheck } from "@nestjs/terminus";
import { ApiTags } from "@nestjs/swagger";
import { MikroOrmHealthIndicator } from "src/health/orm.health.indicator";

@ApiTags("Database")
@Controller("health")
export class HealthController {
    constructor(
        private health: HealthCheckService,
        private ormHealthIndicator: MikroOrmHealthIndicator
    ) {}

    @Get()
    @HealthCheck()
    check() {
        return this.health.check([async () => this.ormHealthIndicator.isHealthy("database")]);
    }
}
