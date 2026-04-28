import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/** Persisted DirectMintingExecuted event from the AssetManager contract. */
@Entity({ tableName: "direct_minting_executed_event" })
export class DirectMintingExecutedEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property()
    transactionId: string;

    @Property()
    targetAddress: string;

    @Property()
    executor: string;

    @Property({ columnType: "text" })
    mintedAmountUBA: string;

    @Property({ columnType: "text" })
    mintingFeeUBA: string;

    @Property({ columnType: "text" })
    executorFeeUBA: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true })
    txhash?: string;

    @Property()
    fasset: string;

    constructor(
        transactionId: string,
        targetAddress: string,
        executor: string,
        mintedAmountUBA: string,
        mintingFeeUBA: string,
        executorFeeUBA: string,
        timestamp: number,
        txhash: string,
        fasset: string
    ) {
        this.transactionId = transactionId;
        this.targetAddress = targetAddress;
        this.executor = executor;
        this.mintedAmountUBA = mintedAmountUBA;
        this.mintingFeeUBA = mintingFeeUBA;
        this.executorFeeUBA = executorFeeUBA;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
    }
}
