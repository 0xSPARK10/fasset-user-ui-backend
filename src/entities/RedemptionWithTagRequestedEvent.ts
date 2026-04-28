import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

/** Possible lifecycle states of a redemption with tag. */
export enum RedemptionWithTagStatus {
    INPROGRESS = "INPROGRESS",
    FAILED = "FAILED",
    BLOCKED = "BLOCKED",
    DEFAULTED = "DEFAULTED",
    COMPLETED = "COMPLETED",
}

/** Persisted RedemptionWithTagRequested event from the AssetManager contract. */
@Entity({ tableName: "redemption_with_tag_requested_event" })
export class RedemptionWithTagRequestedEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    agentVault: string;

    @Index()
    @Property()
    redeemer: string;

    @Property()
    requestId: string;

    @Property()
    paymentAddress: string;

    @Property()
    valueUBA: string;

    @Property()
    feeUBA: string;

    @Property()
    firstUnderlyingBlock: string;

    @Property()
    lastUnderlyingBlock: string;

    @Property()
    lastUnderlyingTimestamp: string;

    @Property()
    paymentReference: string;

    @Property()
    destinationTag: string;

    @Property()
    status: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true, type: "text" })
    txhash: string;

    @Property({ nullable: true, type: "text" })
    fasset: string;

    @Property({ default: false })
    processed: boolean;

    constructor(
        agentVault: string,
        redeemer: string,
        requestId: string,
        paymentAddress: string,
        valueUBA: string,
        feeUBA: string,
        firstUnderlyingBlock: string,
        lastUnderlyingBlock: string,
        lastUnderlyingTimestamp: string,
        paymentReference: string,
        destinationTag: string,
        timestamp: number,
        txhash: string,
        fasset: string
    ) {
        this.agentVault = agentVault;
        this.redeemer = redeemer;
        this.requestId = requestId;
        this.paymentAddress = paymentAddress;
        this.valueUBA = valueUBA;
        this.feeUBA = feeUBA;
        this.firstUnderlyingBlock = firstUnderlyingBlock;
        this.lastUnderlyingBlock = lastUnderlyingBlock;
        this.lastUnderlyingTimestamp = lastUnderlyingTimestamp;
        this.paymentReference = paymentReference;
        this.destinationTag = destinationTag;
        this.status = RedemptionWithTagStatus.INPROGRESS;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
        this.processed = false;
    }
}
