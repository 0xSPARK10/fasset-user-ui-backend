import { Controller, Get, HttpException, HttpStatus, Param, Query } from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { CommonBalance, NativeBalanceItem } from "src/interfaces/requestResponse";
import { logger } from "src/logger/winston.logger";
import { UserService } from "src/services/user.service";

@ApiTags("Balance")
@Controller("api")
export class BalanceController {
    constructor(private readonly userService: UserService) {}

    @Get("balance/underlying/:fasset/:address")
    @ApiResponse({
        type: CommonBalance,
    })
    getUnderlyingBalance(
        @Param("fasset") fasset: string,
        @Param("address") address: string,
        @Query("receiveAddresses") receiveAddresses?: string,
        @Query("changeAddresses") changeAddresses?: string
    ): Promise<CommonBalance> {
        try {
            const addressListReceive = receiveAddresses ? receiveAddresses.split(",") : [];
            const addressListChange = changeAddresses ? changeAddresses.split(",") : [];
            return this.userService.getUnderlyingBalance(fasset, address, addressListReceive, addressListChange);
        } catch (error) {
            logger.error(`Error in getUnderlyingBalance for ${fasset} and ${address}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("balance/native/:address")
    @ApiResponse({
        type: [NativeBalanceItem],
    })
    getNativeBalances(@Param("address") address: string): Promise<NativeBalanceItem[]> {
        try {
            return this.userService.getNativeBalances(address);
        } catch (error) {
            logger.error(`Error in getNativeBalances for ${address}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("balance/pool/:userAddress")
    @ApiResponse({
        type: CommonBalance,
    })
    getPoolBalances(@Param("userAddress") userAddress: string): Promise<CommonBalance> {
        try {
            return this.userService.getPoolBalances(userAddress);
        } catch (error) {
            logger.error(`Error in getPoolBalances for ${userAddress}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("balance/xpub/:fasset/:xpub")
    @ApiResponse({
        type: CommonBalance,
    })
    getXpubBalance(@Param("fasset") fasset: string, @Param("xpub") address: string): Promise<CommonBalance> {
        try {
            return this.userService.getXpubBalance(fasset, address);
        } catch (error) {
            logger.error(`Error in getXpubBalance for ${address}`, error);
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
