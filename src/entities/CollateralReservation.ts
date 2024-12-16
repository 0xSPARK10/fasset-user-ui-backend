import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "collateral_reservation" })
export class CollateralReservationEvent {
    @PrimaryKey({ autoincrement: true })
    id!: number;

    @Property()
    collateralReservationId: string;

    @Property()
    agentVault: string;

    @Property()
    minter: string;

    @Property()
    valueUBA: string;

    @Property()
    feeUBA: string;

    @Property()
    firstUnderlyingBlock: string;

    @Property()
    lastUnderlyingBlock: string;

    @Property()
    lastUnderlyingTimestamp: string;

    @Property()
    paymentAddress: string;

    @Property()
    paymentReference: string;

    @Property()
    executorAddress: string;

    @Property()
    executorFeeNatWei: string;

    @Property({ type: "bigint" })
    timestamp: number;

    constructor(
        collateralReservationId: string,
        agentVault: string,
        minter: string,
        valueUBA: string,
        feeUBA: string,
        firstUnderlyingBlock: string,
        lastUnderlyingBlock: string,
        lastUnderlyingTimestamp: string,
        paymentAddress: string,
        paymentReference: string,
        executorAddress: string,
        executorFeeNatWei: string,
        timestamp: number
    ) {
        this.collateralReservationId = collateralReservationId;
        this.agentVault = agentVault;
        this.minter = minter;
        this.valueUBA = valueUBA;
        this.feeUBA = feeUBA;
        this.firstUnderlyingBlock = firstUnderlyingBlock;
        this.lastUnderlyingBlock = lastUnderlyingBlock;
        this.lastUnderlyingTimestamp = lastUnderlyingTimestamp;
        this.paymentAddress = paymentAddress;
        this.paymentReference = paymentReference;
        this.executorAddress = executorAddress;
        this.executorFeeNatWei = executorFeeNatWei;
        this.timestamp = timestamp;
    }
}
