import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";

/** Keeps observed recovery payments until the runner can match their original mint. */
@Entity({ tableName: "direct_minting_recovery_payment" })
@Unique({ properties: ["fasset", "txhash"] })
@Index({ properties: ["processed", "fasset", "id"] })
export class DirectMintingRecoveryPayment {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    txhash: string;

    @Property()
    originalTxHash: string;

    @Property()
    userAddress: string;

    @Property()
    fasset: string;

    @Property({ type: "bigint" })
    timestamp: number;

    /** True once matched or discarded because the target is terminal or belongs to another sender. */
    @Property({ default: false })
    processed: boolean;

    /** Records the recovery hash separately so the original mint's payment details stay intact. */
    constructor(txhash: string, originalTxHash: string, userAddress: string, fasset: string, timestamp: number) {
        this.txhash = txhash;
        this.originalTxHash = originalTxHash;
        this.userAddress = userAddress;
        this.fasset = fasset;
        this.timestamp = timestamp;
        this.processed = false;
    }
}
