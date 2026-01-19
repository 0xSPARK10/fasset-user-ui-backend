import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "oft_received" })
export class OFTReceived {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property({ length: 66 })
    guid: string;

    @Property()
    srcEid: number;

    @Index()
    @Property({ length: 42 })
    toAddress: string;

    @Property()
    amountReceivedLD: string;

    @Property()
    fasset: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ length: 66 })
    txhash: string;

    constructor(guid: string, srcEid: number, toAddress: string, amountReceivedLD: string, fasset: string, timestamp: number, txhash: string) {
        this.guid = guid;
        this.srcEid = srcEid;
        this.toAddress = toAddress;
        this.amountReceivedLD = amountReceivedLD;
        this.fasset = fasset;
        this.timestamp = timestamp;
        this.txhash = txhash;
    }
}
