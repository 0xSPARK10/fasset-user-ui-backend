import { Module } from "@nestjs/common";
import { OFTEventReaderService } from "./oft.event.reader.service";
import { OFTController } from "./oft.controller";
import { OFTService } from "./oft.service";
import { OFTRedemptionProcessor } from "./oft.redemption.processor";

@Module({
    providers: [OFTEventReaderService, OFTService, OFTRedemptionProcessor],
    controllers: [OFTController],
})
export class OFTModule {}
