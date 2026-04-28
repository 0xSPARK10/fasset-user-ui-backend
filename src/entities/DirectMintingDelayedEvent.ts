import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/** Persisted DirectMintingDelayed event from the AssetManager contract. */
@Entity({ tableName: "direct_minting_delayed_event" })
export class DirectMintingDelayedEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property()
    transactionId: string;

    @Property({ columnType: "text" })
    amount: string;

    @Property({ type: "bigint" })
    executionAllowedAt: number;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true })
    txhash?: string;

    @Property()
    fasset: string;

    constructor(
        transactionId: string,
        amount: string,
        executionAllowedAt: number,
        timestamp: number,
        txhash: string,
        fasset: string
    ) {
        this.transactionId = transactionId;
        this.amount = amount;
        this.executionAllowedAt = executionAllowedAt;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
    }
}
