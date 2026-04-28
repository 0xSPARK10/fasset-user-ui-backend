import { Controller, Get, Param } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { OFTService } from "./oft.service";
import { ComposerFeeResponse, OFTHistory, RedeemerAccountResponse, RedemptionFeesResponse } from "src/interfaces/requestResponse";

@ApiTags("OFT")
@Controller("api/oft")
export class OFTController {
    constructor(private readonly oftService: OFTService) {}

    @Get("userHistory/:address")
    @ApiResponse({
        type: [OFTHistory],
    })
    getUserProgress(@Param("address") address: string): Promise<OFTHistory[]> {
        return this.oftService.getOFTHistory(address);
    }

    @Get("composerFee/:srcEid")
    @ApiOperation({ summary: "Get composer fee PPM for a given source endpoint ID." })
    @ApiResponse({
        type: ComposerFeeResponse,
    })
    getComposerFee(@Param("srcEid") srcEid: string): Promise<ComposerFeeResponse> {
        return this.oftService.getComposerFee(Number(srcEid));
    }

    @Get("redemptionFees/:srcEid")
    @ApiOperation({ summary: "Get composer fee and executor fee for redemptions." })
    @ApiResponse({
        type: RedemptionFeesResponse,
    })
    getRedemptionFees(@Param("srcEid") srcEid: string): Promise<RedemptionFeesResponse> {
        return this.oftService.getRedemptionFees(Number(srcEid));
    }

    @Get("redeemerAccount/:redeemer")
    @ApiOperation({ summary: "Get redeemer account address and its native balances." })
    @ApiResponse({
        type: RedeemerAccountResponse,
    })
    getRedeemerAccountAddress(@Param("redeemer") redeemer: string): Promise<RedeemerAccountResponse> {
        return this.oftService.getRedeemerAccountAddress(redeemer);
    }
}
