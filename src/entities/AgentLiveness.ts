import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "liveness" })
export class Liveness {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    vaultAddress: string;

    @Property()
    fasset: string;

    @Property({ type: "bigint" })
    lastPinged: number;

    @Property({ type: "bigint" })
    lastTimestamp: number;

    @Property()
    publiclyAvailable: boolean;

    constructor(vaultAddress: string, fasset: string, lastPinged: number, lastTimestamp: number, publiclyAvailable: boolean) {
        this.vaultAddress = vaultAddress;
        this.fasset = fasset;
        this.lastPinged = lastPinged;
        this.lastTimestamp = lastTimestamp;
        this.publiclyAvailable = publiclyAvailable;
    }
}
