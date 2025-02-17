import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "minting_payment_default" })
export class MintingDefaultEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    agentVault: string;

    @Property()
    minter: string;

    @Property()
    collateralReservationId: string;

    @Property()
    reservedAmountUBA: string;

    @Property({ type: "bigint" })
    timestamp: number;

    @Property({ nullable: true, type: "text" })
    txhash?: string;

    constructor(agentVault: string, minter: string, collateralReservationId: string, reservedAmountUBA: string, timestamp: number, txhash: string) {
        this.agentVault = agentVault;
        this.minter = minter;
        this.collateralReservationId = collateralReservationId;
        this.reservedAmountUBA = reservedAmountUBA;
        this.timestamp = timestamp;
        this.txhash = txhash;
    }
}
