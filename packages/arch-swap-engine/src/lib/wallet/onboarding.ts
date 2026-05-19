import { PubkeyUtil } from "@saturnbtcio/arch-sdk";

import {
  pollFeePayerEligibility,
  readFeePayerEligibility,
} from "@/lib/arch/account-eligibility";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/arch/program-ids";
import { signRuntimeTransactionWithSigner } from "@/lib/arch/signing";
import { hexToBytes } from "@/lib/arch/hex";
import {
  buildTransaction,
  normalizeRuntimeTransaction,
  type SdkInstruction,
} from "@/lib/arch/tx-builder";
import type {
  CreateAccountResponse,
  CreateAtaResponse,
  RuntimeTransaction,
} from "@/lib/arch/types";
import { fetchAccountInfo } from "@/lib/indexer/accounts";
import {
  buildCreateAccountWithFaucetTransaction,
  classifyTransactionStatus,
  fetchTransactionStatus,
  getFailureReason,
  submitTransaction,
} from "@/lib/indexer/transactions";
import {
  getToken,
  getTokenSymbols,
  type NetworkConfig,
} from "@/lib/network/config";

import { walletLogger } from "./diagnostics";

const SYSTEM_PROGRAM_ID = new Uint8Array(32);

const CONFIRMATION_POLL_INTERVAL_MS = 2_000;
const CONFIRMATION_MAX_ATTEMPTS = 15;

/** On-chain step currently in flight, surfaced to the connect modal. */
export type OnboardingPhase =
  | "checking-account"
  | "creating-account"
  | "verifying-account"
  | "checking-token-accounts"
  | "creating-token-accounts"
  | "verifying-token-accounts";

type SignChallenge = (challenge: string) => Promise<string>;

/**
 * Three-phase: pre-check, sign+submit, verify.
 *
 * - Pre-check skips the wallet prompt when the account already satisfies
 *   the structural fee-payer predicate.
 * - Sign+submit appends the user's authority signature; the faucet has
 *   already signed at position 0.
 * - Verify polls eligibility to absorb the gap between `processed` and
 *   "validator sees the account as fee-payer-eligible" — an
 *   underfunded faucet or stale read can each cost a few seconds.
 *
 * Verification failures throw with reason-specific copy so the connect
 * modal can render actionable error states.
 */
