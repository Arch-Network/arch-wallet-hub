import { describe, it, expect } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { Buffer } from "buffer";
import {
  assertPsbtSighashTypesAllowed,
  assertSignedInputsAreNetworkUtxos,
  selectPsbtInputsToSign,
} from "../psbt-checks";

bitcoin.initEccLib(ecc as any);

function p2tr(seed: number) {
  const internalPubkey = Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, seed), true)!.slice(1, 33));
  const testnet = bitcoin.payments.p2tr({ internalPubkey, network: bitcoin.networks.testnet });
  const mainnet = bitcoin.payments.p2tr({ internalPubkey, network: bitcoin.networks.bitcoin });
  return { script: Buffer.from(testnet.output!), address: testnet.address!, mainnetAddress: mainnet.address! };
}

const MINE = p2tr(0x21);
const THEIRS = p2tr(0x22);
const txid = (n: number) => n.toString(16).padStart(64, "0");

/** Inputs: 0 = mine (10k), 1 = mine (20k), 2 = theirs (30k). */
function buildPsbt(sighashTypes: Array<number | undefined> = []) {
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  const inputs = [
    { owner: MINE, value: 10_000n },
    { owner: MINE, value: 20_000n },
    { owner: THEIRS, value: 30_000n },
  ];
  inputs.forEach((input, i) => {
    psbt.addInput({
      hash: txid(i + 1),
      index: i,
      witnessUtxo: { script: input.owner.script, value: input.value },
    });
  });
  psbt.addOutput({ address: THEIRS.address, value: 55_000n });
  const parsed = bitcoin.Psbt.fromBase64(psbt.toBase64(), { network: bitcoin.networks.testnet });
  sighashTypes.forEach((type, i) => {
    if (type !== undefined) parsed.data.inputs[i]!.sighashType = type;
  });
  return parsed;
}

describe("assertPsbtSighashTypesAllowed", () => {
  it("allows absent, SIGHASH_DEFAULT and SIGHASH_ALL", () => {
    expect(() => assertPsbtSighashTypesAllowed(buildPsbt([undefined, 0x00, 0x01]))).not.toThrow();
  });

  it.each([
    ["NONE", 0x02],
    ["SINGLE", 0x03],
    ["ALL|ANYONECANPAY", 0x81],
    ["SINGLE|ANYONECANPAY", 0x83],
  ])("rejects %s on any input, including one we would not sign", (_label, type) => {
    expect(() => assertPsbtSighashTypesAllowed(buildPsbt([undefined, undefined, type]))).toThrow(
      new RegExp(`input 2 requests sighash type 0x${type.toString(16)}`),
    );
  });
});

describe("selectPsbtInputsToSign", () => {
  it("defaults to every input the signer owns", () => {
    expect(selectPsbtInputsToSign(buildPsbt(), MINE.address, undefined)).toEqual([0, 1]);
  });

  it("signs only the listed inputs", () => {
    expect(selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.address]: [1] })).toEqual([1]);
  });

  it("matches signInputs addresses by script, whatever the network encoding", () => {
    expect(selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.mainnetAddress]: [0] })).toEqual([0]);
  });

  it("rejects an out-of-range index", () => {
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.address]: [3] })).toThrow(/out of range/);
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.address]: [-1] })).toThrow(/out of range/);
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.address]: [0.5] })).toThrow(/out of range/);
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.address]: ["0"] })).toThrow(/out of range/);
  });

  it("rejects an index the signer does not own", () => {
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.address]: [2] })).toThrow(/input 2 is not owned/);
  });

  it("rejects another party's address", () => {
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, { [THEIRS.address]: [2] })).toThrow(/not the signing account/);
  });

  it("rejects malformed or empty signInputs", () => {
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, [0])).toThrow(/must map/);
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, null)).toThrow(/must map/);
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, { [MINE.address]: 0 })).toThrow(/array/);
    expect(() => selectPsbtInputsToSign(buildPsbt(), MINE.address, {})).toThrow(/no inputs/);
  });

  it("rejects a PSBT with nothing for the signer to sign", () => {
    expect(() => selectPsbtInputsToSign(buildPsbt(), p2tr(0x23).address, undefined)).toThrow(/no inputs owned/);
  });
});

describe("assertSignedInputsAreNetworkUtxos", () => {
  const utxos = [
    { txid: txid(1), vout: 0, value: 10_000 },
    { txid: txid(2), vout: 1, value: 20_000 },
  ];

  it("passes when every signed input is a wallet UTXO at the stated amount", () => {
    expect(() => assertSignedInputsAreNetworkUtxos(buildPsbt(), [0, 1], utxos)).not.toThrow();
  });

  it("does not require foreign, unsigned inputs to be wallet UTXOs", () => {
    expect(() => assertSignedInputsAreNetworkUtxos(buildPsbt(), [0], utxos.slice(0, 1))).not.toThrow();
  });

  it("rejects an input that does not exist on the selected network", () => {
    expect(() => assertSignedInputsAreNetworkUtxos(buildPsbt(), [0, 1], utxos.slice(0, 1))).toThrow(/input 1/);
  });

  it("rejects an input whose stated amount differs from the network's", () => {
    const lied = [utxos[0]!, { ...utxos[1]!, value: 19_999 }];
    expect(() => assertSignedInputsAreNetworkUtxos(buildPsbt(), [0, 1], lied)).toThrow(/input 1/);
  });

  it("rejects the same txid at a different vout", () => {
    const wrongVout = [{ ...utxos[0]!, vout: 5 }];
    expect(() => assertSignedInputsAreNetworkUtxos(buildPsbt(), [0], wrongVout)).toThrow(/input 0/);
  });

  it("fails closed on an empty UTXO set", () => {
    expect(() => assertSignedInputsAreNetworkUtxos(buildPsbt(), [0], [])).toThrow(/input 0/);
  });
});
