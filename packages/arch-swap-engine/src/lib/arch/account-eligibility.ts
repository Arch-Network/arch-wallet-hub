import { isExempt } from "@saturnbtcio/arch-sdk";

import { fetchAccountInfo } from "@/lib/indexer/accounts";
import { SYSTEM_PROGRAM_ID } from "@/lib/arch/program-ids";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export type FeePayerEligibility =
  | { eligible: true }
  | { eligible: false; reason: "missing" | "wrong_owner" | "underfunded" };

type AccountSnapshot = {
  lamports: number;
  owner: Uint8Array;
  data: Uint8Array;
};

/**
 * Mirrors the validator's preconditions for the fee-payer slot. A transaction
 * whose account[0] fails any of these will be rejected at submission with
 * "fee payer must be signer, writable, system-owned, and present" — checking
 * locally lets us avoid signing a transaction the chain will reject and gives
 * callers a discriminated reason for remediation (re-onboard vs. re-fund).
 */
export function classifyFeePayer(info: AccountSnapshot | null): FeePayerEligibility {
  if (!info) return { eligible: false, reason: "missing" };
  if (!bytesEqual(info.owner, SYSTEM_PROGRAM_ID)) {
    return { eligible: false, reason: "wrong_owner" };
  }
  if (!isExempt(BigInt(info.lamports), info.data.length)) {
    return { eligible: false, reason: "underfunded" };
  }
  return { eligible: true };
}

export async function readFeePayerEligibility(
  pubkey: Uint8Array,
): Promise<FeePayerEligibility> {
  const info = await fetchAccountInfo(pubkey).catch(() => null);
  if (!info) return classifyFeePayer(null);
  return classifyFeePayer({
    lamports: info.lamports,
    owner: new Uint8Array(info.owner),
    data: new Uint8Array(info.data),
  });
}

/**
 * Poll eligibility until the account looks usable, or the budget is exhausted.
 *
 * A `processed` confirmation only proves the tx ran; the indexer we read
 * from next can still serve a pre-tx snapshot for a few seconds, and an
 * underfunded faucet may land a tx that processes successfully but doesn't
 * leave the account rent-exempt until a later block. Polling collapses both
 * — we accept the moment the check passes once.
 */
export async function pollFeePayerEligibility(
  pubkey: Uint8Array,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<FeePayerEligibility> {
  const attempts = options.attempts ?? 8;
  const intervalMs = options.intervalMs ?? 1_000;

  let last: FeePayerEligibility = { eligible: false, reason: "missing" };
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0) await sleep(intervalMs);
    last = await readFeePayerEligibility(pubkey);
    if (last.eligible) return last;
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
