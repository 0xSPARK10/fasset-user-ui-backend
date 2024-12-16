import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "handshake" })
export class HandshakeEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    collateralReservationId: string;

    @Property()
    vaultAddress: string;

    @Property()
    minter: string;

    @Property()
    valueUBA: string;

    @Property()
    feeUBA: string;

    @Property({ type: "text" })
    minterUnderlyingAddresses: string;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(
        collateralReservationId: string,
        vaultAddress: string,
        minter: string,
        valueUBA: string,
        feeUBA: string,
        minterUnderlyingAddresses: string,
        timestamp: number
    ) {
        this.collateralReservationId = collateralReservationId;
        this.vaultAddress = vaultAddress;
        this.minter = minter;
        this.valueUBA = valueUBA;
        this.feeUBA = feeUBA;
        this.minterUnderlyingAddresses = minterUnderlyingAddresses;
        this.timestamp = timestamp;
    }
}
