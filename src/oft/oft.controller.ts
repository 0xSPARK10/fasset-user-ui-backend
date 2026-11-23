import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBadRequestResponse, ApiExtraModels, ApiOperation, ApiQuery, ApiResponse, ApiTags, getSchemaPath } from "@nestjs/swagger";
import { isValidClassicAddress } from "xrpl";
import { OFTService } from "./oft.service";
import {
    ComposerFeeResponse,
    OFTHistory,
    OFTLimitResponse,
    OFTLimitsResponse,
    RedeemerAccountResponse,
    RedemptionFeesResponse,
} from "src/interfaces/requestResponse";

@ApiTags("OFT")
@Controller("api/oft")
export class OFTController {
    constructor(private readonly oftService: OFTService) {}

    @Get("limits")
    @ApiOperation({
        summary: "Get remaining OFT transfer capacity in drops, keyed by destination endpoint ID.",
        description:
            "Cached snapshot refreshed once per minute. Returns an empty object until the first successful refresh and keeps the last complete snapshot if a refresh fails. Unlimited capacity is represented by the maximum uint256 value.",
    })
    @ApiExtraModels(OFTLimitResponse)
    @ApiResponse({
        status: 200,
        schema: {
            type: "object",
            additionalProperties: { $ref: getSchemaPath(OFTLimitResponse) },
            example: { "30101": { incomingRemainingDrops: "1000", outgoingRemainingDrops: "2000" } },
        },
    })
    getLimits(): OFTLimitsResponse {
        return this.oftService.getLimits();
    }

    @Get("paused")
    @ApiOperation({ summary: "Get the OFT adapter's current on-chain paused status." })
    @ApiResponse({ status: 200, type: Boolean })
    getPaused(): Promise<boolean> {
        return this.oftService.getPaused();
    }

    @Get("userHistory/:address")
    @ApiOperation({
        summary: "Get OFT history for an EVM address and optional direct-mint history for an XRP address.",
        description:
            "Returns entries from the last seven days plus direct-mint bridge entries in AWAITING_RECOVERY or RECOVERY_PENDING regardless of age, newest first. Direct-mint bridge history requires xrpAddress. The supplied addresses select history records; this endpoint does not prove ownership of either wallet.",
    })
    @ApiQuery({
        name: "xrpAddress",
        required: false,
        type: String,
        description: "Checksum-valid XRP classic address used to select direct-mint bridge candidates.",
    })
    @ApiBadRequestResponse({ description: "xrpAddress is not a valid XRP classic address." })
    @ApiResponse({
        type: [OFTHistory],
    })
    getUserProgress(@Param("address") address: string, @Query("xrpAddress") xrpAddress?: string): Promise<OFTHistory[]> {
        if (xrpAddress !== undefined && !isValidClassicAddress(xrpAddress)) {
            throw new BadRequestException("xrpAddress must be a valid XRP classic address");
        }
        return this.oftService.getOFTHistory(address, xrpAddress);
    }

    @Get("shortHistory/:address")
    @ApiOperation({
        summary: "Get OFT redemption and direct-mint bridge history.",
        description:
            "Returns REDEEM, REDEEMFAIL, and DIRECT_MINT_BRIDGE entries from the last seven days plus direct-mint bridge entries in AWAITING_RECOVERY or RECOVERY_PENDING regardless of age, newest first. Direct-mint bridge history requires xrpAddress. The supplied addresses select history records; this endpoint does not prove ownership of either wallet.",
    })
    @ApiQuery({
        name: "xrpAddress",
        required: false,
        type: String,
        description: "Checksum-valid XRP classic address used to select direct-mint bridge candidates.",
    })
    @ApiBadRequestResponse({ description: "xrpAddress is not a valid XRP classic address." })
    @ApiResponse({
        type: [OFTHistory],
    })
    getShortHistory(@Param("address") address: string, @Query("xrpAddress") xrpAddress?: string): Promise<OFTHistory[]> {
        if (xrpAddress !== undefined && !isValidClassicAddress(xrpAddress)) {
            throw new BadRequestException("xrpAddress must be a valid XRP classic address");
        }
        return this.oftService.getOFTShortHistory(address, xrpAddress);
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
