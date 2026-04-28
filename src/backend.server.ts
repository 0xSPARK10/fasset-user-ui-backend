import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { initializeMikroORM } from "./utils/mikro-orm.config";
import { logger } from "./logger/winston.logger";
import { WinstonModule } from "nest-winston";
import * as fs from "fs";

/** Env vars that must always be set for the app to function. */
const REQUIRED_ENV_VARS = ["LISTEN_PORT", "NETWORK", "DB_TYPE", "RPC_URL", "NATIVE_RPC"];

/** Service-specific env vars — app starts without them but features may be degraded. */
const OPTIONAL_ENV_VARS = [
    "APP_TYPE",
    "NATIVE_PUB_ADDR",
    "NATIVE_PRIV_KEY",
    "DAL_API_KEY",
    "DAL_API_KEYS",
    "XRP_WALLET_URLS",
    "XRP_RPC",
    "XRP_INDEXER_URLS",
    "VERIFIER_API_KEY",
    "API_URL",
    "EARN_JSON_URL",
];

/**
 * Validates that all required environment variables are set.
 * Throws an error listing missing required vars. Logs warnings for missing optional vars.
 */
function validateEnvVars(): void {
    const missing: string[] = [];

    // Check always-required vars
    for (const key of REQUIRED_ENV_VARS) {
        if (!process.env[key]) {
            missing.push(key);
        }
    }

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    // Warn about missing optional vars (app can still start)
    const missingOptional: string[] = [];
    for (const key of OPTIONAL_ENV_VARS) {
        if (!process.env[key]) {
            missingOptional.push(key);
        }
    }
    if (missingOptional.length > 0) {
        logger.warn(`Missing optional environment variables (some features may not work): ${missingOptional.join(", ")}`);
    }
}

export async function bootstrap() {
    validateEnvVars();
    const port = process.env.LISTEN_PORT;
    await initializeMikroORM();
    const app = await NestFactory.create(AppModule, {
        cors: true,
        logger: WinstonModule.createLogger({
            instance: logger,
        }),
    });
    app.use(helmet());

    const config = new DocumentBuilder()
        .setTitle("Fasset user")
        .setDescription("Fasset user backend APIs")
        .setVersion("1.0")
        .addApiKey(
            {
                type: "apiKey",
                name: "x-api-key",
                in: "header",
            },
            "api_key"
        )
        .build();
    const document = SwaggerModule.createDocument(app, config);
    const rootPath = process.env.ROOT_PATH || "";
    app.setGlobalPrefix(rootPath);
    SwaggerModule.setup(rootPath + "api-doc", app, document);
    fs.writeFileSync("./swagger-docs/swagger.json", JSON.stringify(document));

    await app.listen(port, "0.0.0.0");
    logger.info(`Server is listening on port: ${port}`);
}
