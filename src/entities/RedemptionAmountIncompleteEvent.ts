import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/** Persisted RedemptionAmountIncomplete event from the AssetManager contract. */
@Entity({ tableName: "redemption_amount_incomplete_event" })
export class RedemptionAmountIncompleteEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property()
    redeemer: string;

    @Property({ columnType: "text" })
    remainingAmountUBA: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true })
    txhash?: string;

    @Property({ nullable: true })
    fasset?: string;

    constructor(
        redeemer: string,
        remainingAmountUBA: string,
        timestamp: number,
        txhash: string,
        fasset: string
    ) {
        this.redeemer = redeemer;
        this.remainingAmountUBA = remainingAmountUBA;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
    }
}
