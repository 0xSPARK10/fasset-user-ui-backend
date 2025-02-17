import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "redemption_event_default" })
export class RedemptionDefaultEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    agentVault: string;

    @Property()
    redeemer: string;

    @Property()
    requestId: string;

    @Property()
    redemptionAmountUBA: string;

    @Property()
    redeemedVaultCollateralWei: string;

    @Property()
    redeemedPoolCollateralWei: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true, type: "text" })
    txhash?: string;

    constructor(
        agentVault: string,
        redeemer: string,
        requestId: string,
        redemptionAmountUBA: string,
        redeemedVaultCollateralWei: string,
        redeemedPoolCollateralWei: string,
        timestamp: number,
        txhash: string
    ) {
        this.agentVault = agentVault;
        this.redeemer = redeemer;
        this.requestId = requestId;
        this.redemptionAmountUBA = redemptionAmountUBA;
        this.redeemedVaultCollateralWei = redeemedVaultCollateralWei;
        this.redeemedPoolCollateralWei = redeemedPoolCollateralWei;
        this.timestamp = timestamp;
        this.txhash = txhash;
    }
}
