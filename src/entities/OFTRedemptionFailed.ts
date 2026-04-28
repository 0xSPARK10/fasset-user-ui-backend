import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "oft_redemption_failed" })
export class OFTRedemptionFailed {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property()
    redeemer: string;

    @Property()
    amountToRedeemAfterFee: string;

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

    constructor(
        redeemer: string,
        amountToRedeemAfterFee: string,
        timestamp: number,
        txhash: string,
        fasset: string,
        guid: string,
        personalRedeemerAddress: string,
        srcEid: number
    ) {
        this.redeemer = redeemer;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.fasset = fasset;
        this.guid = guid;
        this.personalRedeemerAddress = personalRedeemerAddress;
        this.srcEid = srcEid;
        this.amountToRedeemAfterFee = amountToRedeemAfterFee;
    }
}
