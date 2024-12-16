import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "full_redemption" })
export class FullRedemption {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    txhash: string;

    @Property()
    processed: boolean;

    @Property()
    fasset: string;

    @Property()
    userAddress: string;

    @Property()
    amount: string;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(txhash: string, processed: boolean, fasset: string, userAddress: string, amount: string, timestamp: number) {
        this.txhash = txhash;
        this.processed = processed;
        this.fasset = fasset;
        this.userAddress = userAddress;
        this.amount = amount;
        this.timestamp = timestamp;
    }
}
