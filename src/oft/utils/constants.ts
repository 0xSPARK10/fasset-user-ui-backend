import { ethers, Interface } from "ethers";

export interface OFTConfig {
    OFTAdapterAddress: string;
    FAssetRedeemComposerAddress: string;
    HypeComposerAddress: string;
    AssetManagerAddress: string;
    EndpointV2Address: string;
}

export interface OFTLogs {
    oftSent: ethers.Log[];
    oftReceived: ethers.Log[];
    fAssetRedeemed: ethers.Log[];
    redemptionRequested: ethers.Log[];
    packetSent: ethers.Log[];
    composeDelivered: ethers.Log[];
    fAssetRedeemFailed: ethers.Log[];
    // AssetManager `RedemptionWithTagRequested` events — carry the 13th `destinationTag` arg
    // emitted when a redeemer requested a tag on the source chain.
    redemptionWithTagRequested: ethers.Log[];
}

export const coston2OFTConfig: OFTConfig = {
    OFTAdapterAddress: "0xCd3d2127935Ae82Af54Fc31cCD9D3440dbF46639",
    FAssetRedeemComposerAddress: "0xa10569DFb38FE7Be211aCe4E4A566Cea387023b0",
    HypeComposerAddress: "0x51fEFdD6Df806062634c253F605A270AF4Ab62Db".toLowerCase(),
    AssetManagerAddress: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
    EndpointV2Address: "0x6EDCE65403992e310A62460808c4b910D972f10f",
};

export const flareOFTConfig: OFTConfig = {
    OFTAdapterAddress: "0xd70659a6396285BF7214d7Ea9673184e7C72E07E",
    FAssetRedeemComposerAddress: "0x9692EDBB253ef6f5459A498A93E34674B333cC69",
    HypeComposerAddress: "0xe4532B497dC5cdac694CC2EdF02AFCF14C3cDBd0".toLowerCase(),
    AssetManagerAddress: "0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8",
    EndpointV2Address: "0x1a44076050125825900e736c501f859c50fE728c",
};

// Executor fee in native wei charged on top of the composer redemption on
// mainnet. Returned as `executorFee` on GET /api/oft/redemptionFees/:srcEid.
// Set to a non-zero wei value when the on-chain executor actually charges a
// fee — the FE uses this to size the native value sent with the compose tx.
// On coston2 the endpoint always returns "0" regardless of this constant.
export const EXECUTOR_FEE_WEI = "0";

export const AM_REDEMPTION_REQUESTED_EVENT = new Interface([
    "event RedemptionRequested(address indexed,address indexed,uint256 indexed,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256)",
]);

// AssetManager emits this event instead of `RedemptionRequested` when the user
// requested a destination tag. It has the same 12 fields as the plain event
// followed by a trailing `uint256 destinationTag` (args index 12).
export const AM_REDEMPTION_WITH_TAG_REQUESTED_EVENT = new Interface([
    "event RedemptionWithTagRequested(address indexed,address indexed,uint256 indexed,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256,uint256)",
]);

export const OFTAdapterEvents = new Interface([
    "event OFTReceived(bytes32 indexed,uint32,address indexed,uint256)",
    "event OFTSent(bytes32 indexed,uint32,address indexed,uint256,uint256)",
]);

export const EndpointV2Events = new Interface(["event ComposeDelivered(address,address,bytes32,uint16)", "event PacketSent(bytes,bytes,address)"]);

export const FAssetRedeemComposerEvents = new Interface([
    // guid, srcEid, redeemer, redeemerAccount, amountToRedeemUBA,
    // redeemerUnderlyingAddress, redeemWithTag, destinationTag,
    // executor, executorFee, redeemedAmountUBA
    "event FAssetRedeemed(bytes32 indexed,uint32 indexed,address indexed,address,uint256,string,bool,uint256,address,uint256,uint256,uint256)",
    // guid, srcEid, redeemer, redeemerAccount, amountToRedeemUBA, wrappedAmount
    "event FAssetRedeemFailed(bytes32 indexed,uint32 indexed,address indexed,address,uint256,uint256)",
]);

// Updated ABI: `getExecutorData()` was removed and replaced by the view
// `defaultExecutor()` (on-chain default executor address) and `getBalances()`
// which returns the redeemer account's fAsset / stableCoin / wNat balances.
export const FAssetRedeemComposerABI = [
    "function getComposerFeePPM(uint32) view returns (uint256)",
    "function getRedeemerAccountAddress(address) view returns (address)",
    "function defaultExecutor() view returns (address)",
    "function getBalances(address) view returns (tuple(address token, uint256 balance) fAsset, tuple(address token, uint256 balance) stableCoin, tuple(address token, uint256 balance) wNat)",
];
