import { DirectMinting, DirectMintingStatus } from "../src/entities/DirectMinting";
import { DirectMintingRecoveryPayment } from "../src/entities/DirectMintingRecoveryPayment";
import { DirectMintingExecutedEvent } from "../src/entities/DirectMintingExecutedEvent";
import { DirectMintingExecutedToSmartAccountEvent } from "../src/entities/DirectMintingExecutedToSmartAccountEvent";

describe("Direct minting MBE-01 entity state", () => {
    it("defines both pending recovery states and initializes the smart-status throttle to null", () => {
        const directMinting = new DirectMinting("ABC123", "rUser", null, "oft_candidate", null, "1000000", 1_725_000_000_000, "FTestXRP");

        expect(DirectMintingStatus.AWAITING_RECOVERY).toBe("AWAITING_RECOVERY");
        expect(DirectMintingStatus.RECOVERY_PENDING).toBe("RECOVERY_PENDING");
        expect(directMinting.smartStatusLastCheckedAt).toBeNull();
        expect(directMinting.destinationEid).toBeNull();
        expect(directMinting.destinationKind).toBeNull();

        directMinting.smartStatusLastCheckedAt = 1_725_000_060_000;
        expect(directMinting.smartStatusLastCheckedAt).toBe(1_725_000_060_000);
    });

    it("keeps a recovery payment's own hash and original target available for later matching", () => {
        const recovery = new DirectMintingRecoveryPayment("0xRecovery", "0xOriginal", "rUser", "FTestXRP", 1_725_000_000_000);

        expect(recovery).toMatchObject({
            txhash: "0xRecovery",
            originalTxHash: "0xOriginal",
            userAddress: "rUser",
            fasset: "FTestXRP",
            timestamp: 1_725_000_000_000,
            processed: false,
        });
    });

    it("stores a provided block number on an ordinary execution event", () => {
        const event = new DirectMintingExecutedEvent(
            "abc123",
            "0xTarget",
            "0xExecutor",
            "900000",
            "50000",
            "50000",
            1_725_000_000_000,
            "0xEvmTx",
            "FTestXRP",
            12_345_678
        );

        expect(event.blockNumber).toBe(12_345_678);
    });

    it("defaults an execution-event block number to null for existing call sites", () => {
        const event = new DirectMintingExecutedToSmartAccountEvent(
            "abc123",
            "rUser",
            "0xExecutor",
            "900000",
            "50000",
            "0xFE",
            1_725_000_000_000,
            "0xEvmTx",
            "FTestXRP"
        );

        expect(event.blockNumber).toBeNull();
    });
});
