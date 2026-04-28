/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFileSync } from "fs";
import { join } from "path";
import { VerifierService, ChainId } from "./verifier.service";

export interface Fasset {
    chainId: string;
    tokenName: string;
    tokenSymbol: string;
    tokenDecimals: number;
}

@Injectable()
export class FassetConfigService {
    private fassets = new Map<string, Fasset>();
    private fassetNames: string[] = [];
    private nativeSymbol: string;
    private verifiers = new Map<string, VerifierService>();
    private dalUrls: string[] = [];
    private walletUrls = new Map<string, string[]>();

    constructor(private configService: ConfigService) {
        const network = this.configService.get<string>("NETWORK");
        const deploymentsPath = join(__dirname, "../../src/configs", `${network}.json`);
        const configFile = readFileSync(deploymentsPath, "utf-8");
        const configContent = JSON.parse(configFile);
        this.nativeSymbol = configContent.nativeSymbol;

        // Read bot config file for DAL URLs and per-fasset wallet URLs
        const botConfigPath = this.configService.get<string>("BOT_CONFIG_PATH") || `${network}-bot.json`;
        const botConfigFile = readFileSync(join(__dirname, "../..", "src", botConfigPath), "utf-8");
        const botConfig = JSON.parse(botConfigFile);
        this.dalUrls = botConfig.dataAccessLayerUrls || [];
        if (botConfig.fAssets) {
            Object.entries(botConfig.fAssets).forEach(([key, value]: [string, any]) => {
                this.walletUrls.set(key, value.walletUrls || []);
            });
        }

        const verifierUrls = (this.configService.get<string>("XRP_INDEXER_URLS") || "")
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean);
        const verifierApiKeys = (this.configService.get<string>("VERIFIER_API_KEY") || "").split(",").map((k) => k.trim());

        Object.entries(configContent.fassets).forEach(([key, value]: [string, any]) => {
            this.fassetNames.push(key);
            this.fassets.set(key, {
                chainId: value.chainId,
                tokenName: value.tokenName,
                tokenSymbol: value.tokenSymbol,
                tokenDecimals: value.tokenDecimals,
            });

            const chainId = value.chainId as ChainId;
            this.verifiers.set(key, new VerifierService(chainId, verifierUrls, verifierApiKeys));
        });
    }

    getFAssets(): Map<string, Fasset> {
        return this.fassets;
    }

    getFAssetNames(): string[] {
        return this.fassetNames;
    }

    getFAssetByName(name: string): Fasset {
        return this.fassets.get(name);
    }

    getNativeSymbol(): string {
        return this.nativeSymbol;
    }

    getVerifier(fassetName: string): VerifierService {
        const verifier = this.verifiers.get(fassetName);
        if (!verifier) {
            throw new Error(`Verifier not found for fasset ${fassetName}`);
        }
        return verifier;
    }

    /** Returns the data access layer URLs from the bot config */
    getDataAccessLayerUrls(): string[] {
        return this.dalUrls;
    }

    /** Returns the first wallet URL for a given fasset (e.g. XRPL RPC endpoint) */
    getWalletUrl(fassetName: string): string | undefined {
        const urls = this.walletUrls.get(fassetName);
        return urls?.[0];
    }
}
