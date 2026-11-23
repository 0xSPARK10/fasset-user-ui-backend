import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";
import { logger } from "src/logger/winston.logger";

/** Bound one smart-backend request so later candidates can still be processed. */
const SMART_STATUS_TIMEOUT_MS = 10_000;

export interface SmartDirectMintStatusResponse {
    type?: unknown;
    status?: unknown;
    action?: { destination_eid?: unknown; destination_kind?: unknown } | null;
}

export function getBridgeDestinationEid(response: SmartDirectMintStatusResponse | null): number | null {
    const eid = response?.type === "BRIDGE" ? response.action?.destination_eid : null;
    return typeof eid === "number" && Number.isInteger(eid) && eid > 0 ? eid : null;
}

export function getBridgeDestinationKind(response: SmartDirectMintStatusResponse | null): string | null {
    const kind = response?.type === "BRIDGE" ? response.action?.destination_kind : null;
    return typeof kind === "string" && kind.trim().length > 0 ? kind : null;
}

@Injectable()
export class SmartAccountsService {
    private client: AxiosInstance | null = null;

    constructor(private readonly configService: ConfigService) {
        const network = this.configService.get<string>("NETWORK");
        const smartAccountsApiUrl = this.configService.get<string>("SMART_ACCOUNTS_API_URL")?.trim();
        if ((network === "flare" || network === "coston2") && smartAccountsApiUrl) {
            this.client = axios.create({
                baseURL: smartAccountsApiUrl,
                timeout: SMART_STATUS_TIMEOUT_MS,
            });
        }
    }

    async getDirectMintStatus(txhash: string): Promise<SmartDirectMintStatusResponse | null> {
        const hash = txhash.replace(/^0x/i, "");
        if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
            logger.error(`Cannot reconcile smart status for invalid stored XRP hash ${txhash}`);
            return null;
        }
        const canonicalTxHash = `0x${hash.toUpperCase()}`;
        if (!this.client) {
            logger.error(`Cannot reconcile smart status for ${canonicalTxHash}: SMART_ACCOUNTS_API_URL client is not configured`);
            return null;
        }

        try {
            const response = await this.client.get<SmartDirectMintStatusResponse>(`/api/v3/direct_mint/shortStatus/${canonicalTxHash}`);
            if (!response.data || typeof response.data !== "object") {
                logger.warn(`Smart-status response for ${canonicalTxHash} has an unexpected shape`);
                return null;
            }
            return response.data;
        } catch (error) {
            this.logSmartStatusError(canonicalTxHash, error);
            return null;
        }
    }

    private logSmartStatusError(txhash: string, error: unknown): void {
        if (!axios.isAxiosError(error)) {
            logger.error(`Unexpected smart-status error for ${txhash}:`, error);
            return;
        }

        const status = error.response?.status;
        if (status === 400) {
            logger.error(`Smart-status request for ${txhash} returned 400; check XRP hash canonicalization and integration configuration`);
        } else if (status === 404) {
            logger.warn(`Smart-status request for ${txhash} returned 404; the transaction may not be projected yet`);
        } else if (status === 429 || (status !== undefined && status >= 500) || error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
            logger.warn(`Transient smart-status request failure for ${txhash}${status === undefined ? "" : ` (HTTP ${status})`}`);
        } else {
            logger.warn(`Smart-status request failed for ${txhash}${status === undefined ? "" : ` (HTTP ${status})`}`);
        }
    }
}
