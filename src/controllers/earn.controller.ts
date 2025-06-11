import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { logger } from "src/logger/winston.logger";
import { EarnService, EcosystemApp } from "src/services/earn.service";

@ApiTags("Earn")
@Controller("api")
export class EarnController {
    constructor(private readonly earnService: EarnService) {}

    @Get("earn")
    getEarnList(): Record<string, EcosystemApp> {
        try {
            return this.earnService.getEcosystemList();
        } catch (error) {
            logger.error(`Error in earn list`, error);
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
