/**
 * Inscription-transfer PSBT builder.
 *
 * Mirrors `btc-psbt.ts` / `rune-psbt.ts` in shape so the existing
 * sign/finalize/broadcast pipeline (Send page + Approve flow) can
 * consume the result without bespoke handling.
 *
 * Output layout (1 or 2 outputs):
 *   0: Recipient -- gets the inscribed output's FULL sat value. The
 *      inscribed UTXO is forced to input[0], so its sats (and the
 *      inscribed sat at any offset within it) flow entirely into
 *      output[0]. This is the standard "move the inscription whole"
 *      model used by Xverse / UniSat.
 *   1: Sender change -- whatever BTC remains from the plain-BTC fee
 *      inputs after the fee. Dropped (folded into fee) if below the
 *      sender-script dust threshold.
 *
 * Input layout: inscribed UTXO FIRST, then any plain-BTC top-ups for
 * the fee. The first-input position is what guarantees the inscribed
 * sat lands in output[0].
 *
 * Unlike rune sends there is NO OP_RETURN, so the standard PSBT
 * signing path works (no raw-sighash bypass).
 */
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { BtcFeeEstimates, IndexerClient } from "./indexer";
import { dustThresholdForAddress } from "./btc-dust";
import { selectUtxosForInscriptionSend } from "./inscription-coin-select";

const MIN_FALLBACK_FEE_RATE = 5;

let ecclibInitialized = false;
function ensureEccLib() {
  if (!ecclibInitialized) {
    bitcoin.initEccLib(ecc);
    ecclibInitialized = true;
  }
}

function networkFromAddress(addr: string): bitcoin.Network {
  const isTestnet = addr.startsWith("tb1") || addr.startsWith("bcrt1");
  return isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
}

/**
 * Approximate vsize for an inscription-transfer tx. Same per-input /
 * per-output deltas as the BTC builder; no OP_RETURN.
 */
export function estimateInscriptionTxSize(
  inputCount: number,
  outputCount: number
): number {
  return 10.5 + inputCount * 57.5 + outputCount * 43;
}

export interface BuildInscriptionPsbtParams {
  indexer: IndexerClient;
  fromAddress: string;
  toAddress: string;
  /** Inscription id, e.g. "<64-hex-txid>i<index>". */
  inscriptionId: string;
  /** Satpoint "txid:vout:offset" if known -- speeds up UTXO lookup. */
  satpoint?: string;
  feeRate?: number;
}

export interface BuildInscriptionPsbtResult {
  psbt: bitcoin.Psbt;
  network: bitcoin.Network;
  fromAddress: string;
  toAddress: string;
  inscriptionId: string;
  /** Sat value sent to the recipient (the inscribed output value). */
  recipientSats: number;
  changeSats: number;
  feeSats: number;
  feeRate: number;
  inputCount: number;
  btcInputCount: number;
}

export async function buildUnsignedInscriptionPsbt(
  params: BuildInscriptionPsbtParams
): Promise<BuildInscriptionPsbtResult> {
  ensureEccLib();
  const { indexer, fromAddress, toAddress, inscriptionId, satpoint } = params;

  const utxos = await indexer.getBtcAddressUtxos(fromAddress);
  if (!Array.isArray(utxos) || utxos.length === 0) {
    const err = new Error("No UTXOs available for this address");
    (err as any).code = "NO_UTXOS";
    throw err;
  }

  let feeRate = params.feeRate;
  if (!feeRate) {
    try {
      const estimates = (await indexer.getBtcFeeEstimates()) as BtcFeeEstimates;
      feeRate = estimates["6"] ?? estimates["3"] ?? MIN_FALLBACK_FEE_RATE;
    } catch {
      feeRate = MIN_FALLBACK_FEE_RATE;
    }
  }

  // First pass: assume 1 fee input (2 inputs total) + 2 outputs, then
  // refine with the actual input count from the selection.
  let estimatedFee = Math.ceil(estimateInscriptionTxSize(2, 2) * feeRate);
  let selection = selectUtxosForInscriptionSend({
    utxos,
    inscriptionId,
    satpoint,
    feeSats: estimatedFee
  });

  const firstInputCount = 1 + selection.btcInputs.length;
  estimatedFee = Math.ceil(estimateInscriptionTxSize(firstInputCount, 2) * feeRate);
  selection = selectUtxosForInscriptionSend({
    utxos,
    inscriptionId,
    satpoint,
    feeSats: estimatedFee
  });

  const inputCount = 1 + selection.btcInputs.length;
  const finalFee = Math.ceil(estimateInscriptionTxSize(inputCount, 2) * feeRate);

  // Recipient gets the inscribed output whole; the fee comes out of
  // the plain-BTC inputs, and whatever's left of those is change.
  const recipientSats = selection.inscribedValueSats;
  const btcInputSats = selection.totalInputSats - recipientSats;
  let changeSats = btcInputSats - finalFee;

  const network = networkFromAddress(fromAddress);
  const psbt = new bitcoin.Psbt({ network });
  const fromScript = bitcoin.address.toOutputScript(fromAddress, network);

  // Inputs: inscribed UTXO FIRST (pins the inscribed sat to output 0),
  // then plain-BTC fee inputs.
  const allInputs = [selection.inscribedUtxo, ...selection.btcInputs];
  for (const u of allInputs) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: {
        script: fromScript,
        value: BigInt(u.value)
      }
    });
  }

  // Output 0: recipient gets the inscribed output value.
  psbt.addOutput({ address: toAddress, value: BigInt(recipientSats) });

  // Output 1: sender change. Drop below the sender-script dust limit
  // (fold into fee) -- an un-relayable change output would block the
  // whole tx.
  const changeDust = dustThresholdForAddress(fromAddress);
  if (changeSats > changeDust) {
    psbt.addOutput({ address: fromAddress, value: BigInt(changeSats) });
  } else {
    changeSats = 0;
  }

  return {
    psbt,
    network,
    fromAddress,
    toAddress,
    inscriptionId,
    recipientSats,
    changeSats,
    feeSats: finalFee,
    feeRate,
    inputCount,
    btcInputCount: selection.btcInputs.length
  };
}
