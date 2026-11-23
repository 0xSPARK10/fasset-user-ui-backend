import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/** Possible lifecycle states of a direct minting. */
export enum DirectMintingStatus {
    INPROGRESS = "INPROGRESS",
    DELAYED = "DELAYED",
    AWAITING_RECOVERY = "AWAITING_RECOVERY",
    RECOVERY_PENDING = "RECOVERY_PENDING",
    RECOVERED = "RECOVERED",
    EXECUTED = "EXECUTED",
    EXECUTED_TO_SMART_ACCOUNT = "EXECUTED_TO_SMART_ACCOUNT",
    MINTING_PAYMENT_TOO_SMALL_FOR_FEE = "MINTING_PAYMENT_TOO_SMALL_FOR_FEE",
}

/** Tracks the lifecycle of a single direct minting via Core Vault. */
@Entity({ tableName: "direct_minting" })
@Index({ properties: ["processed", "fasset", "id"] })
export class DirectMinting {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property()
    txhash: string;

    @Index()
    @Property()
    userAddress: string;

    @Property({ nullable: true })
    targetAddress: string | null;

    @Property()
    mintType: string;

    @Property({ nullable: true })
    tagId: string | null;

    @Property()
    amount: string;

    @Property({ default: "0" })
    mintingFeeUBA: string;

    @Property({ default: "0" })
    executorFeeUBA: string;

    @Property({ nullable: true })
    mintedAmountUBA: string | null;

    @Property()
    status: string;

    @Property({ nullable: true, type: "bigint" })
    delayTimestamp: number | null;

    @Property({ type: "bigint" })
    timestamp: number;

    /** Millisecond timestamp of the most recent smart-backend status attempt. */
    @Property({ nullable: true, type: "bigint" })
    smartStatusLastCheckedAt: number | null;

    @Property({ nullable: true })
    destinationEid: number | null;

    @Property({ nullable: true })
    destinationKind: string | null;

    @Property()
    fasset: string;

    @Property({ default: false })
    processed: boolean;

    /** EVM transaction hash of the event that resolved this minting (null until processed). */
    @Property({ nullable: true })
    evm_txhash: string | null;

    constructor(
        txhash: string,
        userAddress: string,
        targetAddress: string | null,
        mintType: string,
        tagId: string | null,
        amount: string,
        timestamp: number,
        fasset: string
    ) {
        this.txhash = txhash;
        this.userAddress = userAddress;
        this.targetAddress = targetAddress;
        this.mintType = mintType;
        this.tagId = tagId;
        this.amount = amount;
        this.mintingFeeUBA = "0";
        this.executorFeeUBA = "0";
        this.mintedAmountUBA = null;
        this.status = DirectMintingStatus.INPROGRESS;
        this.delayTimestamp = null;
        this.timestamp = timestamp;
        this.smartStatusLastCheckedAt = null;
        this.destinationEid = null;
        this.destinationKind = null;
        this.fasset = fasset;
        this.processed = false;
        this.evm_txhash = null;
    }
}
