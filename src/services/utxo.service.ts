/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from "@nestjs/common";
import { UTXOSLedger } from "../interfaces/requestResponse";
import { toBN, web3 } from "@flarelabs/fasset-bots-core/utils";
import { BotService } from "./bot.init.service";
import { LotsException } from "../exceptions/lots.exception";
import { SelectedUTXO, SelectedUTXOAddress } from "src/interfaces/structure";
import BN from "bn.js";
import { ExternalApiService } from "./external.api.service";
import { ConfigService } from "@nestjs/config";
import { UserService } from "./user.service";

const REMAIN_SATOSHIS = toBN(0);
const MAX_SEQUENCE = 4294967295;

@Injectable()
export class UtxoService {
    envType: string;
    constructor(
        private readonly botService: BotService,
        private readonly externalApiService: ExternalApiService,
        private readonly userService: UserService,
        private readonly configService: ConfigService
    ) {
        this.envType = this.configService.get<string>("APP_TYPE");
    }

    private async createSelectedUtxo(fasset: string, utxo: any, address: string, index: number): Promise<SelectedUTXOAddress> {
        return {
            txid: utxo.txid,
            vout: utxo.vout,
            value: utxo.value,
            hexTx: await this.externalApiService.getTransactionHexBlockBook(fasset, utxo.txid),
            path: utxo.path,
            utxoAddress: address,
            address: address,
            index: index,
        };
    }

    async returnUtxosForAmount(fasset: string, amount: string, address: string, receiveAddresses: string[], changeAddresses: string[]): Promise<any> {
        let amountBN = toBN(Math.floor(Number(amount)));
        const selectedUtxos: string[] = [];
        const utxosAddresses: SelectedUTXOAddress[] = [];
        let totalSelectedAmount = toBN(0);
        const fee = await this.userService.estimateFeeForBlocks(fasset);
        const feeBTC = Math.floor(Number(fee.extraBTC) * 10 ** 8);
        amountBN = amountBN.add(toBN(feeBTC));
        let ind = 0;
        const processUtxos = async (addresses: string[]): Promise<void> => {
            for (const addr of addresses) {
                if (totalSelectedAmount.gte(amountBN.add(REMAIN_SATOSHIS))) {
                    return;
                }

                const utxos = await this.externalApiService.getUtxosBlockBook(fasset, addr, false);
                const sortedUtxos = utxos.sort((a, b) => toBN(b.value).sub(toBN(a.value)).toNumber());

                if (sortedUtxos.length > 0) {
                    const largestUtxo = sortedUtxos[0];
                    totalSelectedAmount = totalSelectedAmount.add(toBN(largestUtxo.value));
                    utxosAddresses.push(await this.createSelectedUtxo(fasset, largestUtxo, addr, ind));
                    ind++;
                    if (!selectedUtxos.includes(addr)) {
                        selectedUtxos.push(addr);
                    }
                }

                const randomUtxos = this.shuffleArray(sortedUtxos.slice(1));
                for (const utxo of randomUtxos) {
                    if (totalSelectedAmount.gte(amountBN.add(REMAIN_SATOSHIS))) {
                        break;
                    }
                    totalSelectedAmount = totalSelectedAmount.add(toBN(utxo.value));
                    utxosAddresses.push(await this.createSelectedUtxo(fasset, utxo, addr, ind));
                    ind++;
                    if (!selectedUtxos.includes(addr)) {
                        selectedUtxos.push(addr);
                    }
                }
            }
        };

        await processUtxos([address]);
        await processUtxos(changeAddresses);
        await processUtxos(receiveAddresses);

        if (totalSelectedAmount.lt(amountBN)) {
            throw new LotsException("Insufficient funds to cover the amount and fees.");
        }
        selectedUtxos.sort((a, b) => {
            const hashA = this.doubleKeccak256(a);
            const hashB = this.doubleKeccak256(b);
            return hashA.localeCompare(hashB);
        });
        utxosAddresses.sort((a, b) => {
            const hashA = this.doubleKeccak256(a.address);
            const hashB = this.doubleKeccak256(b.address);
            return hashA.localeCompare(hashB);
        });
        for (let i = 0; i < utxosAddresses.length; i++) {
            utxosAddresses[i].index = i;
        }
        return { addresses: selectedUtxos, estimatedFee: feeBTC, utxos: utxosAddresses };
    }

