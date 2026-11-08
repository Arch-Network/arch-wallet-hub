/**
 * Signing policy for dapp-supplied PSBTs (SIGN_PSBT), applied before
 * any input is signed.
 */
import * as bitcoin from "bitcoinjs-lib";
import { bytesToHex } from "./bip322";

function scriptHexForAddress(address: string): string | null {
  for (const network of [bitcoin.networks.bitcoin, bitcoin.networks.testnet, bitcoin.networks.regtest]) {
    try {
      return bytesToHex(bitcoin.address.toOutputScript(address, network));
    } catch {
      // try the next network's encoding
    }
  }
  return null;
}

function outpoint(psbt: bitcoin.Psbt, index: number): { txid: string; vout: number } {
  const txIn = psbt.txInputs[index]!;
  return { txid: bytesToHex(Uint8Array.from(txIn.hash).reverse()), vout: txIn.index };
}

/** Only SIGHASH_DEFAULT / SIGHASH_ALL, which commit to every input and output. */
export function assertPsbtSighashTypesAllowed(psbt: bitcoin.Psbt): void {
  psbt.data.inputs.forEach((input, i) => {
    const type = input.sighashType;
    if (type !== undefined && type !== bitcoin.Transaction.SIGHASH_DEFAULT && type !== bitcoin.Transaction.SIGHASH_ALL) {
      throw new Error(
        `PSBT input ${i} requests sighash type 0x${type.toString(16)}; only SIGHASH_DEFAULT and SIGHASH_ALL are signed.`,
      );
    }
  });
}

/**
 * Indexes of the inputs to sign. With `signInputs` (address -> indexes),
 * exactly those; every address must be the signer's and every index must
 * spend the signer's script. Without it, every input the signer owns.
 */
export function selectPsbtInputsToSign(
  psbt: bitcoin.Psbt,
  signerAddress: string,
  signInputs: unknown,
): number[] {
  const signerScript = scriptHexForAddress(signerAddress);
  if (!signerScript) throw new Error("Signing account has no valid Bitcoin address.");
  const owned = (i: number) => {
    const script = psbt.data.inputs[i]?.witnessUtxo?.script;
    return !!script && bytesToHex(script) === signerScript;
  };

  if (signInputs === undefined) {
    const all = psbt.data.inputs.map((_, i) => i).filter(owned);
    if (all.length === 0) throw new Error("This PSBT has no inputs owned by the signing account.");
    return all;
  }
  if (!signInputs || typeof signInputs !== "object" || Array.isArray(signInputs)) {
    throw new Error("signInputs must map addresses to input indexes.");
  }
  const selected = new Set<number>();
  for (const [address, indexes] of Object.entries(signInputs)) {
    if (scriptHexForAddress(address) !== signerScript) {
      throw new Error(`signInputs lists ${address}, which is not the signing account.`);
    }
    if (!Array.isArray(indexes)) throw new Error(`signInputs[${address}] must be an array of input indexes.`);
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= psbt.inputCount) {
        throw new Error(`signInputs index ${String(index)} is out of range for a ${psbt.inputCount}-input PSBT.`);
      }
      if (!owned(index)) throw new Error(`PSBT input ${index} is not owned by the signing account.`);
      selected.add(index);
    }
  }
  if (selected.size === 0) throw new Error("signInputs lists no inputs to sign.");
  return [...selected].sort((a, b) => a - b);
}

/**
 * Every input about to be signed must be one of the signer's unspent
 * outputs on the selected network (`networkUtxos` from that network's
 * indexer), at the amount the PSBT states. Inputs we don't sign aren't
 * checked: SIGHASH_DEFAULT/ALL commit to every prevout's amount and
 * script, so a misstated foreign input only invalidates our signature.
 */
export function assertSignedInputsAreNetworkUtxos(
  psbt: bitcoin.Psbt,
  inputsToSign: readonly number[],
  networkUtxos: ReadonlyArray<{ txid: string; vout: number; value: number }>,
): void {
  const byOutpoint = new Map(networkUtxos.map((u) => [`${u.txid.toLowerCase()}:${u.vout}`, u]));
  for (const i of inputsToSign) {
    const { txid, vout } = outpoint(psbt, i);
    const utxo = byOutpoint.get(`${txid}:${vout}`);
    const stated = psbt.data.inputs[i]?.witnessUtxo?.value;
    if (!utxo || stated === undefined || !Number.isSafeInteger(utxo.value) || BigInt(utxo.value) !== stated) {
      throw new Error(
        `PSBT input ${i} (${txid}:${vout}) is not an unspent output of this wallet on the selected network at the stated amount.`,
      );
    }
  }
}
