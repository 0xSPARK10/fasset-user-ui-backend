import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/** Persisted DirectMintingExecutedToSmartAccount event from the AssetManager contract. */
@Entity({ tableName: "direct_minting_executed_to_smart_account_event" })
export class DirectMintingExecutedToSmartAccountEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property()
    transactionId: string;

    @Property()
    sourceAddress: string;

    @Property()
    executor: string;

    @Property({ columnType: "text" })
    mintedAmountUBA: string;

    @Property({ columnType: "text" })
    mintingFeeUBA: string;

    @Property({ nullable: true, type: "text" })
    memoData?: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true })
    txhash?: string;

    @Property()
    fasset: string;

    constructor(
        transactionId: string,
        sourceAddress: string,
        executor: string,
        mintedAmountUBA: string,
        mintingFeeUBA: string,
        memoData: string,
        timestamp: number,
        txhash: string,
        fasset: string
    ) {
        this.transactionId = transactionId;
        this.sourceAddress = sourceAddress;
        this.executor = executor;
        this.mintedAmountUBA = mintedAmountUBA;
        this.mintingFeeUBA = mintingFeeUBA;
        this.memoData = memoData;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
    }
}
