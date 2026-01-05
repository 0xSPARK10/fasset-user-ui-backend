import { toBNExp } from "@flarelabs/fasset-bots-core/utils";
import { ProofOfReserve, SupplyTotalCollateral } from "src/interfaces/structure";

export const EXECUTION_FEE = toBNExp(2.5, 18);
export const STATE_CONNECTOR_ADDRESS = "0x0c13aDA1C7143Cf0a0795FFaB93eEBb6FAD6e4e3";

export const PROOF_OF_RESERVE: ProofOfReserve = { total: "0", totalUSD: "0", reserve: "0", reserveUSD: "0", ratio: "0" };

export const EMPTY_SUPPLY_BY_COLLATERAL: SupplyTotalCollateral[] = [
    { symbol: "FLR", supply: "0", supplyUSD: "0" },
    { symbol: "USDT", supply: "0", supplyUSD: "0" },
];

export enum RedemptionStatusEnum {
    EXPIRED = "EXPIRED",
    SUCCESS = "SUCCESS",
    DEFAULT = "DEFAULT",
    PENDING = "PENDING",
}

export const NETWORK_SYMBOLS = [
    { symbol: "XRP", real: "FXRP", test: "FTestXRP" },
    { symbol: "BTC", real: "FBTC", test: "FTestBTC" },
    { symbol: "DOGE", real: "FDOGE", test: "FTestDOGE" },
];

export interface ChainAccount {
    address: string;
    private_key: string;
}

export interface DatabaseAccount {
    user: string;
    password: string;
}

export type SecretsFile = {
    wallet?: {
        encryption_password: string;
    };
    apiKey: {
        [key: string]: string | string[];
    };
    owner?: {
        [key: string]: ChainAccount;
    };
    user?: {
        [key: string]: ChainAccount;
    };
    requestSubmitter?: ChainAccount;
    challenger?: ChainAccount;
    liquidator?: ChainAccount;
    timeKeeper?: ChainAccount;
    systemKeeper?: ChainAccount;
    deployer?: ChainAccount;
    database?: DatabaseAccount;
    pricePublisher?: ChainAccount;
};

export const TEN_MINUTES = 10 * 60 * 1000;

export const FILTER_AGENT = "0x09011d2A11A40DB855Cb00B3AA5a0F5F3bd485FD".toLowerCase();
