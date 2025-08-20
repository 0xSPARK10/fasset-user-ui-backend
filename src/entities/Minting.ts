import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "minting" })
export class Minting {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    collateralReservationId: string;

    @Property({ nullable: true })
    txhash: string;

    @Property()
    paymentAddress: string;

    @Property()
    userUnderlyingAddress: string;

    @Property()
    processed: boolean;

    @Property({ nullable: true })
    proofRequestRound?: number;

    @Property({ nullable: true, type: "text" })
    proofRequestData?: string;

    @Property()
    state: boolean;

    @Property({ type: "bigint" })
    validUntil: number;

    @Property()
    proved: boolean;

    @Property()
    fasset: string;

    @Property()
    userAddress: string;

    @Property()
    amount: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property()
    vaultAddress: string;

    @Property({ nullable: true, type: "text" })
    paymentReference?: string;

    @Property({ default: false })
    handshakeRequired: boolean;

    constructor(
        collateralReservationId: string,
        txhash: string,
        paymentAddress: string,
        userUnderlyingAddress: string,
        processed: boolean,
        validUntil: number,
        proved: boolean,
        fasset: string,
        userAddress: string,
        amount: string,
        timestamp: number,
        vaultAddress: string,
        paymentReference: string
    ) {
        this.collateralReservationId = collateralReservationId;
        this.txhash = txhash;
        this.paymentAddress = paymentAddress;
        this.userUnderlyingAddress = userUnderlyingAddress;
        this.processed = processed;
        this.proofRequestData = null;
        this.proofRequestRound = null;
        this.state = false;
        this.validUntil = validUntil;
        this.proved = proved;
        this.fasset = fasset;
        this.userAddress = userAddress;
        this.amount = amount;
        this.timestamp = timestamp;
        this.vaultAddress = vaultAddress;
        this.paymentReference = paymentReference;
    }
}
