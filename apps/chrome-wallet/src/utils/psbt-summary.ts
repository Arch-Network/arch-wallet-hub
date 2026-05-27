/**
 * Decode an inbound PSBT (hex or base64) into a structured summary
 * suitable for the Approve UI. The structured form lets us render
 * inputs/outputs, calculate the net delta for the user's own address,
 * and surface the fee — instead of dumping the raw PSBT bytes and
 * asking the user to blind-sign.
 */

import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";

let ecclibInitialized = false;
function ensureEccLib() {
  if (!ecclibInitialized) {
    bitcoin.initEccLib(ecc);
    ecclibInitialized = true;
  }
}

export interface PsbtSummaryOutput {
  address: string | null;
  valueSats: number;
  isMine: boolean;
  isChange: boolean;
}

export interface PsbtSummaryInput {
  txid: string;
  vout: number;
  valueSats: number;
  address: string | null;
  isMine: boolean;
}

export interface PsbtSummary {
  network: "mainnet" | "testnet";
  inputs: PsbtSummaryInput[];
  outputs: PsbtSummaryOutput[];
  totalInputSats: number;
  totalOutputSats: number;
  feeSats: number;
  /** Net change for the user (negative = outflow including fee). */
  netUserSats: number;
  /** True if every input's prevout amount was available. */
  exactFee: boolean;
}

function safeAddressFromScript(script: Uint8Array, network: bitcoin.Network): string | null {
  try {
    return bitcoin.address.fromOutputScript(script, network);
  } catch {
    return null;
  }
}

function detectNetworkFromAddress(addr: string): "mainnet" | "testnet" {
  if (addr.startsWith("tb1") || addr.startsWith("bcrt1") || addr.startsWith("2") || addr.startsWith("m") || addr.startsWith("n")) {
    return "testnet";
  }
  return "mainnet";
}

function parsePsbt(payload: string): bitcoin.Psbt {
  ensureEccLib();
  const trimmed = payload.trim();
  // Heuristic: PSBTs start with the magic bytes 0x70736274ff which
  // hex-encodes to "70736274ff". Base64 PSBTs start with "cHNidP" because
  // the magic encodes to "cHNidP8".
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    return bitcoin.Psbt.fromHex(trimmed);
  }
  return bitcoin.Psbt.fromBase64(trimmed);
}

export function summarizePsbt(payload: string, myAddresses: string[]): PsbtSummary {
  const psbt = parsePsbt(payload);

  const myAddrSet = new Set(myAddresses.filter(Boolean));
  const someAddress = myAddresses.find(Boolean) ?? "";
  const networkName = someAddress ? detectNetworkFromAddress(someAddress) : "mainnet";
  const network = networkName === "testnet" ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

  const inputs: PsbtSummaryInput[] = [];
  let totalInputSats = 0;
  let exactFee = true;

  psbt.data.inputs.forEach((input, i) => {
    const txIn = psbt.txInputs[i];
    let valueSats = 0;
    let address: string | null = null;
    if (input.witnessUtxo) {
      valueSats = Number(input.witnessUtxo.value);
      address = safeAddressFromScript(input.witnessUtxo.script, network);
    } else if (input.nonWitnessUtxo) {
      try {
        const prev = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo as any);
        const out = prev.outs[txIn.index];
        valueSats = Number(out.value);
        address = safeAddressFromScript(out.script as any, network);
      } catch {
        exactFee = false;
      }
    } else {
      exactFee = false;
    }
    totalInputSats += valueSats;
    const txid = Buffer.from(txIn.hash).reverse().toString("hex");
    inputs.push({
      txid,
      vout: txIn.index,
      valueSats,
      address,
      isMine: address ? myAddrSet.has(address) : false,
    });
  });

  const outputs: PsbtSummaryOutput[] = psbt.txOutputs.map((out) => {
    const address = safeAddressFromScript(out.script as any, network);
    const isMine = address ? myAddrSet.has(address) : false;
    return {
      address,
      valueSats: Number(out.value),
      isMine,
      // Only label as change if the same address appears as an input.
      isChange: isMine && inputs.some((i) => i.address === address),
    };
  });

  const totalOutputSats = outputs.reduce((acc, o) => acc + o.valueSats, 0);
  const feeSats = exactFee ? totalInputSats - totalOutputSats : 0;

  const inflowSats = outputs
    .filter((o) => o.isMine && !o.isChange)
    .reduce((acc, o) => acc + o.valueSats, 0);
  const outflowSats = inputs
    .filter((i) => i.isMine)
    .reduce((acc, i) => acc + i.valueSats, 0);
  const changeBackSats = outputs.filter((o) => o.isChange).reduce((acc, o) => acc + o.valueSats, 0);
  const netUserSats = inflowSats - outflowSats + changeBackSats;

  return {
    network: networkName,
    inputs,
    outputs,
    totalInputSats,
    totalOutputSats,
    feeSats,
    netUserSats,
    exactFee,
  };
}

