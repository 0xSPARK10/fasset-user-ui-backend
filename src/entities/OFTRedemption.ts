import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "oft_redemption" })
export class OFTRedemption {
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
    paymentReference: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ length: 66 })
    txhash: string;

    @Property()
    fasset: string;

    @Index()
    @Property({ length: 66 })
    guid: string;

    @Index()
    @Property()
    personalRedeemerAddress: string;

    @Property()
    srcEid: number;

    @Property()
    defaulted: boolean;

    @Property()
    blocked: boolean;

    @Property()
    processed: boolean;

    // Destination tag stored as string so large uint256 values stay lossless
    // even though XRP destination tags actually fit in a uint32. Only set when
    // the redeemer requested a tag on the source chain (otherwise null —
    // semantically distinct from tag = 0, which is a valid XRP tag value).
    @Property({ nullable: true })
    destinationTag?: string | null;

    constructor(
        agentVault: string,
        redeemer: string,
        requestId: string,
        paymentAddress: string,
        valueUBA: string,
        feeUBA: string,
        paymentReference: string,
        timestamp: number,
        txhash: string,
        fasset: string,
        guid: string,
        personalRedeemerAddress: string,
        srcEid: number,
        destinationTag?: string | null
    ) {
        this.agentVault = agentVault;
        this.redeemer = redeemer;
        this.requestId = requestId;
        this.paymentAddress = paymentAddress;
        this.valueUBA = valueUBA;
        this.feeUBA = feeUBA;
        this.paymentReference = paymentReference;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
        this.guid = guid;
        this.personalRedeemerAddress = personalRedeemerAddress;
        this.srcEid = srcEid;
        this.processed = false;
        this.defaulted = false;
        this.blocked = false;
        this.destinationTag = destinationTag ?? null;
    }
}
