import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "redemption" })
export class Redemption {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    txhash: string;

    @Property()
    processed: boolean;

    @Property({ nullable: true })
    proofRequestRound?: number;

    @Property({ nullable: true, type: "text" })
    proofRequestData?: string;

    @Property()
    state: boolean;

    @Property()
    underlyingAddress: string;

    @Property()
    paymentReference: string;

    @Property()
    amountUBA: string;

    @Property()
    firstUnderlyingBlock: string;

    @Property()
    lastUnderlyingBlock: string;

    @Property()
    lastUnderlyingTimestamp: string;

    @Property()
    requestId: string;

    @Property()
    defaulted: boolean;

    @Property({ type: "bigint" })
    validUntil: number;

    @Property()
    fasset: string;

    @Property()
    handshakeType: number;

    @Property()
    rejected: boolean;

    @Property()
    takenOver: boolean;

    @Property()
    rejectionDefault: boolean;

    @Property({ nullable: true, type: "bigint" })
    timestamp: number;

    constructor(
        txhash: string,
        processed: boolean,
        underlyingAddress: string,
        paymentReference: string,
        amountUBA: string,
        firstUnderlyingBlock: string,
        lastUnderlyingBlock: string,
        lastUnderlyingTimestamp: string,
        requestId: string,
        validUntil: number,
        fasset: string,
        handshakeType: number,
        rejected: boolean,
        takenOver: boolean,
        rejectionDefault: boolean,
        timestamp: number
    ) {
        this.txhash = txhash;
        this.processed = processed;
        this.proofRequestData = null;
        this.proofRequestRound = null;
        this.state = false;
        this.underlyingAddress = underlyingAddress;
        this.paymentReference = paymentReference;
        this.amountUBA = amountUBA;
        this.firstUnderlyingBlock = firstUnderlyingBlock;
        this.lastUnderlyingBlock = lastUnderlyingBlock;
        this.lastUnderlyingTimestamp = lastUnderlyingTimestamp;
        this.requestId = requestId;
        this.defaulted = false;
        this.validUntil = validUntil;
        this.fasset = fasset;
        this.handshakeType = handshakeType;
        this.rejected = rejected;
        this.takenOver = takenOver;
        this.rejectionDefault = rejectionDefault;
        this.timestamp = timestamp;
    }
}
