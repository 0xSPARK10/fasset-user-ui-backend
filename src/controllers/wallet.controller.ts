import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiKeyGuard } from "src/guards/api.guard";
import { WalletService } from "src/services/wallet.service";

@ApiTags("Wallet")
@Controller("api")
@ApiSecurity("api_key")
@UseGuards(ApiKeyGuard)
export class WalletController {
    constructor(private readonly walletService: WalletService) {}

    @Get("wallets")
    @ApiOperation({ summary: "Get wallet ids." })
    @ApiQuery({ name: "limit", required: false, type: Number, description: "Max number of ids to return." })
    @ApiQuery({ name: "offset", required: false, type: Number, description: "List offset, default 0" })
    async getWallets(@Query("limit") limit = 10, @Query("offset") offset = 0) {
        return this.walletService.getPaginatedWallets(offset, limit);
    }
}