async function ensureOnChainAccount(
  pubkeyXCoord: string,
  signChallenge: SignChallenge,
  onPhase: (phase: OnboardingPhase) => void,
): Promise<void> {
  onPhase("checking-account");
  const accountResult = await createAccountIfNeeded(pubkeyXCoord);

  if (accountResult.status === "needs_signature") {
    onPhase("creating-account");
    const userSig = await signRuntimeTransactionWithSigner(
      accountResult.transaction,
      signChallenge,
    );
    const tx: RuntimeTransaction = {
      ...accountResult.transaction,
      signatures: [...accountResult.transaction.signatures, userSig],
    };

    let txHash: string;
    try {
      txHash = await submitTransaction(tx);
    } catch (err) {
      if (await accountAlreadyExists(pubkeyXCoord, "rpc_error")) return;
      throw new Error(
        `Account creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await waitForConfirmation(txHash, "Account creation");
    } catch (error) {
      if (await accountAlreadyExists(pubkeyXCoord, "confirmation_error")) return;
      throw error;
    }
  }

  onPhase("verifying-account");
  await assertAccountEligible(pubkeyXCoord);
}

/**
 * Same shape as `ensureOnChainAccount`: pre-check, sign+submit, verify.
 * The post-verify re-runs the ATA existence check since unstable
 * fee-payer state surfaces as an opaque validator rejection if we
 * don't catch it client-side.
 */
async function ensureTokenAccounts(
  config: NetworkConfig,
  pubkeyXCoord: string,
  signChallenge: SignChallenge,
  onPhase: (phase: OnboardingPhase) => void,
): Promise<void> {
  onPhase("checking-token-accounts");
  const ataResult = await createAssociatedTokenAccountsIfNeeded(
    config,
    pubkeyXCoord,
  );

  if (ataResult.status === "needs_signature") {
    onPhase("creating-token-accounts");
    const userSig = await signRuntimeTransactionWithSigner(
      ataResult.transaction,
      signChallenge,
    );
    const tx: RuntimeTransaction = {
      ...ataResult.transaction,
      signatures: [...ataResult.transaction.signatures, userSig],
    };

    let txHash: string;
    try {
      txHash = await submitTransaction(tx);
    } catch (err) {
      if (await tokenAccountsAlreadyExist(config, pubkeyXCoord, "rpc_error")) {
        return;
      }
      throw new Error(
        `Token account creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await waitForConfirmation(txHash, "Token account creation");
    } catch (error) {
      if (
        await tokenAccountsAlreadyExist(
          config,
          pubkeyXCoord,
          "confirmation_error",
        )
      ) {
        return;
      }
      throw error;
    }
  }

  onPhase("verifying-token-accounts");
  const verified = await tokenAccountsAlreadyExist(
    config,
    pubkeyXCoord,
    "post_verify",
  );
  if (!verified) {
    throw new Error(
      "Token accounts created on-chain but didn't appear in time. " +
        "Please retry — this is usually a brief indexer lag.",
    );
  }
}

/** Authority account, then ATAs. Idempotent — each step early-exits when
 *  its account already exists, so calling on every connect is safe. */
export async function ensureOnboarding(
  config: NetworkConfig,
  pubkeyXCoord: string,
  signChallenge: SignChallenge,
  onPhase: (phase: OnboardingPhase) => void,
): Promise<void> {
  await ensureOnChainAccount(pubkeyXCoord, signChallenge, onPhase);
  await ensureTokenAccounts(config, pubkeyXCoord, signChallenge, onPhase);
}

/**
 * Returns `already_exists` only when the account satisfies every
 * validator-side fee-payer precondition (present, system-owned,
 * rent-exempt). Any half-state falls through to a fresh
 * `create_account_with_faucet` so we never hand the caller a tx the
 * chain will reject.
 */
async function createAccountIfNeeded(
  userPubkeyHex: string,
): Promise<CreateAccountResponse> {
  const pubkeyBytes = hexToBytes(userPubkeyHex);

  const eligibility = await readFeePayerEligibility(pubkeyBytes);
  if (eligibility.eligible) return { status: "already_exists" };

  const transaction = await buildCreateAccountWithFaucetTransaction(pubkeyBytes);
  return { status: "needs_signature", transaction };
}

/**
 * Probe each supported mint's ATA. If all exist, return `all_exist`;
 * otherwise return a single tx creating every missing ATA in one shot.
 */
async function createAssociatedTokenAccountsIfNeeded(
  config: NetworkConfig,
  userPubkeyHex: string,
): Promise<CreateAtaResponse> {
  const userPubkeyBytes = hexToBytes(userPubkeyHex);
  const mints = getTokenSymbols(config).map((s) =>
    hexToBytes(getToken(s, config).mint),
  );

  type MissingAta = { ata: Uint8Array; mint: Uint8Array };
  const missing: MissingAta[] = [];

  for (const mint of mints) {
    const ata = PubkeyUtil.getAssociatedTokenAddress(
      mint,
      userPubkeyBytes,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const info = await fetchAccountInfo(ata).catch(() => null);
    if (!info) missing.push({ ata, mint });
  }

  if (missing.length === 0) return { status: "all_exist" };

  const instructions: SdkInstruction[] = missing.map(({ ata, mint }) => ({
    program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: userPubkeyBytes, is_signer: true, is_writable: true },
      { pubkey: ata, is_signer: false, is_writable: true },
      { pubkey: userPubkeyBytes, is_signer: false, is_writable: false },
      { pubkey: mint, is_signer: false, is_writable: false },
      { pubkey: SYSTEM_PROGRAM_ID, is_signer: false, is_writable: false },
      { pubkey: TOKEN_PROGRAM_ID, is_signer: false, is_writable: false },
    ],
    data: new Uint8Array([]),
  }));

  // Defensive normalize — keeps the wire shape consistent with the
  // faucet-built txs the onboarding pipeline also handles.
  const transaction = normalizeRuntimeTransaction(
    await buildTransaction(instructions, userPubkeyBytes),
  );
  return { status: "needs_signature", transaction };
}

