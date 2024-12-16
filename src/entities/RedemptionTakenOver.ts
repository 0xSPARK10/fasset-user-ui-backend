import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "redemption_taken_over" })
export class RedemptionTakenOver {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    agentVault: string;

    @Property()
    redeemer: string;

    @Property()
    requestId: string;

    @Property()
    valueTakenOverUBA: string;

    @Property()
    newAgentVault: string;

    @Property()
    newRequestId: string;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(
        agentVault: string,
        redeemer: string,
        requestId: string,
        valueTakenOverUBA: string,
        newAgentVault: string,
        newRequestId: string,
        timestamp: number
    ) {
        this.agentVault = agentVault;
        this.redeemer = redeemer;
        this.requestId = requestId;
        this.valueTakenOverUBA = valueTakenOverUBA;
        this.newAgentVault = newAgentVault;
        this.newRequestId = newRequestId;
        this.timestamp = timestamp;
    }
}
