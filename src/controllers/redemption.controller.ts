import { Controller, Get, HttpException, HttpStatus, Param } from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import {
    RedemptionDefaultStatusGrouped,
    RedemptionFee,
    RedemptionFeeData,
    RedemptionStatus,
    RequestRedemption,
    TrailingFee,
} from "src/interfaces/requestResponse";
import { logger } from "src/logger/winston.logger";
import { UserService } from "src/services/user.service";

@ApiTags("Redemption")
@Controller("api")
export class RedemptionController {
    constructor(private readonly userService: UserService) {}

    @Get("redemptionFee/:fasset")
    @ApiResponse({
        type: RedemptionFee,
    })
    getRedemptionFee(@Param("fasset") fasset: string): Promise<RedemptionFee> {
        try {
            return this.userService.getRedemptionFee(fasset);
        } catch (error) {
            logger.error(`Error in getRedemptionFee for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("redemptionStatus/:fasset/:txhash")
    @ApiResponse({
        type: RedemptionStatus,
    })
    getRedemptionStatus(@Param("fasset") fasset: string, @Param("txhash") txhash: string): Promise<RedemptionStatus> {
        try {
            return this.userService.getRedemptionStatus(fasset, txhash);
        } catch (error) {
            logger.error(`Error in getRedemptionStatus for ${fasset} and ${txhash}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("redemptionDefaultStatus/:txhash")
    @ApiResponse({
        type: RedemptionDefaultStatusGrouped,
    })
    redemptionDefault(@Param("txhash") txhash: string): Promise<RedemptionDefaultStatusGrouped> {
        try {
            return this.userService.redemptionDefaultStatus(txhash);
        } catch (error) {
            logger.error(`Error in getRedemptionStatus for ${txhash}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("requestRedemptionDefault/:fasset/:txhash/:amount/:userAddress")
    requestRedemptionDefault(
        @Param("fasset") fasset: string,
        @Param("txhash") txhash: string,
        @Param("amount") amount: string,
        @Param("userAddress") userAddress: string
    ): Promise<RequestRedemption> {
        try {
            return this.userService.requestRedemption(fasset, txhash, amount, userAddress);
        } catch (error) {
            logger.error(`Error in requestRedemption for ${fasset} and ${txhash}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("trailingFee/:fasset")
    @ApiResponse({
        type: TrailingFee,
    })
    getTrailingFee(@Param("fasset") fasset: string): Promise<TrailingFee> {
        try {
            return this.userService.getTrailingFees(fasset);
        } catch (error) {
            logger.error(`Error in getTrailingFees for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("redemptionFeeData")
    @ApiResponse({
        type: [RedemptionFeeData],
    })
    getRedemptionFeeData(): Promise<RedemptionFeeData[]> {
        try {
            return this.userService.getRedemptionFeeData();
        } catch (error) {
            logger.error(`Error in getRedemptionFeeData`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("redemptionQueue/:fasset")
    /*@ApiResponse({
        type: [RedemptionFeeData],
    })*/
    getRedemptionQueue(@Param("fasset") fasset: string): Promise<any> {
        try {
            return this.userService.getRedemptionQueue(fasset);
        } catch (error) {
            logger.error(`Error in getRedemptionQueue`, error);
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