    async calculateUtxosForAmount(fasset: string, xpub: string, amount: string): Promise<UTXOSLedger> {
        const utxos = await this.externalApiService.getUtxosBlockBook(fasset, xpub, true);
        const fee = await this.userService.estimateFeeForBlocks(fasset);
        const feeBTC = Math.floor(Number(fee.extraBTC) * 10 ** 8);
        const amountBN = toBN(Math.floor(Number(amount))).add(toBN(feeBTC));
        const sortedUtxos = utxos.sort((a, b) => {
            const valueA = toBN(a.value);
            const valueB = toBN(b.value);
            return valueB.sub(valueA).toNumber();
        });

        const selectedUtxos: SelectedUTXO[] = [];
        let totalSelectedAmount = toBN(0);

        const largestUtxo = sortedUtxos[0];
        selectedUtxos.push({
            txid: largestUtxo.txid,
            vout: largestUtxo.vout,
            value: largestUtxo.value,
            hexTx: await this.externalApiService.getTransactionHexBlockBook(fasset, largestUtxo.txid),
            path: largestUtxo.path,
            utxoAddress: largestUtxo.address,
        });
        totalSelectedAmount = totalSelectedAmount.add(toBN(largestUtxo.value));

        const remainingUtxos = sortedUtxos.slice(1);
        const randomUtxos = this.shuffleArray(remainingUtxos);

        for (const utxo of randomUtxos) {
            if (totalSelectedAmount.gte(amountBN.add(REMAIN_SATOSHIS))) {
                break;
            }
            selectedUtxos.push({
                txid: utxo.txid,
                vout: utxo.vout,
                value: utxo.value,
                hexTx: await this.externalApiService.getTransactionHexBlockBook(fasset, utxo.txid),
                path: utxo.path,
                utxoAddress: utxo.address,
            });
            totalSelectedAmount = totalSelectedAmount.add(toBN(utxo.value));
        }
        const change = totalSelectedAmount.sub(amountBN);
        if (totalSelectedAmount.lt(amountBN)) {
            throw new LotsException("Insufficient funds to cover the amount and fees.");
        }
        selectedUtxos.sort((a, b) => {
            const hashA = this.doubleKeccak256(a.utxoAddress);
            const hashB = this.doubleKeccak256(b.utxoAddress);
            return hashA.localeCompare(hashB);
        });
        const selectedAddresses = [];
        for (const u of selectedUtxos) {
            if (!selectedAddresses.includes(u.utxoAddress)) {
                selectedAddresses.push(u.utxoAddress);
            }
        }
        return { selectedUtxos: selectedUtxos, estimatedFee: feeBTC, returnAddresses: selectedAddresses };
    }

    private doubleKeccak256(address: string): string {
        const firstHash = web3.utils.keccak256(address);
        return web3.utils.keccak256(firstHash);
    }

    shuffleArray<T>(array: T[]): T[] {
        const shuffledArray = array.slice();
        for (let i = shuffledArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
        }
        return shuffledArray;
    }

    async prepareUtxosForAmount(
        fasset: string,
        amount: string,
        recipient: string,
        memo: string,
        fee: string,
        changeAddresses: string[],
        selectedUtxos: SelectedUTXOAddress[]
    ): Promise<any> {
        const amountBN = toBN(Math.floor(Number(amount))).add(toBN(fee));
        let totalSelectedAmount = toBN(0);
        for (const u of selectedUtxos) {
            totalSelectedAmount = totalSelectedAmount.add(toBN(u.value));
        }

        if (totalSelectedAmount.lt(amountBN)) {
            throw new Error("Insufficient funds to cover the amount with a minimum of 10k satoshis for change.");
        }
        const psbt = await this.createPsbt(fasset, selectedUtxos, toBN(amount), changeAddresses, recipient, totalSelectedAmount, memo, fee);
        return { psbt, selectedUtxos };
    }

