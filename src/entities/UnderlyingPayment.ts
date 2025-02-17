import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "underlying_payment" })
export class UnderlyingPayment {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    paymentReference: string;

    @Property()
    underlyingHash: string;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(paymentReference: string, underlyingHash: string, timestamp: number) {
        this.paymentReference = paymentReference;
        this.underlyingHash = underlyingHash;
        this.timestamp = timestamp;
    }
}
