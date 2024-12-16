import { Options, MikroORM } from "@mikro-orm/core";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { SqliteDriver } from "@mikro-orm/sqlite";
import { Liveness } from "src/entities/AgentLiveness";
import { CollateralReservationEvent } from "src/entities/CollateralReservation";
import { CrRejectedCancelledEvent } from "src/entities/CollateralReservationRejected";
import { Collateral } from "src/entities/Collaterals";
import { HandshakeEvent } from "src/entities/Handshake";
import { Minting } from "src/entities/Minting";
import { Pool } from "src/entities/Pool";
import { Redemption } from "src/entities/Redemption";
import { RedemptionDefault } from "src/entities/RedemptionDefault";
import { RedemptionDefaultEvent } from "src/entities/RedemptionDefaultEvent";
import { IncompleteRedemption } from "src/entities/RedemptionIncomplete";
import { RedemptionRejected } from "src/entities/RedemptionRejected";
import { RedemptionRequested } from "src/entities/RedemptionRequested";
import { RedemptionTakenOver } from "src/entities/RedemptionTakenOver";
import { FullRedemption } from "src/entities/RedemptionWhole";
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
            HandshakeEvent,
            CrRejectedCancelledEvent,
            RedemptionRejected,
            RedemptionRequested,
            RedemptionTakenOver,
            RedemptionDefaultEvent,
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
            HandshakeEvent,
            CrRejectedCancelledEvent,
            RedemptionRejected,
            RedemptionRequested,
            RedemptionTakenOver,
            RedemptionDefaultEvent,
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
