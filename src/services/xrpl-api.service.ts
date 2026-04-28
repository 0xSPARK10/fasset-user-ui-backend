import { Injectable, OnModuleInit } from "@nestjs/common";
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
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
    private client: AxiosInstance;
    constructor(private readonly configService: ConfigService) {}

    /** Initializes the XRPL HTTP client using XRP_WALLET_URLS and XRP_RPC env vars */
    async onModuleInit() {
        const walletUrl = (this.configService.get<string>("XRP_WALLET_URLS") || "")
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean)[0];
        const apiKey = (this.configService.get<string>("XRP_RPC") || "")
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)[0];
        this.client = axios.create(this.createAxiosConfig(walletUrl, apiKey));
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