async function accountAlreadyExists(
  pubkeyXCoord: string,
  reason: "rpc_error" | "confirmation_error",
): Promise<boolean> {
  try {
    const recheck = await createAccountIfNeeded(pubkeyXCoord);
    if (recheck.status === "already_exists") {
      walletLogger.warn("account_creation_recovered", { pubkeyXCoord, reason });
      return true;
    }
  } catch {
    // Original caller error is more informative than a transient recheck.
  }
  return false;
}

/**
 * Polls the structural eligibility check to absorb the gap between "tx
 * processed" and "validator agrees the account is fee-payer-eligible."
 * Underfunded faucets and stale reads each resolve within seconds.
 */
async function assertAccountEligible(pubkeyXCoord: string): Promise<void> {
  const eligibility = await pollFeePayerEligibility(hexToBytes(pubkeyXCoord));
  if (eligibility.eligible) return;

  walletLogger.error("account_not_fee_payer_eligible", {
    pubkeyXCoord,
    reason: eligibility.reason,
  });

  const detail =
    eligibility.reason === "underfunded"
      ? "the testnet faucet may be rate-limited or exhausted"
      : eligibility.reason === "wrong_owner"
        ? "the account was created with an unexpected owner"
        : "the account did not appear on-chain";
  throw new Error(
    `Your on-chain account isn't usable yet (${detail}). ` +
      "Click Try again — this usually clears within a few seconds.",
  );
}

async function tokenAccountsAlreadyExist(
  config: NetworkConfig,
  pubkeyXCoord: string,
  reason: "rpc_error" | "confirmation_error" | "post_verify",
): Promise<boolean> {
  try {
    const recheck = await createAssociatedTokenAccountsIfNeeded(
      config,
      pubkeyXCoord,
    );
    if (recheck.status !== "needs_signature") {
      walletLogger.warn("token_accounts_creation_recovered", {
        pubkeyXCoord,
        reason,
      });
      return true;
    }
  } catch {
    // See note in `accountAlreadyExists`.
  }
  return false;
}

async function waitForConfirmation(
  txHash: string,
  label: string,
): Promise<void> {
  let lastFailureReason = "";
  let lastFailedResult: unknown = null;

  for (let attempt = 0; attempt < CONFIRMATION_MAX_ATTEMPTS; attempt += 1) {
    await sleep(CONFIRMATION_POLL_INTERVAL_MS);
    const result = await fetchTransactionStatus(txHash).catch(() => null);
    const status = classifyTransactionStatus(result);
    if (status === "processed") return;
    if (status === "failed") {
      lastFailureReason = getFailureReason(result) ?? "Unknown program error";
      lastFailedResult = result;
      break;
    }
  }

  if (lastFailedResult) {
    console.error(`[onboarding] ${label} failed on chain`, {
      txHash,
      reason: lastFailureReason,
      result: lastFailedResult,
    });
  } else {
    console.error(`[onboarding] ${label} not confirmed in time`, {
      txHash,
      attempts: CONFIRMATION_MAX_ATTEMPTS,
      totalWaitMs: CONFIRMATION_MAX_ATTEMPTS * CONFIRMATION_POLL_INTERVAL_MS,
    });
  }

  throw new Error(
    `${label} failed on-chain: ${lastFailureReason || "not confirmed in time"}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
