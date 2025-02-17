import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "indexer_state" })
export class IndexerState {
    @PrimaryKey({ type: "string" })
    name!: string;

    @Property()
    lastBlock: number;

    constructor(name: string, lastBlock: number) {
        this.name = name;
        this.lastBlock = lastBlock;
    }
}
