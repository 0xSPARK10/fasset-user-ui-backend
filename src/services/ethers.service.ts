import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ethers, FetchRequest } from "ethers";

@Injectable()
export class EthersService {
    private provider: ethers.JsonRpcProvider;
    private signer: ethers.Wallet;
    private network: string;
    private envType: string;
    private executorAddress: string;

    constructor(private readonly configService: ConfigService) {
        const rpcUrl = this.configService.get<string>("RPC_URL", "");
        const rpcKey = this.configService.get<string>("NATIVE_RPC", "");
        this.network = this.configService.get<string>("NETWORK", "coston2");
        const connection = new FetchRequest(rpcUrl);
        if (rpcKey !== undefined) {
            connection.setHeader("x-api-key", rpcKey);
            connection.setHeader("x-apikey", rpcKey);
        }
        const privateKey = this.configService.get<string>("NATIVE_PRIV_KEY", "");
        this.provider = new ethers.JsonRpcProvider(connection);
        this.signer = new ethers.Wallet(privateKey, this.provider);
        this.envType = this.configService.get<string>("APP_TYPE");
        this.executorAddress = this.configService.get<string>("NATIVE_PUB_ADDR", "");
    }

    getProvider(): ethers.JsonRpcProvider {
        return this.provider;
    }

    getSigner(): ethers.Wallet {
        return this.signer;
    }

    getExecutorAddress(): string {
        return this.executorAddress;
    }
}
