import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { initializeMikroORM } from "./utils/mikro-orm.config";
import { logger } from "./logger/winston.logger";
import { WinstonModule } from "nest-winston";
import * as fs from "fs";
import { ChainAccount, SecretsFile } from "./utils/constants";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export async function bootstrap() {
    const port = process.env.LISTEN_PORT;
    await initializeMikroORM();
    let pathForConfig = process.env.BOT_CONFIG_PATH;
    if (!pathForConfig) {
        pathForConfig = process.env.APP_TYPE == "dev" ? "coston-bot.json" : "songbird-bot.json";
    }
    const filePathConfig = join(__dirname, "../", "src", pathForConfig);
    const configFile = readFileSync(filePathConfig, "utf-8");
    const configContent = JSON.parse(configFile);
    if (process.env.XRP_INDEXER_URLS) {
        const urlsArray = process.env.XRP_INDEXER_URLS.split(",");
        if (process.env.APP_TYPE == "dev") {
            configContent.fAssets.FTestXRP.indexerUrls = urlsArray;
        } else {
            configContent.fAssets.FXRP.indexerUrls = urlsArray;
        }
    }
    if (process.env.RPC_URL) {
        configContent.rpcUrl = process.env.RPC_URL;
    }
    if (process.env.DAL_URLS) {
        const urlsArray = process.env.DAL_URLS.split(",");
        configContent.dataAccessLayerUrls = urlsArray;
    }
    if (process.env.XRP_WALLET_URLS) {
        const urlsArray = process.env.XRP_WALLET_URLS.split(",");
        if (process.env.APP_TYPE == "dev") {
            configContent.fAssets.FTestXRP.walletUrls = urlsArray;
        } else {
            configContent.fAssets.FXRP.walletUrls = urlsArray;
        }
    }
    writeFileSync(filePathConfig, JSON.stringify(configContent, null, 4), "utf-8");
    if (Number(process.env.CREATE_SECRETS) == 1) {
        const secrets: SecretsFile = { apiKey: {} };
        if (process.env.VERIFIER_API_KEY) {
            const urlsArray = process.env.VERIFIER_API_KEY.split(",");
            secrets.apiKey.indexer = urlsArray;
        }
        if (process.env.DAL_API_KEY) {
            const urlsArray = process.env.DAL_API_KEY.split(",");
            secrets.apiKey.data_access_layer = urlsArray;
        }
        if (process.env.XRP_RPC) {
            const urlsArray = process.env.XRP_RPC.split(",");
            secrets.apiKey.xrp_rpc = urlsArray;
        }
        if (process.env.NATIVE_RPC) {
            secrets.apiKey.native_rpc = process.env.NATIVE_RPC;
        }
        const result: { [key: string]: ChainAccount } = {};
        if (process.env.NATIVE_PUB_ADDR && process.env.NATIVE_PRIV_KEY) {
            result.native = {
                address: process.env.NATIVE_PUB_ADDR,
                private_key: process.env.NATIVE_PRIV_KEY,
            };
        }
        if (process.env.XRP_PUB_ADDR && process.env.XRP_PRIV_KEY) {
            const chain = process.env.APP_TYPE == "dev" ? "testXRP" : "XRP";
            result[chain] = {
                address: process.env.XRP_PUB_ADDR,
                private_key: process.env.XRP_PRIV_KEY,
            };
        }
        if (process.env.WALLET_ENCRYPTION) {
            secrets.wallet = {
                encryption_password: process.env.WALLET_ENCRYPTION,
            };
        }
        secrets.user = result;
        const json = JSON.stringify(secrets, null, 4);
        fs.writeFile("./src/secrets.json", json, (err) => {
            if (err) throw err;
            fs.chmod("./src/secrets.json", 0o600, (err) => {
                if (err) throw err;
                console.log("File created and permissions set to 600");
            });
        });
    }
    const app = await NestFactory.create(AppModule, {
        cors: true,
        logger: WinstonModule.createLogger({
            instance: logger,
        }),
    });
    app.use(helmet());

    const config = new DocumentBuilder().setTitle("Fasset user").setDescription("Fasset user backend APIs").setVersion("1.0").build();
    const document = SwaggerModule.createDocument(app, config);
    const rootPath = process.env.ROOT_PATH || "";
    app.setGlobalPrefix(rootPath);
    SwaggerModule.setup(rootPath + "api-doc", app, document);
    fs.writeFileSync("./swagger-docs/swagger.json", JSON.stringify(document));

    await app.listen(port, "0.0.0.0");
    logger.info(`Server is listening on port: ${port}`);
}
