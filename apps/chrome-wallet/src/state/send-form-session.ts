/**
 * Send-form checkpoint storage.
 *
 * Chrome MV3 popups unmount the moment they lose focus, so any
 * half-typed recipient + amount in the Send (BTC/ARCH/APL) or
 * SendRune form is gone when the popup reopens. The user lands
 * back on the asset-picker (step 1) with empty fields and has
 * to re-type everything -- a real pain when copy-pasting a
 * recipient from a separate app or wallet.
 *
 * We checkpoint the *minimum* state needed to drop the user back
 * on the form with their fields filled in:
 *
 *   - recipient and amount (the typed strings, not parsed)
 *   - which asset / rune they were sending
 *   - which step they were on (capped at the data-entry step --
 *     never restore to a "Review" with a stale PSBT)
 *
 * We deliberately do NOT persist:
 *   - signing state (mid-flight Turnkey activities, external
 *     wallet handoffs) -- those are explicitly transient
 *   - prepared PSBT results -- stale by the time the user returns,
 *     re-derived in <1s on next Review click
 *   - QR scanner / dropdown UI state -- noise, not user intent
 *
 * Storage choice: `chrome.storage.session` (MV3 in-memory store)
 * mirrors what `recovery-session.ts` does:
 *   1. Cleared on browser shutdown -- a recipient typed yesterday
 *      shouldn't surprise the user today.
 *   2. Never written to disk.
 *   3. No-op gracefully if unavailable.
 *
 * Tagging: each checkpoint carries the account ID + network it
 * was created under. Switching wallets or networks invalidates
 * the checkpoint immediately on load -- a testnet recipient
 * doesn't autofill on mainnet.
 *
 * TTL: 30 minutes. Long enough to step away, look up an address
 * in another app, and come back; short enough that a stale form
 * from this morning doesn't ambush you tonight.
 */

// Separate storage slot per form kind so the BTC/ARCH/APL form
// and the per-rune form can coexist -- navigating between /send
// and /send-rune doesn't wipe a parked checkpoint on the other.
// Each page only ever reads / writes its own slot.
const KEY_BTC_ARCH_APL = "arch_wallet_send_form_session_btc";
const KEY_RUNE = "arch_wallet_send_form_session_rune";
const TTL_MS = 30 * 60 * 1000;

function keyForKind(kind: SendKind): string {
  return kind === "rune" ? KEY_RUNE : KEY_BTC_ARCH_APL;
}

export type SendKind = "btc-arch-apl" | "rune";

/** What we restore for the Send.tsx (BTC/ARCH/APL) flow. */
export interface BtcArchAplFormState {
  kind: "btc-arch-apl";
  /** "btc" | "arch" | "apl" -- string union widened to avoid
   *  pulling a circular type from Send.tsx into a state module. */
  asset: string | null;
  /** Mint pubkey for APL token sends; null for BTC/ARCH. */
  selectedTokenMint: string | null;
  recipient: string;
  amount: string;
}

/** What we restore for the SendRune.tsx flow. */
export interface RuneFormState {
  kind: "rune";
  /** Canonical "block:tx" rune id. */
  runeId: string;
  recipient: string;
  amount: string;
}

export type SendFormState = BtcArchAplFormState | RuneFormState;

export interface SendFormCheckpoint {
  /** The form state to restore. */
  form: SendFormState;
  /**
   * Account this form belongs to. Switching wallets while the
   * form is parked invalidates it -- a recipient meant for one
   * key shouldn't autofill on another.
   */
  accountId: string;
  /**
   * Network ("mainnet" | "testnet" | "testnet4" etc). Switching
   * networks invalidates the checkpoint for the same reason --
   * a mainnet address typed in a mainnet form shouldn't
   * autofill on testnet.
   */
  network: string;
  /** Internal -- enforces TTL on load. */
  savedAt: number;
}

function sessionStore(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the current form state. Best-effort: any storage failure
 * is swallowed silently because the worst-case UX is "form fields
 * don't auto-restore", which is the same as the pre-PR behavior.
 */
export async function saveSendForm(
  input: Omit<SendFormCheckpoint, "savedAt">
): Promise<void> {
  const store = sessionStore();
  if (!store) return;
  const payload: SendFormCheckpoint = { ...input, savedAt: Date.now() };
  try {
    await store.set({ [keyForKind(input.form.kind)]: payload });
  } catch {
    /* best-effort */
  }
}

/**
 * Load the parked form state, or null if:
 *   - no checkpoint exists in this kind's slot
 *   - the TTL has expired (also auto-clears the slot)
 *   - the checkpoint belongs to a different account or network
 *   - for rune restores: the checkpoint is for a different rune id
 *
 * Context mismatches DO NOT auto-clear the slot. The parked form
 * may still be valid for the user's other account / network /
 * rune, and clearing it because the *current* mount can't use it
 * would be destructive.
 *
 * TTL expiry IS a real "this is stale" signal, so that path does
 * clear the slot.
 */
export async function loadSendForm(filter: {
  kind: SendKind;
  accountId: string;
  network: string;
  /** For rune restores: only return a match if the same rune is open. */
  runeId?: string;
}): Promise<SendFormCheckpoint | null> {
  const store = sessionStore();
  if (!store) return null;
  const key = keyForKind(filter.kind);
  try {
    const res = await store.get(key);
    const v = res[key] as SendFormCheckpoint | undefined;
    if (!v) return null;

    const ttlOk =
      typeof v.savedAt === "number" && Date.now() - v.savedAt <= TTL_MS;
    if (!ttlOk) {
      // TTL expiry is a "this is stale" signal -- safe to prune.
      try {
        await store.remove(key);
      } catch {
        /* ignore */
      }
      return null;
    }

    const contextOk =
      v.accountId === filter.accountId && v.network === filter.network;
    const kindOk = v.form?.kind === filter.kind;
    const runeOk =
      filter.kind !== "rune" ||
      (v.form.kind === "rune" && v.form.runeId === filter.runeId);

    if (!contextOk || !kindOk || !runeOk) {
      // Different account / network / rune -- the parked form may
      // still be valid for that other context. Don't touch it.
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

/**
 * Drop ALL parked send forms. Call on:
 *   - successful broadcast (this form's job is done)
 *   - explicit cancel back to dashboard
 *
 * We clear both slots so that, e.g., a successful BTC send doesn't
 * leave a stale rune form lurking (and vice versa). The user has
 * just demonstrated intent to "be done"; honoring that across
 * both kinds is the least-surprising behavior.
 */
export async function clearSendForm(): Promise<void> {
  const store = sessionStore();
  if (!store) return;
  try {
    await store.remove([KEY_BTC_ARCH_APL, KEY_RUNE]);
  } catch {
    /* ignore */
  }
}
