import { ProofOfReserve, SupplyTotalCollateral } from "src/interfaces/structure";

export const EXECUTION_FEE = 2_500_000_000_000_000_000n; // 2.5 * 10^18
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

export const TEN_MINUTES = 10 * 60 * 1000;

export const FILTER_AGENT = "0x09011d2A11A40DB855Cb00B3AA5a0F5F3bd485FD".toLowerCase();

// Executor info used on songbird network in place of calling
// MasterAccountController.getExecutorInfo(). Fill in when deployed.
export const SONGBIRD_EXECUTOR_ADDRESS = "0x02954e158Be2b477E1C26F31e8AA0c21b378445C";
export const SONGBIRD_EXECUTOR_FEE = "2500000000000000000";