export function formatSats(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const btc = value / 1e8;
  if (Math.abs(btc) >= 0.001) return `${btc.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} BTC`;
  return `${value.toLocaleString()} sats`;
}

/**
 * Approve-popup safety rails for SIGN_PSBT requests.
 *
 * Policy (from the 2026-05 audit, items M5 + M6):
 *
 *   - `block` is set when `exactFee === false` AND the user's net
 *     outflow is above `PSBT_UNKNOWN_FEE_BLOCK_OUTFLOW_SATS`. Below
 *     that threshold we allow signing through with the existing
 *     "fee unknown" warning -- legitimate multi-sig / partial-PSBT
 *     protocols intentionally pass incomplete prevout data and
 *     fill fees in later. Above it, the wallet refuses outright so
 *     "fee unknown" can't hide an unbounded miner-fee drain on a
 *     real send.
 *
 *   - `requireConfirm` is set on plain large outflows above
 *     `PSBT_HIGH_OUTFLOW_REQUIRE_CONFIRM_SATS`. The Approve button
 *     stays interactive but only after the user ticks a "I
 *     reviewed every input and output" checkbox. Goal is to break
 *     muscle-memory approvals on transactions that materially move
 *     funds.
 *
 * The thresholds are intentionally conservative defaults; once the
 * dApp Permission Center work lands they'll become per-origin
 * settings. Until then, this module is the single source of
 * truth -- both Approve.tsx and any future "simulate before sign"
 * flow should consume `evaluatePsbtGate` instead of re-implementing
 * its heuristics.
 */
export const PSBT_UNKNOWN_FEE_BLOCK_OUTFLOW_SATS = 10_000;
export const PSBT_HIGH_OUTFLOW_REQUIRE_CONFIRM_SATS = 1_000_000;

export interface PsbtGate {
  /** When set, sign is refused outright. */
  block: { reason: string } | null;
  /** When set, sign requires the user to tick an explicit checkbox. */
  requireConfirm: { reason: string } | null;
}

export function evaluatePsbtGate(summary: PsbtSummary): PsbtGate {
  const outflowSats = summary.netUserSats < 0 ? -summary.netUserSats : 0;

  if (!summary.exactFee && outflowSats > PSBT_UNKNOWN_FEE_BLOCK_OUTFLOW_SATS) {
    return {
      block: {
        reason:
          `This PSBT is missing prevout amounts for some inputs, so the network fee is unknown. ` +
          `The wallet refuses to sign outflows over ${formatSats(PSBT_UNKNOWN_FEE_BLOCK_OUTFLOW_SATS)} ` +
          `without complete fee accounting. Ask the dapp to supply a fully-funded PSBT.`,
      },
      requireConfirm: null,
    };
  }

  if (outflowSats >= PSBT_HIGH_OUTFLOW_REQUIRE_CONFIRM_SATS) {
    return {
      block: null,
      requireConfirm: {
        reason:
          `Large outflow (${formatSats(outflowSats)}). ` +
          `Confirm you trust this site and reviewed every input and output above.`,
      },
    };
  }

  return { block: null, requireConfirm: null };
}
