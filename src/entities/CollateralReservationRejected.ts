import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "cr_rejected_cancelled" })
export class CrRejectedCancelledEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    collateralReservationId: string;

    @Property()
    agentVault: string;

    @Property()
    minter: string;

    @Property()
    rejected: boolean;

    @Property()
    cancelled: boolean;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(collateralReservationId: string, agentVault: string, minter: string, rejected: boolean, cancelled: boolean, timestamp: number) {
        this.collateralReservationId = collateralReservationId;
        this.agentVault = agentVault;
        this.minter = minter;
        this.rejected = rejected;
        this.cancelled = cancelled;
        this.timestamp = timestamp;
    }
}
