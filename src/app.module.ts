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
import { CollateralReservationEvent } from "./entities/CollateralReservation";
import { SwaggerController } from "./controllers/swagger.controller";
import { RedemptionRequested } from "./entities/RedemptionRequested";
import { RedemptionDefaultEvent } from "./entities/RedemptionDefaultEvent";
import { UnderlyingPayment } from "./entities/UnderlyingPayment";
import { IndexerState } from "./entities/IndexerState";
import { MintingDefaultEvent } from "./entities/MintingDefaultEvent";
import { PoolService } from "./services/pool.service";
import { UtxoService } from "./services/utxo.service";
import { HistoryService } from "./services/userHistory.service";
import { EarnController } from "./controllers/earn.controller";
import { EarnService } from "./services/earn.service";
import { VersionController } from "./controllers/version.controller";
import { VersionService } from "./services/version.service";
import { RedemptionBlocked } from "./entities/RedemptionBlockedEvent";
import { XRPLApiService } from "./services/xrpl-api.service";
import { WalletController } from "./controllers/wallet.controller";
import { WalletService } from "./services/wallet.service";
import { Wallet } from "./entities/Wallet";

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
            RedemptionRequested,
            RedemptionDefaultEvent,
            UnderlyingPayment,
            IndexerState,
            MintingDefaultEvent,
            RedemptionBlocked,
            Wallet,
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
    controllers: [
        UserController,
        BalanceController,
        RedemptionController,
        MintController,
        PoolController,
        HealthController,
        SwaggerController,
        EarnController,
        VersionController,
        WalletController,
    ],
    providers: [
        MikroOrmHealthIndicator,
        UserService,
        CleaningService,
        BotService,
        RunnerService,
        ExternalApiService,
        PoolService,
        UtxoService,
        HistoryService,
        EarnService,
        VersionService,
        XRPLApiService,
        WalletService,
    ],
    exports: [BotService, UserService, PoolService, UtxoService, HistoryService],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(LoggerMiddleware).forRoutes("*");
    }
}
