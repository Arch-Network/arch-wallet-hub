import { describe, it, expect } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { Buffer } from "buffer";
import { summarizePsbt } from "../psbt-summary";

bitcoin.initEccLib(ecc as any);

const internal = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x11), true)!.slice(1, 33));
const testnetAddress = bitcoin.payments.p2tr({ internalPubkey: internal, network: bitcoin.networks.testnet }).address!;
const mainnet = bitcoin.payments.p2tr({ internalPubkey: internal, network: bitcoin.networks.bitcoin });

function psbtHex(): string {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
  psbt.addInput({ hash: "11".repeat(32), index: 0, witnessUtxo: { script: mainnet.output!, value: 10_000n } });
  psbt.addOutput({ script: mainnet.output!, value: 9_000n });
  return psbt.toHex();
}

describe("summarizePsbt", () => {
  it("renders addresses for the selected network, not the stored address's network", () => {
    const summary = summarizePsbt(psbtHex(), [mainnet.address!], "mainnet");
    expect(summary.network).toBe("mainnet");
    expect(summary.outputs[0]!.address).toBe(mainnet.address);
    expect(summary.outputs[0]!.isMine).toBe(true);
    expect(summary.inputs[0]!.isMine).toBe(true);
  });

  it("renders testnet addresses when the wallet is on testnet", () => {
    const summary = summarizePsbt(psbtHex(), [testnetAddress], "testnet");
    expect(summary.network).toBe("testnet");
    expect(summary.outputs[0]!.address).toBe(testnetAddress);
  });

  it("uses the selected network even when handed a differently-encoded address", () => {
    const summary = summarizePsbt(psbtHex(), [testnetAddress], "mainnet");
    expect(summary.network).toBe("mainnet");
    expect(summary.outputs[0]!.address).toBe(mainnet.address);
  });
});
