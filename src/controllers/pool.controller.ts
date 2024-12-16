import { Controller, Get, HttpException, HttpStatus, Param, Query } from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { AgentPoolItem, MaxCPTWithdraw, MaxWithdraw } from "src/interfaces/requestResponse";
import { logger } from "src/logger/winston.logger";
import { UserService } from "src/services/user.service";

@ApiTags("Pool")
@Controller("api")
export class PoolController {
    constructor(private readonly userService: UserService) {}

    @Get("pools/:address")
    @ApiResponse({
        type: [AgentPoolItem],
    })
    getPools(@Query("fasset") fasset: string[], @Param("address") address: string): Promise<AgentPoolItem[]> {
        try {
            const fassetArray = Array.isArray(fasset) ? fasset : [fasset];
            return this.userService.getPools(fassetArray, address);
        } catch (error) {
            logger.error(`Error in getPools for ${fasset} and ${address}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("maxWithdraw/:fasset/:poolAddress/:userAddress/:value")
    @ApiResponse({
        type: MaxWithdraw,
    })
    getMaxWithdraw(
        @Param("fasset") fasset: string,
        @Param("poolAddress") poolAddress: string,
        @Param("userAddress") userAddress: string,
        @Param("value") value: number
    ): Promise<MaxWithdraw> {
        try {
            return this.userService.getMaxWithdraw(fasset, poolAddress, userAddress, value);
        } catch (error) {
            logger.error(`Error in getMaxWithdraw for ${fasset}, ${poolAddress}, ${userAddress} and ${value}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("pools")
    @ApiResponse({
        type: [AgentPoolItem],
    })
    getAgents(@Query("fasset") fasset: string[]): Promise<AgentPoolItem[]> {
        try {
            const fassetArray = Array.isArray(fasset) ? fasset : [fasset];
            return this.userService.getAgents(fassetArray);
        } catch (error) {
            logger.error(`Error in getAgents for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("maxPoolWith/:fasset/:poolAddress")
    @ApiResponse({
        type: MaxCPTWithdraw,
    })
    getMaxWith(@Param("fasset") fasset: string, @Param("poolAddress") poolAddress: string): Promise<MaxCPTWithdraw> {
        try {
            return this.userService.getMaxCPTWithdraw(fasset, poolAddress);
        } catch (error) {
            logger.error(`Error in getMaxCPTWithdraw for ${fasset} and ${poolAddress}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("pools/:fasset/:address/:poolAddress")
    getPoolsSpecific(@Param("fasset") fasset: string, @Param("address") address: string, @Param("poolAddress") poolAddress: string): Promise<AgentPoolItem> {
        try {
            return this.userService.getPoolsSpecific(fasset, address, poolAddress);
        } catch (error) {
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("pools/:fasset/:poolAddress")
    getAgentSpecific(@Param("fasset") fasset: string, @Param("poolAddress") poolAddress: string): Promise<AgentPoolItem> {
        try {
            return this.userService.getAgentSpecific(fasset, poolAddress);
        } catch (error) {
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
