import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { ApiBody, ApiExtraModels, ApiResponse, ApiTags, getSchemaPath } from "@nestjs/swagger";
import {
    CREvent,
    CRFee,
    CRStatus,
    FeeEstimate,
    EcosystemData,
    LotSize,
    MaxLots,
    MintingStatus,
    RequestMint,
    submitTxResponse,
    ReturnAddresses,
    UTXOSLedger,
    FassetStatus,
} from "src/interfaces/requestResponse";
import { SelectedUTXOAddress } from "src/interfaces/structure";
import { logger } from "src/logger/winston.logger";
import { UserService } from "src/services/user.service";
import { UtxoService } from "src/services/utxo.service";

@ApiTags("Minting")
@Controller("api")
export class MintController {
    constructor(
        private readonly userService: UserService,
        private readonly utxoService: UtxoService
    ) {}

    @Get("maxLots/:fasset")
    @ApiResponse({
        type: MaxLots,
    })
    getMaxLots(@Param("fasset") fasset: string): Promise<MaxLots> {
        try {
            return this.userService.getMaxLots(fasset);
        } catch (error) {
            logger.error(`Error in getMaxLots for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("lotSize/:fasset")
    @ApiResponse({
        type: LotSize,
    })
    getLotSize(@Param("fasset") fasset: string): Promise<LotSize> {
        try {
            return this.userService.getLotSize(fasset);
        } catch (error) {
            logger.error(`Error in getLotSize for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("getCrEvent/:fasset/:txhash")
    @ApiExtraModels(CREvent)
    @ApiResponse({
        schema: {
            oneOf: [{ $ref: getSchemaPath(CREvent) }],
        },
    })
    getEvents(@Param("fasset") fasset: string, @Param("txhash") txhash: string): Promise<CREvent> {
        try {
            return this.userService.getCREventFromTxHash(fasset, txhash, false);
        } catch (error) {
            logger.error(`Error in getCREventFromTxHash for ${fasset} and ${txhash}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("getCrStatus/:crId")
    @ApiResponse({
        type: CREvent,
    })
    getCREventDB(@Param("crId") crId: string): Promise<CRStatus | null> {
        try {
            return this.userService.getCrStatus(crId);
        } catch (error) {
            logger.error(`Error in getCrDB for ${crId}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Post("mint")
    @ApiBody({ type: RequestMint })
    requestMinting(@Body() requestMint: RequestMint): Promise<void> {
        try {
            return this.userService.requestMinting(requestMint);
        } catch (error) {
            logger.error(`Error in requestMinting for ${JSON.stringify(requestMint)}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("mint/:txhash")
    @ApiResponse({
        type: MintingStatus,
    })
    mintingStatus(@Param("txhash") txhash: string): Promise<MintingStatus> {
        try {
            return this.userService.mintingStatus(txhash);
        } catch (error) {
            logger.error(`Error in mintingStatus for ${txhash}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("collateralReservationFee/:fasset/:lots")
    @ApiResponse({
        type: CRFee,
    })
    getCRTFee(@Param("fasset") fasset: string, @Param("lots") lots: number): Promise<CRFee> {
        try {
            return this.userService.getCRTFee(fasset, lots);
        } catch (error) {
            logger.error(`Error in getCRTFee for ${fasset} and ${lots}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("estimateFee/:fasset")
    @ApiResponse({
        type: FeeEstimate,
    })
    getFeeEstimate(@Param("fasset") fasset: string): Promise<FeeEstimate> {
        try {
            return this.userService.estimateFeeForBlocks(fasset);
        } catch (error) {
            logger.error(`Error in fee estimation for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("getUtxosForTransaction/:fasset/:xpub/:amount")
    @ApiResponse({
        type: UTXOSLedger,
    })
    getUtxosForTransaction(@Param("fasset") fasset: string, @Param("xpub") xpub: string, @Param("amount") amount: string): Promise<UTXOSLedger> {
        try {
            return this.utxoService.calculateUtxosForAmount(fasset, xpub, amount);
        } catch (error) {
            logger.error(`Error in calculate utxos for amount for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("submitTx/:fasset/:hex")
    @ApiResponse({
        type: submitTxResponse,
    })
    submitTx(@Param("fasset") fasset: string, @Param("hex") hex: string): Promise<submitTxResponse> {
        try {
            return this.userService.submitTx(fasset, hex);
        } catch (error) {
            logger.error(`Error in submitting tx`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("ecosystemInfo")
    @ApiResponse({
        type: EcosystemData,
    })
    getEcosystemData(): Promise<EcosystemData> {
        try {
            return this.userService.getEcosystemInfo();
        } catch (error) {
            logger.error(`Error in getting ecosystem info`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Post("prepareUtxos/:fasset/:amount/:recipient/:memo/:fee")
    /*@ApiResponse({
        type: CommonBalance,
    })*/
    getPrepareUtxos(
        @Param("fasset") fasset: string,
        @Param("amount") amount: string,
        @Param("recipient") recipient: string,
        @Param("memo") memo: string,
        @Param("fee") fee: string,
        @Body() selectedUtxos: SelectedUTXOAddress[],
        @Query("changeAddresses") changeAddresses?: string
    ): Promise<any> {
        try {
            const addressListChange = changeAddresses ? changeAddresses.split(",") : [];
            return this.utxoService.prepareUtxosForAmount(fasset, amount, recipient, memo, fee, addressListChange, selectedUtxos);
        } catch (error) {
            logger.error(`Error in prepare utxo for ${fasset}`, error);
            throw new HttpException(
                {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    error: "Error: " + error.message,
                },
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get("returnAddresses/:fasset/:amount/:address")
    @ApiResponse({
        type: ReturnAddresses,
    })
    getReturnAddresses(
        @Param("fasset") fasset: string,
        @Param("amount") amount: string,
        @Param("address") address: string,
        @Query("receiveAddresses") receiveAddresses?: string,
        @Query("changeAddresses") changeAddresses?: string
    ): Promise<ReturnAddresses> {
        try {
            const addressListReceive = receiveAddresses ? receiveAddresses.split(",") : [];
            const addressListChange = changeAddresses ? changeAddresses.split(",") : [];
            return this.utxoService.returnUtxosForAmount(fasset, amount, address, addressListReceive, addressListChange);
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

    @Get("mintEnabled")
    @ApiResponse({
        type: [FassetStatus],
    })
    getMintingEnabled(): Promise<FassetStatus[]> {
        try {
            return this.userService.getMintingEnabled();
        } catch (error) {
            logger.error(`Error in getMintEnabled`, error);
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
