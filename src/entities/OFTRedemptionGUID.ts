import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "guid_redemption" })
export class GuidRedemption {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property({ length: 66 })
    guid: string;

    @Property()
    requestId: string;

    @Index()
    @Property({ length: 42 })
    userAddress: string;

    @Property()
    fasset: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ length: 66 })
    txhash: string;

    constructor(guid: string, requestId: string, userAddress: string, fasset: string, timestamp: number, txhash: string) {
        this.guid = guid;
        this.requestId = requestId;
        this.userAddress = userAddress;
        this.fasset = fasset;
        this.timestamp = timestamp;
        this.txhash = txhash;
    }
}
