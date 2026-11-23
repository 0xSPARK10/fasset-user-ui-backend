import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBadRequestResponse, ApiExtraModels, ApiOperation, ApiQuery, ApiResponse, ApiTags, getSchemaPath } from "@nestjs/swagger";
import { OFTHistory, Progress } from "src/interfaces/requestResponse";
import { HistoryService } from "src/services/userHistory.service";
import { isValidClassicAddress } from "xrpl";
import { OFTService } from "./oft.service";

@ApiTags("OFT")
@Controller("api/oft")
export class OFTFullHistoryController {
    constructor(
        private readonly historyService: HistoryService,
        private readonly oftService: OFTService
    ) {}

    @Get("fullHistory/:address")
    @ApiOperation({
        summary: "Get combined user progress and OFT history.",
        description:
            "Returns entries from both sources from the last seven days plus direct-mint bridge entries in AWAITING_RECOVERY or RECOVERY_PENDING regardless of age, newest first. Direct-mint history requires xrpAddress. The supplied addresses select history records; this endpoint does not prove ownership of either wallet.",
    })
    @ApiQuery({
        name: "xrpAddress",
        required: false,
        type: String,
        description: "Checksum-valid XRP classic address used to select direct-mint history and direct-mint bridge candidates.",
    })
    @ApiBadRequestResponse({ description: "xrpAddress is not a valid XRP classic address." })
    @ApiExtraModels(Progress, OFTHistory)
    @ApiResponse({
        status: 200,
        schema: {
            type: "array",
            items: {
                anyOf: [{ $ref: getSchemaPath(Progress) }, { $ref: getSchemaPath(OFTHistory) }],
            },
        },
    })
    async getFullHistory(@Param("address") address: string, @Query("xrpAddress") xrpAddress?: string): Promise<(Progress | OFTHistory)[]> {
        if (xrpAddress !== undefined && !isValidClassicAddress(xrpAddress)) {
            throw new BadRequestException("xrpAddress must be a valid XRP classic address");
        }
        const [userProgress, oftHistory] = await Promise.all([
            this.historyService.getProgress(address, xrpAddress),
            this.oftService.getOFTHistory(address, xrpAddress),
        ]);
        return [...userProgress, ...oftHistory].sort((a, b) => b.timestamp - a.timestamp);
    }
}
