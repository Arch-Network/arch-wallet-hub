/**
 * Service-worker daily spend-cap enforcement (issue #46).
 *
 * The Approve popup already gates ARCH / BTC spends against
 * `SitePermissions.*SpendingLimitSatsPerDay`, but that check lives only
 * in UI code. A future popup-skip / auto-approve path could bypass it
 * unless the background also refuses. This module is the shared
 * fail-closed assert used at:
 *   - pending-request intake (before the Approve window opens)
 *   - APPROVE_REQUEST delivery (before the dapp receives a success)
 *
 * Scope matches the popup today:
 *   - SEND_TRANSFER → ARCH cap (`spendingLimitSatsPerDay`, lamports)
 *   - SIGN_PSBT → BTC cap (`btcSpendingLimitSatsPerDay`) only when the
 *     PSBT outflow is deterministic; ambiguous PSBTs are left to the
 *     normal confirmation rails.
 *
 * Fail-closed rules when a cap is configured (or permissions can't be
 * loaded for a spend-type request):
 *   - wallet locked / state unreadable → refuse
 *   - spend ledger unreadable → refuse
 *   - amount / PSBT can't be evaluated under a configured cap → refuse
 */

import { resolveAccountAddresses } from "../state/account-addresses";
import {
  DEFAULT_SITE_PERMISSIONS,
  type AppState,
  type SitePermissions,
  type WalletAccount,
} from "../state/types";
import { walletStore } from "../state/wallet-store";
import {
  deterministicPsbtSpendSats,
  summarizePsbt,
} from "./psbt-summary";
import {
  exceedsCap,
  getRecentSpendStrict,
  SpendLedgerUnavailableError,
  type SpendAsset,
} from "./spend-tracker";
import { parseU64DecimalString } from "./u64-amount";

export type BackgroundSpendCapDecision =
  | { allowed: true }
  | { allowed: false; error: string };

export interface SpendCapPendingLike {
  type: string;
  origin: string;
  payload?: unknown;
}

export interface SpendCapGuardDeps {
  /**
   * Returns unlocked wallet state, or `null` when locked / unavailable.
   * Injected in tests.
   */
  getUnlockedState: () => Promise<AppState | null>;
  getRecentSpendStrict: typeof getRecentSpendStrict;
}

const defaultDeps: SpendCapGuardDeps = {
  getUnlockedState: async () => {
    try {
      const state = await walletStore.getState();
      if (!state.initialized || state.locked) return null;
      return state;
    } catch {
      return null;
    }
  },
  getRecentSpendStrict,
};

function sitePermissions(
  state: AppState,
  origin: string,
): SitePermissions | null {
  const site = state.connectedSites?.[origin];
  if (!site) return null;
  return site.permissions ?? { ...DEFAULT_SITE_PERMISSIONS };
}

function accountForOrigin(state: AppState, origin: string): WalletAccount | null {
  const site = state.connectedSites?.[origin];
  if (site?.accountId) {
    const linked = state.accounts.find((a) => a.id === site.accountId);
    if (linked) return linked;
  }
  if (state.activeAccountId) {
    return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
  }
  return state.accounts[0] ?? null;
}

async function assertCap(opts: {
  origin: string;
  network: string;
  asset: SpendAsset;
  pendingAmount: bigint;
  capRaw: number;
  deps: SpendCapGuardDeps;
  overCapMessage: string;
  ledgerMessage: string;
}): Promise<BackgroundSpendCapDecision> {
  let recent: bigint;
  try {
    recent = await opts.deps.getRecentSpendStrict({
      origin: opts.origin,
      asset: opts.asset,
      network: opts.network,
    });
  } catch (err) {
    const detail =
      err instanceof SpendLedgerUnavailableError ? err.message : "Spend ledger unavailable";
    return { allowed: false, error: `${opts.ledgerMessage} (${detail})` };
  }
  if (exceedsCap({ pending: opts.pendingAmount, recent, cap: BigInt(opts.capRaw) })) {
    return { allowed: false, error: opts.overCapMessage };
  }
  return { allowed: true };
}

/**
 * Fail-closed daily spend-cap check for background paths.
 * Non-spend message types always pass.
 */
export async function assertBackgroundSpendCap(
  pending: SpendCapPendingLike,
  deps: SpendCapGuardDeps = defaultDeps,
): Promise<BackgroundSpendCapDecision> {
  if (pending.type !== "SEND_TRANSFER" && pending.type !== "SIGN_PSBT") {
    return { allowed: true };
  }
  if (!pending.origin) {
    return { allowed: false, error: "Missing origin for spend-cap check" };
  }

  const state = await deps.getUnlockedState();
  if (!state) {
    return {
      allowed: false,
      error: "Wallet locked or unavailable; refusing spend under daily cap",
    };
  }

  const permissions = sitePermissions(state, pending.origin);
  if (!permissions) {
    return {
      allowed: false,
      error: "Unable to load site permissions for spend-cap check",
    };
  }

  if (pending.type === "SEND_TRANSFER") {
    const capRaw = permissions.spendingLimitSatsPerDay;
    if (capRaw === undefined || capRaw === null) {
      return { allowed: true };
    }
    const pendingAmount = parseU64DecimalString(
      (pending.payload as { lamports?: unknown } | undefined)?.lamports,
    );
    if (pendingAmount === null) {
      return {
        allowed: false,
        error: "Invalid SEND_TRANSFER amount for spend-cap check",
      };
    }
    return assertCap({
      origin: pending.origin,
      network: state.network,
      asset: "arch",
      pendingAmount,
      capRaw,
      deps,
      overCapMessage: "Daily ARCH spend cap exceeded for this site",
      ledgerMessage:
        "Spend ledger unavailable; refusing ARCH transfer under daily cap",
    });
  }

  // SIGN_PSBT
  const capRaw = permissions.btcSpendingLimitSatsPerDay;
  if (capRaw === undefined || capRaw === null) {
    return { allowed: true };
  }

  const psbtPayload = (pending.payload as { psbt?: unknown } | undefined)?.psbt;
  if (typeof psbtPayload !== "string" || !psbtPayload) {
    return {
      allowed: false,
      error: "Missing PSBT payload for spend-cap check",
    };
  }

  const account = accountForOrigin(state, pending.origin);
  if (!account) {
    return {
      allowed: false,
      error: "No account available to evaluate PSBT spend against daily cap",
    };
  }

  let deterministicSpend: number | null;
  try {
    const summary = summarizePsbt(
      psbtPayload,
      resolveAccountAddresses(account, state.network).all,
      state.network === "mainnet" ? "mainnet" : "testnet",
    );
    deterministicSpend = deterministicPsbtSpendSats(summary);
  } catch (err) {
    return {
      allowed: false,
      error:
        err instanceof Error
          ? `Unable to evaluate PSBT spend against daily cap: ${err.message}`
          : "Unable to evaluate PSBT spend against daily cap",
    };
  }

  // Ambiguous outflow: same posture as Approve UI — don't apply a
  // numeric BTC cap; other PSBT rails still apply in the popup.
  if (deterministicSpend === null) {
    return { allowed: true };
  }

  return assertCap({
    origin: pending.origin,
    network: state.network,
    asset: "btc",
    pendingAmount: BigInt(deterministicSpend),
    capRaw,
    deps,
    overCapMessage: "Daily Bitcoin spend cap exceeded for this site",
    ledgerMessage:
      "Spend ledger unavailable; refusing PSBT sign under daily Bitcoin cap",
  });
}
