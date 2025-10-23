import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

export enum ChainType {
    EVM = 1,
    XRP = 2,
}
export enum WalletType {
    OTHER = 0,
    METAMASK = 1,
    BIFROST = 2,
    LEDGER = 3,
    XAMAN = 4,
}

@Entity({ tableName: "wallet" })
export class Wallet {
    @PrimaryKey({ autoincrement: true })
    id: number;

    @Property({ unique: true })
    address: string;

    @Property({
        type: "int",
    })
    chainType: ChainType;

    @Property({
        type: "int",
    })
    walletType: WalletType;

    constructor(address: string, chainType: ChainType, walletType: WalletType) {
        this.address = address;
        this.chainType = chainType;
        this.walletType = walletType;
    }
}
