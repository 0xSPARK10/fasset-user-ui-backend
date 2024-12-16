import { Entity, PrimaryKey, Property } from "@mikro-orm/core";
@Entity({ tableName: "redemption_rejected" })
export class RedemptionRejected {
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

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(agentVault: string, redeemer: string, requestId: string, paymentAddress: string, valueUBA: string, timestamp: number) {
        this.agentVault = agentVault;
        this.redeemer = redeemer;
        this.requestId = requestId;
        this.timestamp = timestamp;
        this.paymentAddress = paymentAddress;
        this.valueUBA = valueUBA;
    }
}
