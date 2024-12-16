import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "collaterals" })
export class Collateral {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    fasset: string;

    @Property()
    token: string;

    @Property()
    decimals: number;

    @Property({ type: "bigint" })
    validUntil: number;

    @Property()
    assetFtsoSymbol: string;

    @Property()
    tokenFtsoSymbol: string;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    minCollateralRatioBIPS: number;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    ccbMinCollateralRatioBIPS: number;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    safetyMinCollateralRatioBIPS: number;

    constructor(
        fasset: string,
        token: string,
        decimals: number,
        validUntil: number,
        assetFtsoSymbol: string,
        tokenFtsoSymbol: string,
        minCollateralRatioBIPS: number,
        ccbMinCollateralRatioBIPS: number,
        safetyMinCollateralRatioBIPS: number
    ) {
        this.fasset = fasset;
        this.token = token;
        this.decimals = decimals;
        this.validUntil = validUntil;
        this.assetFtsoSymbol = assetFtsoSymbol;
        this.tokenFtsoSymbol = tokenFtsoSymbol;
        this.minCollateralRatioBIPS = minCollateralRatioBIPS;
        this.ccbMinCollateralRatioBIPS = ccbMinCollateralRatioBIPS;
        this.safetyMinCollateralRatioBIPS = safetyMinCollateralRatioBIPS;
    }
}