    private async createPsbt(
        fasset: string,
        selectedUtxos: SelectedUTXOAddress[],
        amountBN: BN,
        changeAddresses: string[],
        recipient: string,
        totalSelectedAmount: BN,
        memo: string,
        fee: string
    ): Promise<any> {
        if (fasset.includes("BTC")) {
            const bitcoin = await import("bitcoinjs-lib");
            const network = this.envType == "dev" ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

            const psbt = new bitcoin.Psbt({ network });

            for (let i = 0; i < selectedUtxos.length; i++) {
                const utxo = selectedUtxos[i];
                const isSegWit = utxo.address.startsWith("bc1") || utxo.address.startsWith("tb1");
                if (isSegWit) {
                    psbt.addInput({
                        hash: utxo.txid,
                        index: utxo.vout,
                        witnessUtxo: {
                            value: BigInt(utxo.value),
                            script: bitcoin.address.toOutputScript(utxo.utxoAddress, network),
                        },
                        sequence: MAX_SEQUENCE - 1,
                    });
                } else {
                    psbt.addInput({
                        hash: utxo.txid,
                        index: utxo.vout,
                        nonWitnessUtxo: Buffer.from(utxo.hexTx, "hex"),
                        sequence: MAX_SEQUENCE - 1,
                    });
                }
            }

            psbt.addOutput({
                address: recipient,
                value: BigInt(amountBN.toString()),
            });

            const embedMemo = bitcoin.payments.embed({
                data: [Buffer.from(memo, "hex")],
                network: network,
            });
            psbt.addOutput({
                script: embedMemo.output!,
                value: BigInt(0),
            });
            const changeAmount = totalSelectedAmount.sub(amountBN).sub(toBN(fee));
            let changeAddress = changeAddresses[0];
            for (const a of changeAddresses) {
                const mainAddressBalancesUTXO = await this.externalApiService.getAddressInfoBlockBook(fasset, a);
                const utxoBalance = toBN(mainAddressBalancesUTXO.balance);
                if (utxoBalance.eqn(0)) {
                    changeAddress = a;
                }
            }
            if (changeAmount.gte(REMAIN_SATOSHIS)) {
                psbt.addOutput({
                    address: changeAddress,
                    value: BigInt(changeAmount.toString()),
                });
            }
            return psbt.toBase64();
        }
        if (fasset.includes("DOGE")) {
            const bitcoin = await import("bitcoinjs-lib");
            const getNetwork = (isTestnet: boolean) => ({
                messagePrefix: "\x19Dogecoin Signed Message:\n",
                bech32: "doge",
                bip32: isTestnet ? { public: 0x043587cf, private: 0x04358394 } : { public: 0x02facafd, private: 0x02fac398 },
                pubKeyHash: isTestnet ? 0x71 : 0x1e,
                scriptHash: isTestnet ? 0xc4 : 0x16,
                wif: isTestnet ? 0xf1 : 0x9e,
            });
            const network = getNetwork(this.envType == "dev");
            const psbt = new bitcoin.Psbt({ network });
            for (let i = 0; i < selectedUtxos.length; i++) {
                const utxo = selectedUtxos[i];
                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    nonWitnessUtxo: Buffer.from(utxo.hexTx, "hex"),
                    sequence: MAX_SEQUENCE - 1,
                });
            }

            psbt.addOutput({
                address: recipient,
                value: BigInt(amountBN.toString()),
            });

            if (memo) {
                const embedMemo = bitcoin.payments.embed({
                    data: [Buffer.from(memo, "hex")],
                });
                psbt.addOutput({
                    script: embedMemo.output!,
                    value: BigInt(0),
                });
            }

            const changeAmount = totalSelectedAmount.sub(amountBN).sub(toBN(fee));
            if (changeAmount.gte(REMAIN_SATOSHIS)) {
                const changeAddress = changeAddresses[0];
                psbt.addOutput({
                    address: changeAddress,
                    value: BigInt(changeAmount.toString()),
                });
            }

            return psbt.toBase64();
        }
    }
}
