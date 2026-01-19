// optional-feature/optional-feature.module.ts
import { Module } from "@nestjs/common";
import { OFTEventReaderService } from "./oft.event.reader.service";
import { OFTController } from "./oft.controller";
import { OFTService } from "./oft.service";

@Module({
    providers: [OFTEventReaderService, OFTService],
    controllers: [OFTController],
})
export class OFTModule {}
