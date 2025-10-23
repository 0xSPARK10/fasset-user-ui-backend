import { Injectable } from "@nestjs/common";
import { Wallet } from "src/entities/Wallet";
import { EntityManager } from "@mikro-orm/core";

@Injectable()
export class WalletService {
    constructor(private readonly em: EntityManager) {}

    async getPaginatedWallets(offset: number, limit: number) {
        const [data, total] = await this.em.findAndCount(Wallet, {}, { offset, limit });
        return {
            count: total,
            offset,
            limit,
            data,
        };
    }
}
