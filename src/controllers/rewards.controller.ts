import { Controller, Get, HttpException, HttpStatus, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { RewardsService } from "src/services/rewarding.service";
import { logger } from "src/logger/winston.logger";

@ApiTags("Rewarding")
@Controller("api")
export class RewardsController {
    constructor(private readonly rewardsService: RewardsService) {}

    @Get("rewards/:address")
    //@ApiResponse({
    //    type: any,
    //})
    getRewards(@Param("address") address: string): Promise<any> {
        try {
            return this.rewardsService.getRewardsForUser(address);
        } catch (error) {
            logger.error(`Error in getclaimed rewards`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}
