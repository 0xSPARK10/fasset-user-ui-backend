import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "redemption_blocked" })
export class RedemptionBlocked {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    agentVault: string;

    @Property()
    redeemer: string;

    @Property()
    requestId: string;

    @Property()
    transactionHash: string;

    @Property()
    redemptionAmountUBA: string;

    @Property()
    spentUnderlyingUBA: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true, type: "text" })
    txhash?: string;

    constructor(
        agentVault: string,
        redeemer: string,
        requestId: string,
        transactionHash: string,
        redemptionAmountUBA: string,
        spentUnderlyingUBA: string,
        timestamp: number,
        txhash: string
    ) {
        this.agentVault = agentVault;
        this.redeemer = redeemer;
        this.requestId = requestId;
        this.transactionHash = transactionHash;
        this.redemptionAmountUBA = redemptionAmountUBA;
        this.spentUnderlyingUBA = spentUnderlyingUBA;
        this.timestamp = timestamp;
        this.txhash = txhash;
    }
}
