import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { BtcUtxo, IndexerClient } from "./indexer";
import { partitionByProtection } from "./btc-protection";

// bitcoinjs-lib v6 needs an ECC backend wired in for taproot helpers.
// `@bitcoinerlab/secp256k1` is a pure-JS implementation that works in
// MV3 service workers (no WASM, no native bindings).
let ecclibInitialized = false;
function ensureEccLib() {
  if (!ecclibInitialized) {
    bitcoin.initEccLib(ecc);
    ecclibInitialized = true;
  }
}

export interface BuildPsbtParams {
  indexer: IndexerClient;
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeRate?: number;
}

export interface BuildPsbtResult {
  psbt: bitcoin.Psbt;
  network: bitcoin.Network;
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeSats: number;
  feeRate: number;
  changeSats: number;
  inputCount: number;
}

const DUST_THRESHOLD_SATS = 546;
const MIN_FALLBACK_FEE_RATE = 5;

/**
 * Coin selection for a plain BTC send. Filters out protected UTXOs
 * (inscriptions, runes, risky_runes) BEFORE sorting, so an inscribed
 * 50,000-sat output can never be selected as fee fodder over a plain
 * 10,000-sat output.
 *
 * Two failure modes, distinguishable by error code:
 *   - INSUFFICIENT_SPENDABLE_BTC: spendable subset alone can't cover
 *     target+fee, but protected UTXOs would have. Caller is expected
 *     to surface "you have BTC, but it's locked in inscriptions/runes".
 *   - INSUFFICIENT_BALANCE: total balance (spendable + protected) is
 *     also under target+fee. Plain "not enough BTC" failure.
 *
 * Behavior on legacy / unenriched UTXO lists is unchanged: when no
 * UTXO carries protection metadata, partitionByProtection returns
 * the entire list as spendable and selection proceeds as before.
 */
/** Exported for unit tests; `buildUnsignedPsbt` is the production entry. */
export function selectUtxos(
  utxos: BtcUtxo[],
  targetSats: number,
  feeSats: number
): { selected: BtcUtxo[]; totalInput: number } {
  const { spendable, spendableSats, protectedSats } =
    partitionByProtection(utxos);

  const needed = targetSats + feeSats;
  const sorted = [...spendable].sort((a, b) => b.value - a.value);
  const selected: BtcUtxo[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= needed) break;
  }

  if (total < needed) {
    // Caller can distinguish the two failure modes by the error code:
    // if some protected UTXOs would have unblocked the send, point
    // the user at their inscriptions / runes specifically.
    if (protectedSats > 0 && spendableSats + protectedSats >= needed) {
      const err = new Error(
        `Insufficient spendable BTC: have ${spendableSats} sats spendable + ${protectedSats} sats locked in inscriptions/runes, need ${needed} sats (${targetSats} + ${feeSats} fee). Move or sell the protected assets first.`
      );
      (err as any).code = "INSUFFICIENT_SPENDABLE_BTC";
      (err as any).spendableSats = spendableSats;
      (err as any).protectedSats = protectedSats;
      throw err;
    }
    const err = new Error(
      `Insufficient BTC balance: have ${total} sats, need ${needed} sats (${targetSats} + ${feeSats} fee)`
    );
    (err as any).code = "INSUFFICIENT_BALANCE";
    throw err;
  }

  return { selected, totalInput: total };
}

/** Approximate vsize for a P2TR-only tx with `inputCount` inputs and `outputCount` outputs. */
function estimateTxSize(inputCount: number, outputCount: number): number {
  return 10.5 + inputCount * 57.5 + outputCount * 43;
}

function networkFromAddress(addr: string): bitcoin.Network {
  const isTestnet = addr.startsWith("tb1") || addr.startsWith("bcrt1");
  return isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
}

/**
 * Build an unsigned BTC PSBT client-side using the Indexer for UTXOs and fee
 * estimates. Mirrors the Hub helper at services/wallet-hub-api/src/routes/btcTransactions.ts
 * so behaviour stays identical to the previous server-built path.
 */
export async function buildUnsignedPsbt(params: BuildPsbtParams): Promise<BuildPsbtResult> {
  ensureEccLib();

  const { indexer, fromAddress, toAddress, amountSats } = params;

  const utxos = await indexer.getBtcAddressUtxos(fromAddress);
  if (!Array.isArray(utxos) || utxos.length === 0) {
    const err = new Error("No UTXOs available for this address");
    (err as any).code = "NO_UTXOS";
    throw err;
  }

  let feeRate = params.feeRate;
  if (!feeRate) {
    try {
      const estimates = await indexer.getBtcFeeEstimates();
      feeRate = estimates["6"] ?? estimates["3"] ?? MIN_FALLBACK_FEE_RATE;
    } catch {
      feeRate = MIN_FALLBACK_FEE_RATE;
    }
  }

  const estimatedFee = Math.ceil(estimateTxSize(1, 2) * feeRate);
  const { selected, totalInput } = selectUtxos(utxos, amountSats, estimatedFee);

  const actualSize = estimateTxSize(selected.length, 2);
  const actualFee = Math.ceil(actualSize * feeRate);
  const changeSats = totalInput - amountSats - actualFee;

  const network = networkFromAddress(fromAddress);
  const psbt = new bitcoin.Psbt({ network });

  for (const utxo of selected) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.address.toOutputScript(fromAddress, network),
        value: BigInt(utxo.value)
      }
    });
  }

  psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });
  if (changeSats > DUST_THRESHOLD_SATS) {
    psbt.addOutput({ address: fromAddress, value: BigInt(changeSats) });
  }

  return {
    psbt,
    network,
    fromAddress,
    toAddress,
    amountSats,
    feeSats: actualFee,
    feeRate,
    changeSats: changeSats > DUST_THRESHOLD_SATS ? changeSats : 0,
    inputCount: selected.length
  };
}

/**
 * Finalize a signed PSBT (base64) and return the raw transaction hex ready for
 * broadcast.
 */
export function finalizeSignedPsbt(signedPsbtBase64: string, network: bitcoin.Network): string {
  ensureEccLib();
  const psbt = bitcoin.Psbt.fromBase64(signedPsbtBase64, { network });
  psbt.finalizeAllInputs();
  return psbt.extractTransaction().toHex();
}
