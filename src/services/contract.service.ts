import { Injectable } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import {
    IWNat__factory,
    IRelay__factory,
    IFdcHub__factory,
    IFdcVerification__factory,
    IERC20__factory,
    CollateralPool__factory,
    AssetManagerControllerProxy__factory,
    CoreVaultManagerProxy__factory,
    IIAssetManager__factory,
    IAgentOwnerRegistry__factory,
    ICollateralPool__factory,
    ICollateralPoolToken__factory,
    IPriceReader__factory,
    IFAsset__factory,
    MintingTagManager__factory,
    IMasterAccountController__factory,
} from "../typechain-ethers-v6";
import type {
    ICollateralPool,
    ICollateralPoolToken,
    IPriceReader,
    IIAssetManager,
    IFAsset,
    MintingTagManager,
    IMasterAccountController,
} from "../typechain-ethers-v6";
import { EthersService } from "./ethers.service";
import { ConfigService } from "@nestjs/config";

interface DeploymentEntry {
    name: string;
    contractName: string;
    address: string;
}

@Injectable()
export class ContractService {
    private contracts = new Map<string, any>();

    constructor(
        private readonly configService: ConfigService,
        private readonly ethersService: EthersService
    ) {
        const network = this.configService.get<string>("NETWORK", "coston2");
        const deploymentsPath = join(__dirname, "../../deploys", `${network}.json`);
        const deployments: DeploymentEntry[] = JSON.parse(readFileSync(deploymentsPath, "utf-8"));

        for (const deployment of deployments) {
            const contract = this.instantiateContract(deployment);
            if (contract) {
                this.contracts.set(deployment.name, contract);
            }
        }
    }

    private instantiateContract(deployment: DeploymentEntry) {
        const { name, address, contractName } = deployment;
        const signer = this.ethersService.getSigner();
        console.log("Initializing " + name + " contract");
        switch (contractName) {
            case "WNat.sol":
                return IWNat__factory.connect(address, signer);

            case "Relay.sol":
                return IRelay__factory.connect(address, signer);

            case "FdcHub.sol":
                return IFdcHub__factory.connect(address, signer);

            case "FdcVerification.sol":
                return IFdcVerification__factory.connect(address, signer);

            case "IERC20.sol":
                return IERC20__factory.connect(address, signer);

            case "FtsoV2PriceStoreProxy.sol":
                return IPriceReader__factory.connect(address, signer);

            case "AgentOwnerRegistryProxy.sol":
                return IAgentOwnerRegistry__factory.connect(address, signer);

            case "CollateralPool.sol":
                return CollateralPool__factory.connect(address, signer);

            case "AssetManagerControllerProxy.sol":
                return AssetManagerControllerProxy__factory.connect(address, signer);

            case "AssetManager.sol":
                return IIAssetManager__factory.connect(address, signer);

            case "FAssetProxy.sol":
                return IFAsset__factory.connect(address, signer);

            case "CoreVaultManagerProxy.sol":
                return CoreVaultManagerProxy__factory.connect(address, signer);

            case "MintingTagManager.sol":
                return MintingTagManager__factory.connect(address, signer);

            case "IMasterAccountController.sol":
                return IMasterAccountController__factory.connect(address, signer);

            default:
                console.warn(`Unknown contract: ${contractName}`);
                return null;
        }
    }

    /** Typed getter */
    get<T>(name: string): T {
        const contract = this.contracts.get(name);
        if (!contract) {
            throw new Error(`Contract ${name} not initialized`);
        }
        return contract as T;
    }

    getCollateralPoolContract(address: string): ICollateralPool {
        const provider = this.ethersService.getProvider();
        return ICollateralPool__factory.connect(address, provider);
    }

    getCollateralPoolTokenContract(address: string): ICollateralPoolToken {
        const provider = this.ethersService.getProvider();
        return ICollateralPoolToken__factory.connect(address, provider);
    }

    getAssetManagerContract(address: string): IIAssetManager {
        const provider = this.ethersService.getProvider();
        return IIAssetManager__factory.connect(address, provider);
    }

    getPriceReaderContract(address: string): IPriceReader {
        const provider = this.ethersService.getProvider();
        return IPriceReader__factory.connect(address, provider);
    }

    getFAssetContract(address: string): IFAsset {
        const provider = this.ethersService.getProvider();
        return IFAsset__factory.connect(address, provider);
    }

    /** Returns the MintingTagManager contract for a given fasset (e.g. "FTestXRP"). */
    getMintingTagManagerContract(fasset: string): MintingTagManager {
        return this.get<MintingTagManager>(`MintingTagManager_${fasset}`);
    }

    /** Returns the IMasterAccountController contract for a given fasset (e.g. "FTestXRP"). */
    getMasterAccountControllerContract(fasset: string): IMasterAccountController {
        return this.get<IMasterAccountController>(`MasterAccountController_${fasset}`);
    }

    /** Returns all registered contract names (deployment keys). */
    getContractNames(): string[] {
        return Array.from(this.contracts.keys());
    }
}
