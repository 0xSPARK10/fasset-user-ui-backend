import { Controller, Get, Param } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { OFTService } from "./oft.service";
import { OFTHistory, RedemptionOFT } from "src/interfaces/requestResponse";

@ApiTags("OFT")
@Controller("api/oft")
export class OFTController {
    constructor(private readonly oftService: OFTService) {}

    @Get("redemptionHash/:guid")
    @ApiOperation({ summary: "Get redemption txhash from guid." })
    async getRdemptionTxhash(@Param("guid") guid: string): Promise<RedemptionOFT> {
        return this.oftService.getRedemptionTxhash(guid);
    }

    @Get("userHistory/:address")
    @ApiResponse({
        type: [OFTHistory],
    })
    getUserProgress(@Param("address") address: string): Promise<OFTHistory[]> {
        return this.oftService.getOFTHistory(address);
    }
}
