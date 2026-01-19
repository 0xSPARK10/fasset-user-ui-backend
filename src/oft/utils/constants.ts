import { ethers, Interface } from "ethers";

export interface OFTConfig {
    OFTAdapterAddress: string;
    OFTComposerContractAddress: string;
    HypeComposerAddress: string;
    AssetManagerAddress: string;
    EndpointV2Address: string;
}

export interface OFTLogs {
    oftSent: ethers.Log[];
    oftReceived: ethers.Log[];
    redemptionTriggered: ethers.Log[];
    redemptionRequested: ethers.Log[];
    packetSent: ethers.Log[];
    composeDelivered: ethers.Log[];
}

export const coston2OFTConfig: OFTConfig = {
    OFTAdapterAddress: "0xCd3d2127935Ae82Af54Fc31cCD9D3440dbF46639",
    OFTComposerContractAddress: "0xF32eB6bf2Bc005Fa85eb61dBdc55Fcd60054B281",
    HypeComposerAddress: "0x51fEFdD6Df806062634c253F605A270AF4Ab62Db".toLowerCase(),
    AssetManagerAddress: "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA",
    EndpointV2Address: "0x6EDCE65403992e310A62460808c4b910D972f10f",
};

export const flareOFTConfig: OFTConfig = {
    OFTAdapterAddress: "0xd70659a6396285BF7214d7Ea9673184e7C72E07E",
    OFTComposerContractAddress: "0xF32eB6bf2Bc005Fa85eb61dBdc55Fcd60054B281",
    HypeComposerAddress: "0xe4532B497dC5cdac694CC2EdF02AFCF14C3cDBd0".toLowerCase(),
    AssetManagerAddress: "0x2a3Fe068cD92178554cabcf7c95ADf49B4B0B6A8",
    EndpointV2Address: "0x1a44076050125825900e736c501f859c50fE728c",
};

export const AM_REDEMPTION_REQUESTED_EVENT = new Interface([
    "event RedemptionRequested(address indexed,address indexed,uint256 indexed,string,uint256,uint256,uint256,uint256,uint256,bytes32,address,uint256)",
]);

export const OFTAdapterEvents = new Interface([
    "event OFTReceived(bytes32 indexed,uint32,address indexed,uint256)",
    "event OFTSent(bytes32 indexed,uint32,address indexed,uint256,uint256)",
]);

export const EndpointV2Events = new Interface(["event ComposeDelivered(address,address,bytes32,uint16)", "event PacketSent(bytes,bytes,address)"]);

export const ComposerEvents = new Interface(["event RedemptionTriggered(address indexed,string,uint256 indexed,uint256 indexed)"]);
