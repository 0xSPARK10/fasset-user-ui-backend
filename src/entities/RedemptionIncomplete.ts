import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "incomplete_redemption" })
export class IncompleteRedemption {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    txhash: string;

    @Property()
    redeemer: string;

    @Property()
    remainingLots: string;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(txhash: string, redeemer: string, remainingLots: string, timestamp: number) {
        this.txhash = txhash;
        this.redeemer = redeemer;
        this.remainingLots = remainingLots;
        this.timestamp = timestamp;
    }
}
