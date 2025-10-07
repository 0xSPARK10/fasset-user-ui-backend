import { Injectable, OnModuleInit } from "@nestjs/common";
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { readFileSync } from "fs";
import { join } from "path";
import { Secrets } from "@flarelabs/fasset-bots-core";
import { ConfigService } from "@nestjs/config";
import type { AccountInfoResponse } from "xrpl";

export const DEFAULT_RATE_LIMIT_OPTIONS = {
    maxRPS: 100,
    maxRequests: 1000,
    timeoutMs: 20000,
    retries: 3,
};

export interface AccountFlags {
    requireDestTag: boolean;
    depositAuth: boolean;
}

@Injectable()
export class XRPLApiService implements OnModuleInit {
    private botPath: string;
    private network: string;
    private client: AxiosInstance;
    constructor(private readonly configService: ConfigService) {
        this.botPath = this.configService.get<string>("BOT_CONFIG_PATH");
        this.network = this.configService.get<string>("NETWORK", "coston");
    }
    async onModuleInit() {
        let pathForConfig = this.botPath;
        const appType = this.configService.get<string>("APP_TYPE", "dev");
        if (!pathForConfig) {
            pathForConfig = this.network + "-bot.json";
        }
        const filePathSecrets = join(__dirname, "../..", "src", "secrets.json");
        const filePathConfig = join(__dirname, "../..", "src", pathForConfig);
        const configFileContent = readFileSync(filePathConfig, "utf-8");
        const secrets = await Secrets.load(filePathSecrets);
        const config = JSON.parse(configFileContent);
        const fassetConfig = config.fAssets[appType == "dev" ? "FTestXRP" : "FXRP"];
        const apiKey = secrets.data.apiKey.indexer[0];
        const verifier = fassetConfig.walletUrls[0];
        this.client = axios.create(this.createAxiosConfig(verifier, apiKey));
    }

    createAxiosConfig(url: string, apiKey?: string) {
        const createAxiosConfig: AxiosRequestConfig = {
            baseURL: url,
            timeout: 20000,
            headers: {
                "Content-Type": "application/json",
            },
        };
        if (apiKey) {
            createAxiosConfig.headers ??= {};
            createAxiosConfig.headers["X-API-KEY"] = apiKey;
            createAxiosConfig.headers["x-apikey"] = apiKey;
        }
        return createAxiosConfig;
    }

    async getAccountInfo(address: string): Promise<AxiosResponse<AccountInfoResponse>> {
        return this.client.post<AccountInfoResponse>("", {
            method: "account_info",
            params: [
                {
                    account: address,
                    ledger_index: "validated",
                    strict: true,
                },
            ],
        });
    }

    async accountReceiveBlocked(address: string): Promise<AccountFlags> {
        const accountInfo = await this.getAccountInfo(address);
        return {
            requireDestTag: accountInfo.data.result.account_flags?.requireDestinationTag || false,
            depositAuth: accountInfo.data.result.account_flags?.depositAuth || false,
        };
    }
}
