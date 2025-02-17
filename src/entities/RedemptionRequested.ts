import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "redemption_requested" })
export class RedemptionRequested {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    agentVault: string;

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

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true, type: "text" })
    txhash: string;

    @Property({ nullable: true, type: "text" })
    fasset: string;

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
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
    }
}
