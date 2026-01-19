import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "oft_sent" })
export class OFTSent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property({ length: 66 })
    guid: string;

    @Property()
    dstEid: number;

    @Index()
    @Property({ length: 42 })
    fromAddress: string;

    @Property()
    amountReceivedLD: string;

    @Property()
    toHypercore: boolean;

    @Property()
    amountSentLD: string;

    @Property()
    fasset: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ length: 66 })
    txhash: string;

    constructor(
        guid: string,
        dstEid: number,
        fromAddress: string,
        amountReceivedLD: string,
        amountSentLD: string,
        fasset: string,
        timestamp: number,
        txhash: string,
        toHypercore: boolean
    ) {
        this.guid = guid;
        this.dstEid = dstEid;
        this.fromAddress = fromAddress;
        this.amountReceivedLD = amountReceivedLD;
        this.amountSentLD = amountSentLD;
        this.fasset = fasset;
        this.timestamp = timestamp;
        this.txhash = txhash;
        this.toHypercore = toHypercore;
    }
}
