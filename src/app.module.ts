import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { UserService } from "./services/user.service";
import { BotService } from "./services/bot.init.service";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { RunnerService } from "./services/runner.service";
import { Minting } from "./entities/Minting";
import { Redemption } from "./entities/Redemption";
import { MikroOrmHealthIndicator } from "./health/orm.health.indicator";
import { TerminusModule } from "@nestjs/terminus";
import { ScheduleModule } from "@nestjs/schedule";
import { CleaningService } from "./services/cleaning.cron.service";
import { Pool } from "./entities/Pool";
import { ConfigModule } from "@nestjs/config";
import { HttpModule } from "@nestjs/axios";
import { Liveness } from "./entities/AgentLiveness";
import { LoggerMiddleware } from "./logger/logger.middleware";
import { UserController } from "./controllers/user.controller";
import mikroOrmConfig from "./utils/mikro-orm.config";
import { BalanceController } from "./controllers/balance.controller";
import { RedemptionController } from "./controllers/redemption.controller";
import { MintController } from "./controllers/mint.controller";
import { PoolController } from "./controllers/pool.controller";
import { HealthController } from "./controllers/health.controller";
import { FullRedemption } from "./entities/RedemptionWhole";
import { Collateral } from "./entities/Collaterals";
import { CacheModule } from "@nestjs/cache-manager";
import { ExternalApiService } from "./services/external.api.service";
import { RedemptionDefault } from "./entities/RedemptionDefault";
import { IncompleteRedemption } from "./entities/RedemptionIncomplete";
import { HandshakeEvent } from "./entities/Handshake";
import { CollateralReservationEvent } from "./entities/CollateralReservation";
import { SwaggerController } from "./controllers/swagger.controller";
import { CrRejectedCancelledEvent } from "./entities/CollateralReservationRejected";
import { RedemptionRejected } from "./entities/RedemptionRejected";
import { RedemptionRequested } from "./entities/RedemptionRequested";
import { RedemptionTakenOver } from "./entities/RedemptionTakenOver";
import { RedemptionDefaultEvent } from "./entities/RedemptionDefaultEvent";

@Module({
    imports: [
        TerminusModule,
        ScheduleModule.forRoot(),
        MikroOrmModule.forRoot(mikroOrmConfig),
        MikroOrmModule.forFeature([
            Minting,
            Redemption,
            Pool,
            Liveness,
            FullRedemption,
            Collateral,
            RedemptionDefault,
            IncompleteRedemption,
            CollateralReservationEvent,
            HandshakeEvent,
            CrRejectedCancelledEvent,
            RedemptionRejected,
            RedemptionRequested,
            RedemptionTakenOver,
            RedemptionDefaultEvent,
        ]),
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        HttpModule.register({
            timeout: 25000,
            maxRedirects: 5,
        }),
        CacheModule.register({}),
    ],
    controllers: [UserController, BalanceController, RedemptionController, MintController, PoolController, HealthController, SwaggerController],
    providers: [MikroOrmHealthIndicator, UserService, CleaningService, BotService, RunnerService, ExternalApiService],
    exports: [BotService, UserService],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(LoggerMiddleware).forRoutes("*");
    }
}
