import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { logger } from "src/logger/winston.logger";
import { VersionService } from "src/services/version.service";

@ApiTags("Version")
@Controller("api")
export class VersionController {
    constructor(private readonly versionService: VersionService) {}

    @Get("version")
    getVersion(): string {
        try {
            return this.versionService.getVersion();
        } catch (error) {
            logger.error("Error in get version", error);
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
