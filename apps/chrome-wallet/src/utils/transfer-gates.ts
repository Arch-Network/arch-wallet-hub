import type { ArchBalanceSnapshot, TokenBalanceSnapshot } from "./arch-rpc";
import { isRentDust } from "./arch-fee";
import { exceedsCap } from "./spend-tracker";

/**
 * Pre-flight balance check for `arch.transfer` (the SEND_TRANSFER
 * dapp request type).
 *
 * Why static analysis instead of true simulation: the Arch SDK
 * (v0.0.26) exposes no `simulateTransaction` RPC; the available
 * methods (`read_account_info`, `send_transaction`, ...) don't let
 * us dry-run state changes. The closest meaningful pre-flight is
 * to fetch the sender's current lamport balance and predict the
 * post-balance by simple subtraction. The fee payer is also charged
 * the Arch network fee and any token-account deposit (see
 * `arch-fee.ts`), so the gate requires amount + fee + deposit; the
 * prediction is exact when the indexer returned a value.
 */
export type ArchBalanceGate =
  | { state: "loading" }
  | { state: "invalid-amount" }
  | { state: "fee-unknown" }
  | {
      state: "ok";
      snapshot: ArchBalanceSnapshot;
      feeLamports: bigint;
      depositLamports: bigint;
      postLamports: bigint | null;
      /** A sub-256-lamport send to a recipient whose balance couldn't be read. */
      recipientUnverified: boolean;
    }
  | {
      state: "blocked";
      /** insufficient: amount + fee + deposit > balance. *-dust: `check_rent` would fail. */
      reason: "insufficient" | "sender-dust" | "recipient-dust";
      snapshot: ArchBalanceSnapshot;
      requestedLamports: bigint;
      feeLamports: bigint;
      depositLamports: bigint;
      availableLamports: bigint;
      /** The balance that would fail `check_rent` (sender or recipient). */
      dustLamports?: bigint;
    };

export interface ArchGateExtras {
  /** `TOKEN_ACCOUNT_DEPOSIT_LAMPORTS` when the tx creates a token account, else 0n. */
  depositLamports?: bigint;
  /** Recipient's balance for ARCH sends to another account; null while loading. */
  recipient?: ArchBalanceSnapshot | null;
}

/**
 * `requestedLamports` is null when the dapp amount failed
 * `parseU64DecimalString`; pass 0n to check only the fee (token
 * transfers). `feeLamports` is the fee charged to this account
 * (`feeChargedTo`); null when it couldn't be computed. Both sides are
 * checked against `check_rent` as data-less accounts (see `arch-fee.ts`).
 */
export function computeArchTransferGate(
  snapshot: ArchBalanceSnapshot | null,
  requestedLamports: bigint | null,
  feeLamports: bigint | null,
  extras: ArchGateExtras = {},
): ArchBalanceGate {
  if (requestedLamports === null) return { state: "invalid-amount" };
  if (feeLamports === null) return { state: "fee-unknown" };
  if (!snapshot || extras.recipient === null) return { state: "loading" };
  const depositLamports = extras.depositLamports ?? 0n;
  const blocked = (reason: "insufficient" | "sender-dust" | "recipient-dust", dustLamports?: bigint) => ({
    state: "blocked" as const,
    reason,
    snapshot,
    requestedLamports,
    feeLamports,
    depositLamports,
    availableLamports: snapshot.kind === "found" ? snapshot.lamports : 0n,
    dustLamports,
  });

  const recipient = extras.recipient;
  if (recipient?.kind === "found" && isRentDust(recipient.lamports + requestedLamports)) {
    return blocked("recipient-dust", recipient.lamports + requestedLamports);
  }
  const recipientUnverified =
    recipient !== undefined && recipient.kind !== "found" && isRentDust(requestedLamports);

  if (snapshot.kind !== "found") {
    // not_found / error: surface to the user but don't block.
    // Blocking on a transient indexer outage would brick the
    // wallet for legitimate users.
    return { state: "ok", snapshot, feeLamports, depositLamports, postLamports: null, recipientUnverified };
  }
  const total = requestedLamports + feeLamports + depositLamports;
  if (total > snapshot.lamports) return blocked("insufficient");
  const postLamports = snapshot.lamports - total;
  if (isRentDust(postLamports)) return blocked("sender-dust", postLamports);
  return { state: "ok", snapshot, feeLamports, depositLamports, postLamports, recipientUnverified };
}

export type TokenBalanceGate =
  | { state: "loading" }
  | { state: "invalid-amount" }
  | { state: "ok"; snapshot: TokenBalanceSnapshot; postAmount: bigint | null }
  | {
      state: "blocked";
      snapshot: TokenBalanceSnapshot;
      requestedAmount: bigint;
      availableAmount: bigint;
    };

/** `requestedAmount` is null when the dapp amount failed `parseU64DecimalString`. */
export function computeTokenTransferGate(
  snapshot: TokenBalanceSnapshot | null,
  requestedAmount: bigint | null,
): TokenBalanceGate {
  if (requestedAmount === null) return { state: "invalid-amount" };
  if (!snapshot) return { state: "loading" };
  if (snapshot.kind !== "found") return { state: "ok", snapshot, postAmount: null };
  if (requestedAmount <= 0n) {
    return { state: "ok", snapshot, postAmount: snapshot.amount };
  }
  if (requestedAmount > snapshot.amount) {
    return {
      state: "blocked",
      snapshot,
      requestedAmount,
      availableAmount: snapshot.amount,
    };
  }
  return { state: "ok", snapshot, postAmount: snapshot.amount - requestedAmount };
}

export type ArchSpendCapGate =
  | { state: "n/a" }
  | { state: "loading" }
  | { state: "ok" }
  | { state: "invalid-amount" }
  | { state: "cap-blocked"; capLamports: bigint; recentLamports: bigint };

/**
 * Per-origin daily spend cap for SEND_TRANSFER. The cap lives in the
 * site's permissions (`spendingLimitSatsPerDay`, in lamports); an
 * undefined cap means "no enforcement".
 */
export async function computeArchSpendCapGate(opts: {
  requestedLamports: bigint | null;
  readCapLamports: () => Promise<number | null | undefined>;
  readRecentLamports: () => Promise<bigint>;
}): Promise<ArchSpendCapGate> {
  if (opts.requestedLamports === null) return { state: "invalid-amount" };
  const capRaw = await opts.readCapLamports();
  if (capRaw === undefined || capRaw === null) return { state: "ok" };
  const cap = BigInt(capRaw);
  const recent = await opts.readRecentLamports();
  if (exceedsCap({ pending: opts.requestedLamports, recent, cap })) {
    return { state: "cap-blocked", capLamports: cap, recentLamports: recent };
  }
  return { state: "ok" };
}
