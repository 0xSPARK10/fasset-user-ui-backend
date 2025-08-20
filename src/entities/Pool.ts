import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "pools" })
export class Pool {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    vaultAddress: string;

    @Property()
    fasset: string;

    @Property()
    poolAddress: string;

    @Property()
    tokenAddress: string;

    @Property()
    agentName: string;

    @Property()
    vaultType: string;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    poolCR: number;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    vaultCR: number;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    poolExitCR: number;

    @Property()
    totalPoolCollateral: string;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    feeShare: number;

    @Property()
    status: number;

    @Property()
    freeLots: string;

    @Property({ type: "decimal", precision: 10, scale: 5 })
    mintFee: number;

    @Property()
    mintNumber: number;

    @Property({ type: "decimal", precision: 10, scale: 4 })
    redeemSuccessRate: number;

    @Property()
    numLiquidations: number;

    @Property({ columnType: "text" })
    url: string;

    @Property()
    poolNatUsd: string;

    @Property()
    vaultCollateral: string;

    @Property()
    vaultCollateralToken: string;

    @Property()
    vaultCollateralTokenDecimals: number;

    @Property()
    publiclyAvailable: boolean;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    mintingPoolCR: number;

    @Property({ type: "decimal", precision: 10, scale: 2 })
    mintingVaultCR: number;

    @Property()
    vaultToken: string;

    @Property({ nullable: true, columnType: "text" })
    description: string;

    //Minted underlying: example 20 XRP
    @Property({ nullable: true })
    mintedUBA: string;

    @Property({ nullable: true })
    mintedUSD: string;

    @Property({ nullable: true })
    allLots: number;

    //PoolCollateral USD
    @Property({ nullable: true })
    poolOnlyCollateralUSD: string;

    //Vault collateral in USD
    @Property({ nullable: true })
    vaultOnlyCollateralUSD: string;

    //Remaining underlying formatted, ex: 20 XRP
    @Property({ nullable: true })
    remainingUBA: string;

    //Remaining underlying for minting in usd
    @Property({ nullable: true })
    remainingUSD: string;

    //Remaining underlying for minting in usd
    @Property({ nullable: true })
    totalPortfolioValueUSD: string;

    //Remaining underlying for minting in usd
    @Property({ nullable: true })
    limitUSD: string;

    @Property({ nullable: true, columnType: "text" })
    infoUrl: string;

    @Property({ nullable: true })
    underlyingAddress: string;

    @Property({ type: "decimal", precision: 10, scale: 2, default: 1 })
    poolTopupCR: number;

    @Property({ nullable: true, default: 1 })
    handshakeType: number;

    constructor(
        vaultAddress: string,
        fasset: string,
        poolAddress: string,
        tokenAddress: string,
        agentName: string,
        vaultType: string,
        poolCR: number,
        vaultCR: number,
        poolExitCR: number,
        totalPoolCollateral: string,
        feeShare: number,
        status: number,
        freeLots: string,
        mintFee: number,
        mintNumber: number,
        redeemSuccessRate: number,
        numLiquidations: number,
        url: string,
        poolNatUsd: string,
        vaultCollateral: string,
        vaultCollateraloken: string,
        vaultCollateralTokenDecimals: number,
        publiclyAvailable: boolean,
        mintingPoolCR: number,
        mintingVaultCR: number,
        vaultToken: string,
        description: string,
        mintedUBA: string,
        mintedUSD: string,
        allLots: number,
        poolOnlyCollateralUSD: string,
        vaultOnlyCollateralUSD: string,
        remainingUBA: string,
        remainingUSD: string,
        totalPortfolioValueUSD: string,
        limitUSD: string,
        infoUrl: string,
        underlyingAddress: string
    ) {
        this.vaultAddress = vaultAddress;
        this.fasset = fasset;
        this.poolAddress = poolAddress;
        this.tokenAddress = tokenAddress;
        this.agentName = agentName;
        this.vaultType = vaultType;
        this.poolCR = poolCR;
        this.vaultCR = vaultCR;
        this.poolExitCR = poolExitCR;
        this.totalPoolCollateral = totalPoolCollateral;
        this.feeShare = feeShare;
        this.status = status;
        this.freeLots = freeLots;
        this.mintFee = mintFee;
        this.mintNumber = mintNumber;
        this.redeemSuccessRate = redeemSuccessRate;
        this.numLiquidations = numLiquidations;
        this.url = url;
        this.poolNatUsd = poolNatUsd;
        this.vaultCollateral = vaultCollateral;
        this.vaultCollateralToken = vaultCollateraloken;
        this.vaultCollateralTokenDecimals = vaultCollateralTokenDecimals;
        this.publiclyAvailable = publiclyAvailable;
        this.mintingPoolCR = mintingPoolCR;
        this.mintingVaultCR = mintingVaultCR;
        this.vaultToken = vaultToken;
        this.description = description;
        this.mintedUBA = mintedUBA;
        this.mintedUSD = mintedUSD;
        this.allLots = allLots;
        this.poolOnlyCollateralUSD = poolOnlyCollateralUSD;
        this.vaultOnlyCollateralUSD = vaultOnlyCollateralUSD;
        this.remainingUBA = remainingUBA;
        this.remainingUSD = remainingUSD;
        this.totalPortfolioValueUSD = totalPortfolioValueUSD;
        this.limitUSD = limitUSD;
        this.infoUrl = infoUrl;
        this.underlyingAddress = underlyingAddress;
    }
}
