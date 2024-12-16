import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "redemption_default" })
export class RedemptionDefault {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    txhash: string;

    @Property()
    agentVault: string;

    @Property()
    redeemer: string;

    @Property({ columnType: "text" })
    redemptionAmountUBA: string;

    @Property({ columnType: "text" })
    redeemedVaultCollateralWei: string;

    @Property({ columnType: "text" })
    redeemedPoolCollateralWei: string;

    @Property()
    requestId: string;

    @Property()
    fasset: string;

    @Property()
    collateralToken: string;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(
        txhash: string,
        agentVault: string,
        redeemer: string,
        redemptionAmountUBA: string,
        redeemedVaultCollateralWei: string,
        redeemedPoolCollateralWei: string,
        requestId: string,
        fasset: string,
        collateralToken: string,
        timestamp: number
    ) {
        this.txhash = txhash;
        this.agentVault = agentVault;
        this.redeemer = redeemer;
        this.redemptionAmountUBA = redemptionAmountUBA;
        this.redeemedVaultCollateralWei = redeemedVaultCollateralWei;
        this.redeemedPoolCollateralWei = redeemedPoolCollateralWei;
        this.requestId = requestId;
        this.fasset = fasset;
        this.collateralToken = collateralToken;
        this.timestamp = timestamp;
    }
}
