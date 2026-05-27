import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

// One row per `ComposerFeeCollected` event emitted by the FAssetRedeemComposer
// contract. The composer only emits this event when the fee is greater than
// zero, so a redemption may legitimately have no matching row here. Linked to
// `OFTRedemption` via `guid` (one composer redemption → one fee event).
@Entity({ tableName: "oft_composer_fee_collected" })
export class OFTComposerFeeCollected {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Index()
    @Property({ length: 66 })
    guid: string;

    @Property()
    srcEid: number;

    @Property({})
    composerFeeRecipient: string;

    // uint256 stored as string for lossless round-trip.
    @Property()
    composerFee: string;

    @Property()
    fasset: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ length: 66 })
    txhash: string;

    constructor(guid: string, srcEid: number, composerFeeRecipient: string, composerFee: string, fasset: string, timestamp: number, txhash: string) {
        this.guid = guid;
        this.srcEid = srcEid;
        this.composerFeeRecipient = composerFeeRecipient;
        this.composerFee = composerFee;
        this.fasset = fasset;
        this.timestamp = timestamp;
        this.txhash = txhash;
    }
}
