/**
 * Rune-transfer PSBT builder.
 *
 * Mirrors `btc-psbt.ts` in shape so the existing sign/finalize/
 * broadcast pipeline (Send page + Approve flow) can consume the
 * result without bespoke handling for rune sends.
 *
 * Output layout we always emit (3 outputs):
 *   0: OP_RETURN runestone (value 0)
 *      - Edict points target rune amount at output 1 (recipient)
 *      - Pointer points at output 2 (change) for leftover-rune
 *        balance if any. WITHOUT a pointer, leftover runes BURN.
 *   1: Recipient (P2TR / P2WPKH / etc) with dust value (546 sats)
 *   2: Sender change with whatever BTC remains after fees
 *
 * Input layout: runed UTXOs FIRST, then any BTC top-ups. The
 * runestone format doesn't care about input order, but a stable
 * order keeps the approval-screen preview consistent and makes
 * test golden values stable.
 *
 * Fee + size estimation:
 *   - We run coin-select with an initial 1-input fee estimate
 *   - Re-estimate with actual input count
 *   - Re-select once with the bumped fee (a single refinement
 *     iteration is sufficient -- the size delta from an extra
 *     input is ~57.5 vbytes, which at typical fee rates of 5-30
 *     sat/vB is ~300-1700 sats; if the first selection had ANY
 *     headroom this won't need another iteration)
 */
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { BtcFeeEstimates, IndexerClient } from "./indexer";
import { bytesToHex, buildRunestoneOpReturn } from "./runestone";
import { selectUtxosForRuneSend } from "./rune-coin-select";

const RUNE_OUTPUT_DUST_SATS = 546;
const CHANGE_DUST_SATS = 546;
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
 * Approximate vsize for a rune-transfer tx. Same per-input/per-output
 * deltas as the BTC builder, plus a flat 35 vbytes for the OP_RETURN
 * runestone output (push prefix + payload, conservative ceiling for
 * the typical 8-12 byte transfer payload).
 */
export function estimateRuneTxSize(inputCount: number): number {
  // Base 10.5 vbytes + N P2TR-ish inputs (57.5 each) + 2 dust outputs
  // (43 each) + ~35 for OP_RETURN.
  return 10.5 + inputCount * 57.5 + 2 * 43 + 35;
}

export interface BuildRunePsbtParams {
  indexer: IndexerClient;
  fromAddress: string;
  toAddress: string;
  /** RuneId in "block:tx" form */
  runeId: string;
  /** Amount in MINOR units (u128 -- BigInt). Caller is responsible
   *  for applying divisibility before calling. */
  amount: bigint;
  feeRate?: number;
}

export interface BuildRunePsbtResult {
  psbt: bitcoin.Psbt;
  network: bitcoin.Network;
  fromAddress: string;
  toAddress: string;
  runeId: string;
  amount: bigint;
  /** Leftover rune balance that flows to change via pointer. */
  leftoverRune: bigint;
  recipientSats: number;
  changeSats: number;
  feeSats: number;
  feeRate: number;
  inputCount: number;
  runedInputCount: number;
  btcInputCount: number;
  /** Hex of the OP_RETURN runestone script -- for approval-screen
   *  display + golden tests. */
  runestoneScriptHex: string;
}

export async function buildUnsignedRunePsbt(
  params: BuildRunePsbtParams
): Promise<BuildRunePsbtResult> {
  ensureEccLib();
  const { indexer, fromAddress, toAddress, runeId, amount } = params;

  if (amount <= 0n) {
    const err = new Error("Amount must be > 0");
    (err as any).code = "INVALID_AMOUNT";
    throw err;
  }

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

  // First pass: assume 1 input for the fee estimate, then refine.
  let estimatedFee = Math.ceil(estimateRuneTxSize(1) * feeRate);
  let selection = selectUtxosForRuneSend({
    utxos,
    targetRuneId: runeId,
    targetAmount: amount,
    recipientDustSats: RUNE_OUTPUT_DUST_SATS,
    changeDustSats: CHANGE_DUST_SATS,
    feeSats: estimatedFee
  });

  // Second pass with the actual input count. If this needs another
  // input than the first pass picked, the larger fee (and possibly
  // the new input's value) is reflected in the resulting selection.
  const firstInputCount =
    selection.runedInputs.length + selection.btcInputs.length;
  estimatedFee = Math.ceil(estimateRuneTxSize(firstInputCount) * feeRate);
  selection = selectUtxosForRuneSend({
    utxos,
    targetRuneId: runeId,
    targetAmount: amount,
    recipientDustSats: RUNE_OUTPUT_DUST_SATS,
    changeDustSats: CHANGE_DUST_SATS,
    feeSats: estimatedFee
  });

  const inputCount =
    selection.runedInputs.length + selection.btcInputs.length;
  const finalFee = Math.ceil(estimateRuneTxSize(inputCount) * feeRate);
  const changeSats = selection.totalInputSats - RUNE_OUTPUT_DUST_SATS - finalFee;

  // Defense in depth: after selection + final fee, change should
  // be at or above CHANGE_DUST_SATS by construction. If it's not,
  // something drifted between selection and final fee math and we
  // refuse rather than emitting a tx that burns the leftover rune.
  if (changeSats < CHANGE_DUST_SATS) {
    const err = new Error(
      `Change ${changeSats} sats fell below dust ${CHANGE_DUST_SATS}; ` +
        `refusing to emit a runestone with no valid pointer output`
    );
    (err as any).code = "CHANGE_UNDER_DUST";
    throw err;
  }

  // Build the runestone OP_RETURN script. Pointer is set when there's
  // leftover rune to preserve; omitted when the user sent the full
  // input balance (no leftover, nothing to pointer).
  const runestoneScript = buildRunestoneOpReturn(
    [{ runeId, amount, output: 1 }],
    selection.leftoverRune > 0n ? { pointer: 2 } : {}
  );

  const network = networkFromAddress(fromAddress);
  const psbt = new bitcoin.Psbt({ network });
  const fromScript = bitcoin.address.toOutputScript(fromAddress, network);

  // Inputs: runed first, then BTC. Order doesn't affect the runestone
  // (it's output-driven) but keeps approval-screen rendering stable.
  const allInputs = [...selection.runedInputs, ...selection.btcInputs];
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

  // Output 0: OP_RETURN runestone (value 0 is mandatory for
  // OP_RETURN; non-zero would render the tx non-standard).
  psbt.addOutput({
    script: Buffer.from(runestoneScript),
    value: 0n
  });

  // Output 1: recipient gets dust + the edicted rune amount.
  psbt.addOutput({
    address: toAddress,
    value: BigInt(RUNE_OUTPUT_DUST_SATS)
  });

  // Output 2: sender's change (pointer target for leftover rune).
  psbt.addOutput({
    address: fromAddress,
    value: BigInt(changeSats)
  });

  return {
    psbt,
    network,
    fromAddress,
    toAddress,
    runeId,
    amount,
    leftoverRune: selection.leftoverRune,
    recipientSats: RUNE_OUTPUT_DUST_SATS,
    changeSats,
    feeSats: finalFee,
    feeRate,
    inputCount,
    runedInputCount: selection.runedInputs.length,
    btcInputCount: selection.btcInputs.length,
    runestoneScriptHex: bytesToHex(runestoneScript)
  };
}
