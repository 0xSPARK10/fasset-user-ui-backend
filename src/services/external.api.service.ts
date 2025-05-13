import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import https from "https";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { AddressBTC, FeeBTC, IndexerApiResponse, TransactionBTC, UTXOBTCXPUB, XpubBTC } from "src/interfaces/structure";
import { lastValueFrom } from "rxjs";
import { logger } from "src/logger/winston.logger";
import { LotsException } from "src/exceptions/lots.exception";
import { NETWORK_SYMBOLS } from "src/utils/constants";

@Injectable()
export class ExternalApiService {
    private btcIndexer: string;
    private dogeIndexer: string;
    private username: string;
    private password: string;
    private apiUrl: string;
    private envType: string;
    private dogeBBKey: string;
    private btcBBKey: string;
    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService
    ) {
        this.btcIndexer = this.configService.get<string>("BTC_INDEXER");
        this.dogeIndexer = this.configService.get<string>("DOGE_INDEXER");
        this.username = this.configService.get<string>("USER_API");
        this.password = this.configService.get<string>("PASS_API");
        this.apiUrl = this.configService.get<string>("API_URL");
        this.envType = this.configService.get<string>("APP_TYPE");
        this.dogeBBKey = this.configService.get<string>("DOGE_KEY");
        this.btcBBKey = this.configService.get<string>("BTC_KEY");
    }

    private getAuthHeaders(): AxiosRequestConfig["headers"] {
        return {
            Authorization: "Basic " + Buffer.from(`${this.username}:${this.password}`).toString("base64"),
            "Content-Type": "application/json",
        };
    }

    async getMints(vaultAddress: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/agent-minting-executed-count?agent=" + vaultAddress, { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in minting executed count`, error);
            return 0;
        }
    }

    async getRedemptionSuccessRate(vaultAddress: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/agent-redemption-success-rate?agent=" + vaultAddress, { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in redemption success rate`, error);
            return 0;
        }
    }

    async getLiquidationCount(vaultAddress: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/agent-performed-liquidation-count?agent=" + vaultAddress, { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in get liquidation count`, error);
            return 0;
        }
    }

    async getDefaultEvent(fasset: string, requestId: string): Promise<IndexerApiResponse> {
        if (this.apiUrl == undefined) {
            throw new LotsException("No api in .env");
        }
        try {
            const netw = NETWORK_SYMBOLS.find((item) => (this.envType == "dev" ? item.test : item.real) === fasset);
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/redemption-default?id=" + requestId + "&fasset=" + netw.real, { headers: this.getAuthHeaders() })
            );
            return data.data;
        } catch (error) {
            logger.error(`Error in redemption default`, error);
            throw error;
        }
    }

    private getBlockBookAxiosDOGE(): AxiosInstance {
        const agent = new https.Agent({ rejectUnauthorized: false });

        const axiosInstance = axios.create({
            httpsAgent: agent, // Use the Agent in the Axios instance configuration,
            headers: {
                "x-apikey": this.dogeBBKey,
                "x-api-key": this.dogeBBKey,
            },
        });
        return axiosInstance;
    }

    private getBlockBookAxiosBTC(): AxiosInstance {
        const agent = new https.Agent({ rejectUnauthorized: false });

        const axiosInstance = axios.create({
            httpsAgent: agent, // Use the Agent in the Axios instance configuration,
            headers: {
                "x-apikey": this.btcBBKey,
                "x-api-key": this.btcBBKey,
            },
        });
        return axiosInstance;
    }

    async getBalancesBlockBook(fasset: string, address: string) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2/balancehistory/${address}`);
            //console.log(response.data);
            return response.data as TransactionBTC[];
        } catch (error) {
            // Handle errors
            logger.error("Error fetching balance history:", error);
            throw error;
        }
    }

    async getFeeEstimation(fasset: string, blocks: number) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2/estimatefee/${blocks}`);
            //console.log(response.data);
            return response.data.result as string;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching fee in blocks:", error);
            throw error;
        }
    }

    async getFeeEstimationBlockHeight(fasset: string, blockHeight: number) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2/feestats/${blockHeight}`);
            return response.data as FeeBTC;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching fee for blockheight:", error);
            throw error;
        }
    }

    //Get basic xpub info from blockbook
    async getXpubBalanceBlockBook(fasset: string, address: string) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2/xpub/${address}?details=basic`);
            //console.log(response.data);
            return response.data as XpubBTC;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching xpub balance block book:", error);
            throw error;
        }
    }

    async getUtxosBlockBook(fasset: string, address: string, confirmed: boolean) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        const endp = confirmed ? `${indexer}/api/v2/utxo/${address}?confirmed=true` : `${indexer}/api/v2/utxo/${address}`;
        try {
            const response = await axiosInstance.get(endp);
            if (fasset.includes("BTC")) {
                const data = response.data as UTXOBTCXPUB[];
                return data.filter((utxo) => Number(utxo.confirmations) >= 6);
            }
            return response.data as UTXOBTCXPUB[];
        } catch (error) {
            // Handle errors
            logger.error("Error fetching utxo:", error);
            throw error;
        }
    }

    async submitTX(fasset: string, tx: string) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2/sendtx/${tx}`);
            //console.log(response.data);
            return response.data.result as string;
        } catch (error) {
            // Handle errors
            logger.error("Error submitting tx:", error.response.data);
            throw error.response.data;
        }
    }

    async getTransactionHexBlockBook(fasset: string, txid: string) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2/tx/${txid}`);
            return response.data.hex as string;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching tx:", error);
            throw error;
        }
    }

    async getAddressInfoBlockBook(fasset: string, address: string) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2/address/${address}?details=basic`);
            return response.data as AddressBTC;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching balance history:", error);
            throw error;
        }
    }

    async getBlockBookHeight(fasset: string) {
        const axiosInstance = fasset.includes("BTC") ? this.getBlockBookAxiosBTC() : this.getBlockBookAxiosDOGE();
        const indexer = fasset.includes("BTC") ? this.btcIndexer : this.dogeIndexer;
        try {
            const response = await axiosInstance.get(`${indexer}/api/v2`);
            return response.data.blockbook.bestHeight as string;
        } catch (error) {
            // Handle errors
            logger.error("Error fetching blockbook height:", error);
            throw error;
        }
    }

    async getNumberOfTransactions(): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(this.httpService.get(this.apiUrl + "/dashboard/transaction-count", { headers: this.getAuthHeaders() }));
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in number of transactions count`, error);
            return 0;
        }
    }

    //Change so its not hardcoded
    /*async getLifetimeClaimed(address: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return { FTestXRP: 0, FTestBTC: 0 };
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/indexer/total-claimed-fasset-fees?user=" + address, { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return { FTestXRP: data.data.data.fXrp, FTestBTC: data.data.data.fBtc };
        } catch (error) {
            logger.error(`Error in total claimed`, error);
            return 0;
        }
    }*/

    async getFassetSupplyDiff(start: string, end: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/fasset-supply?timestamps=" + start + "&timestamps=" + end, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in fasset supply diff`, error);
            return 0;
        }
    }

    async getCollectedPoolFeesDiff(start: string, end: string, pool: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/claimed-pool-fees?pool=" + pool + "&timestamps=" + start + "&timestamps=" + end, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in pool fees diff`, error);
            return 0;
        }
    }

    async getPoolCollateralDiff(start: string, end: string, pool: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/pool-collateral?pool=" + pool + "&timestamps=" + start + "&timestamps=" + end, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in pool fees diff`, error);
            return 0;
        }
    }

    async getPoolTransactionCount(): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/collateral-pool-transactions-count", { headers: this.getAuthHeaders() })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in get pool transaction count`, error);
            return 0;
        }
    }

    async getBestPerformingPools(n: number, minNatWei: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/best-performing-collateral-pools?n=" + n.toString() + "&minNatWei=" + minNatWei, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get best performing pools`, error);
            return 0;
        }
    }

    async getUserCollateralPoolTokens(address: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/user-collateral-pool-token-portfolio?user=" + address, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get user collateral pool tokens`, error);
            return 0;
        }
    }

    async getUserTotalClaimedPoolFees(address: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/total-claimed-pool-fees?user=" + address, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get user total claimed pool fees`, error);
            return 0;
        }
    }

    async getUserTotalClaimedPoolFeesSpecific(address: string, pool: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/total-claimed-pool-fees?user=" + address + "&pool=" + pool, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get user total claimed pool fees specific`, error);
            return 0;
        }
    }

    async getTotalClaimedPoolFees(): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/total-claimed-pool-fees?", {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get total claimed pool fees`, error);
            return 0;
        }
    }

    async getMintTimeseries(endtime: number, npoints: number, startTime: number): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timeseries/minted?endtime=" + endtime + "&npoints=" + npoints + "&startTime=" + startTime, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get mint timeseries`, error);
            return 0;
        }
    }

    async getRedeemTimeseries(endtime: number, npoints: number, startTime: number): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timeseries/redeemed?endtime=" + endtime + "&npoints=" + npoints + "&startTime=" + startTime, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get redeem timeseries`, error);
            return 0;
        }
    }

    async getHolderCount(): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/fasset-holder-count", {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get holder count`, error);
            return 0;
        }
    }

    async getTotalPoolCollateralDiff(start: string, end: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/pool-collateral?&timestamps=" + start + "&timestamps=" + end, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in pool fees diff`, error);
            return 0;
        }
    }

    async getTotalLiquidationCount(): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/performed-liquidation-count", {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in get liq count`, error);
            return 0;
        }
    }

    async getTotalMintCount(): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/minting-executed-count?", {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data.amount;
        } catch (error) {
            logger.error(`Error in get liq count`, error);
            return 0;
        }
    }

    async getTotalRedeemedLots(): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(this.httpService.get(this.apiUrl + "/dashboard/total-redeemed-lots", { headers: this.getAuthHeaders() }));
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get pool transaction count`, error);
            return 0;
        }
    }

    async getCVInflowTimeseries(endtime: number, npoints: number, startTime: number): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(
                    this.apiUrl + "/dashboard/timeseries/core-vault-inflow?endtime=" + endtime + "&npoints=" + npoints + "&startTime=" + startTime,
                    {
                        headers: this.getAuthHeaders(),
                    }
                )
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get cv inflow timeseries`, error);
            return 0;
        }
    }

    async getCVOutflowTimeSeries(endtime: number, npoints: number, startTime: number): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(
                    this.apiUrl + "/dashboard/timeseries/core-vault-outflow?endtime=" + endtime + "&npoints=" + npoints + "&startTime=" + startTime,
                    {
                        headers: this.getAuthHeaders(),
                    }
                )
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV outflow timeseries`, error);
            return 0;
        }
    }

    async getCVInflows(timeStamp: number): Promise<any> {
        if (this.apiUrl == undefined) {
            return [{ value: "0" }];
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/core-vault-inflows?timestamps=" + timeStamp, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return [{ value: "0" }];
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV inflows`, error);
            return [{ value: "0" }];
        }
    }

    async getCVOutflows(timeStamp: number): Promise<any> {
        if (this.apiUrl == undefined) {
            return [{ value: "0" }];
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/core-vault-outflows?timestamps=" + timeStamp, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return [{ value: "0" }];
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV outflows`, error);
            return [{ value: "0" }];
        }
    }

    async getCVInflowsDiff(start: string, end: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/core-vault-inflows?&timestamps=" + start + "&timestamps=" + end, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV inflows diff`, error);
            return 0;
        }
    }

    async getCVOutflowsDiff(start: string, end: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/core-vault-outflows?&timestamps=" + start + "&timestamps=" + end, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV outflows diff`, error);
            return 0;
        }
    }

    async getCVTotalDiff(start: string, end: string): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/core-vault-balance-usd?&timestamps=" + start + "&timestamps=" + end, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV total diff`, error);
            return 0;
        }
    }

    async getCVTVL(endtime: number, npoints: number, startTime: number): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const data = await lastValueFrom(
                this.httpService.get(
                    this.apiUrl + "/dashboard/timeseries/core-vault-tvl?endtime=" + endtime + "&npoints=" + npoints + "&startTime=" + startTime,
                    {
                        headers: this.getAuthHeaders(),
                    }
                )
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV tvl timeseries`, error);
            return 0;
        }
    }

    async getCVTotalBalanceTimestamps(timestamps: string[]): Promise<any> {
        if (this.apiUrl == undefined) {
            return 0;
        }
        try {
            const url = timestamps.map((t) => `&timestamps=${t}`).join("");
            const data = await lastValueFrom(
                this.httpService.get(this.apiUrl + "/dashboard/timespan/core-vault-balance-usd?" + url, {
                    headers: this.getAuthHeaders(),
                })
            );
            if (data.data.status == 500) {
                return 0;
            }
            return data.data.data;
        } catch (error) {
            logger.error(`Error in get CV total balance timestamps`, error);
            return 0;
        }
    }
}
