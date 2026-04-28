import { Controller, Get, HttpException, HttpStatus, Param, Query } from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { LotsException } from "src/exceptions/lots.exception";
import {
    AddressResponse,
    AgentPoolLatest,
    AssetPrice,
    AvailableFassets,
    BestAgent,
    DirectMintingExecutorResponse,
    DirectMintingInfoResponse,
    ExecutorResponse,
    MintingRecipientResponse,
    Progress,
    TagInfo,
    TagReservationFeeResponse,
    TimeData,
} from "src/interfaces/requestResponse";
import { logger } from "src/logger/winston.logger";
import { PoolService } from "src/services/pool.service";
import { UserService } from "src/services/user.service";
import { HistoryService } from "src/services/userHistory.service";

@ApiTags("User")
@Controller("api")
export class UserController {
    constructor(
        private readonly userService: UserService,
        private readonly poolService: PoolService,
        private readonly historyService: HistoryService
    ) {}

    @Get("fassets")
    @ApiResponse({
        type: AvailableFassets,
    })
    listAvailableFassets(): AvailableFassets {
        try {
            return this.userService.listAvailableFassets();
        } catch (error) {
            logger.error(`Error in listAvailableFassets`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("agent/:fasset/:lots")
    @ApiResponse({
        type: BestAgent,
    })
    getBestAgent(@Param("fasset") fasset: string, @Param("lots") lots: number): Promise<BestAgent> {
        try {
            return this.userService.getBestAgent(fasset, lots);
        } catch (error) {
            logger.error(`Error in getBestAgent for ${fasset} and ${lots}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("agents/:fasset")
    @ApiResponse({
        type: [AgentPoolLatest],
    })
    getAllAgents(@Param("fasset") fasset: string): Promise<AgentPoolLatest[]> {
        try {
            return this.poolService.getAgentsLatest(fasset);
        } catch (error) {
            logger.error(`Error in getAgentsLatest for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("assetManagerAddress/:fasset")
    @ApiResponse({
        type: AddressResponse,
    })
    getAssetManagerAddress(@Param("fasset") fasset: string): Promise<AddressResponse> {
        try {
            return this.userService.getAssetManagerAddress(fasset);
        } catch (error) {
            logger.error(`Error in getAssetManagerAddress for ${fasset}`, error);
            if (error instanceof LotsException) {
                throw new LotsException(error.message);
            } else {
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

    @Get("executor/:fasset")
    @ApiResponse({
        type: ExecutorResponse,
    })
    getExecutor(@Param("fasset") fasset: string): Promise<ExecutorResponse> {
        try {
            return this.userService.getExecutorAddress(fasset);
        } catch (error) {
            logger.error(`Error in getExecutorAddress for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("userProgress/:address")
    @ApiResponse({
        type: [Progress],
    })
    getUserProgress(@Param("address") address: string, @Query("xrpAddress") xrpAddress?: string): Promise<Progress[]> {
        try {
            return this.historyService.getProgress(address, xrpAddress);
        } catch (error) {
            logger.error(`Error in getUserProgress`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("lifetimeClaimed/:address")
    getLifetimeClaimed(@Param("address") address: string): Promise<any> {
        try {
            return this.userService.getLifetimeClaimed(address);
        } catch (error) {
            logger.error(`Error in getLifetimeClaimed`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("timeData/:time")
    @ApiResponse({
        type: TimeData,
    })
    getTimeData(@Param("time") time: string): Promise<TimeData> {
        try {
            return this.userService.getTimeData(time);
        } catch (error) {
            logger.error(`Error in get time data`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("fassetState")
    getFassetState(): Promise<any> {
        try {
            return this.userService.checkStateFassets();
        } catch (error) {
            logger.error(`Error in get fasset state`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("fassetPrice/:fasset")
    @ApiResponse({
        type: AssetPrice,
    })
    getFassetPrice(@Param("fasset") fasset: string): Promise<AssetPrice> {
        try {
            return this.userService.getAssetPrice(fasset);
        } catch (error) {
            logger.error(`Error in get fasset price`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("underlyingStatus/:fasset/:paymentReference")
    @ApiResponse({
        type: Boolean,
    })
    getUnderlyingStatus(@Param("fasset") fasset: string, @Param("paymentReference") paymentReference: string): Promise<boolean> {
        try {
            return this.userService.mintingUnderlyingTransactionExists(fasset, paymentReference);
        } catch (error) {
            logger.error(`Error in getUnderlyigStatus for ${fasset} and ${paymentReference}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("tags/:fasset/:address")
    @ApiResponse({
        type: [TagInfo],
    })
    getTagsForAddress(@Param("fasset") fasset: string, @Param("address") address: string): Promise<TagInfo[]> {
        try {
            return this.userService.getTagsForAddress(fasset, address);
        } catch (error) {
            logger.error(`Error in getTagsForAddress for ${fasset} and ${address}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("tag/:fasset/:tagId")
    @ApiResponse({
        type: TagInfo,
    })
    getTagForAddress(@Param("fasset") fasset: string, @Param("tagId") tagId: string): Promise<TagInfo> {
        try {
            return this.userService.getTagForAddress(fasset, tagId);
        } catch (error) {
            logger.error(`Error in getTagForAddress for ${fasset} and ${tagId}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("mintingRecipient/:fasset/:tagId")
    @ApiResponse({
        type: MintingRecipientResponse,
    })
    getMintingRecipient(@Param("fasset") fasset: string, @Param("tagId") tagId: string): Promise<MintingRecipientResponse> {
        try {
            return this.userService.getMintingRecipient(fasset, tagId);
        } catch (error) {
            logger.error(`Error in getMintingRecipient for ${fasset} and ${tagId}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("directMintingExecutor/:fasset")
    @ApiResponse({
        type: DirectMintingExecutorResponse,
    })
    getDirectMintingExecutor(@Param("fasset") fasset: string): Promise<DirectMintingExecutorResponse> {
        try {
            return this.userService.getDirectMintingExecutor(fasset);
        } catch (error) {
            logger.error(`Error in getDirectMintingExecutor for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("directMintingInfo/:fasset")
    @ApiResponse({
        type: DirectMintingInfoResponse,
    })
    getDirectMintingInfo(@Param("fasset") fasset: string): Promise<DirectMintingInfoResponse> {
        try {
            return this.userService.getDirectMintingInfo(fasset);
        } catch (error) {
            logger.error(`Error in getDirectMintingInfo for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    /** Returns the tag reservation fee from the MintingTagManager contract for the given fasset. */
    @Get("tagReservationFee/:fasset")
    @ApiResponse({
        type: TagReservationFeeResponse,
    })
    getTagReservationFee(@Param("fasset") fasset: string): Promise<TagReservationFeeResponse> {
        try {
            return this.userService.getTagReservationFee(fasset);
        } catch (error) {
            logger.error(`Error in getTagReservationFee for ${fasset}`, error);
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
