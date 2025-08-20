import { Options, MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { SqliteDriver } from "@mikro-orm/sqlite";
import { Liveness } from "src/entities/AgentLiveness";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { Collateral } from "src/entities/Collaterals";
import { IndexerState } from "src/entities/IndexerState";
import { Minting } from "src/entities/Minting";
import { MintingDefaultEvent } from "src/entities/MintingDefaultEvent";
import { Pool } from "src/entities/Pool";
import { Redemption } from "src/entities/Redemption";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { FullRedemption } from "src/entities/RedemptionWhole";
import { UnderlyingPayment } from "src/entities/UnderlyingPayment";
import { logger } from "src/logger/winston.logger";

let config: Options;

if (process.env.DB_TYPE === "sqlite") {
    config = {
        dbName: "./database/executor-minting-redemptions.db",
        entities: [
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
        ],
        driver: SqliteDriver,
        debug: false,
    };
} else if (process.env.DB_TYPE === "postgresql") {
    config = {
        dbName: process.env.POSTGRES_DB,
        type: "postgresql",
        entities: [
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
        ],
        driver: PostgreSqlDriver,
        debug: false,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        host: process.env.POSTGRES_HOST,
        port: Number(process.env.POSTGRES_PORT),
        migrations: { disableForeignKeys: false },
    };
} else {
    throw new Error('Unsupported DB_TYPE. Please set DB_TYPE to either "sqlite" or "postgresql" in the .env file.');
}

export async function initializeMikroORM(): Promise<MikroORM> {
    const orm = await MikroORM.init(config);
    await orm.getSchemaGenerator().ensureDatabase();
    await orm.getSchemaGenerator().updateSchema({ wrap: false });
    logger.info("MikroORM initialized");
    return orm;
}

export default config;
