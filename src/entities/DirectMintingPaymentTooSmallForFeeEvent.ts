import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/** Persisted DirectMintingPaymentTooSmallForFee event from the AssetManager contract. */
@Entity({ tableName: "direct_minting_payment_too_small_for_fee_event" })
export class DirectMintingPaymentTooSmallForFeeEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property()
    transactionId: string;

    @Property({ columnType: "text" })
    receivedAmount: string;

    @Property({ columnType: "text" })
    mintingFeeUBA: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true })
    txhash?: string;

    @Property()
    fasset: string;

    constructor(
        transactionId: string,
        receivedAmount: string,
        mintingFeeUBA: string,
        timestamp: number,
        txhash: string,
        fasset: string
    ) {
        this.transactionId = transactionId;
        this.receivedAmount = receivedAmount;
        this.mintingFeeUBA = mintingFeeUBA;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
    }
}
