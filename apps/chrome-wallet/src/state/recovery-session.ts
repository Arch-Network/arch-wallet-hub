/**
 * Recovery-session checkpoint storage.
 *
 * Chrome MV3 popups unmount the moment they lose focus, which makes
 * the OTP step of the recovery flow ugly: the user clicks "Send code",
 * leaves the popup to read the email, comes back, and discovers the
 * wallet has reverted to its default route -- all in-memory React
 * state is gone.
 *
 * We checkpoint the *minimum* state needed to resume the user back on
 * the OTP entry screen with the right challenge attached. Crucially:
 *
 *   - We persist the public envelope: challengeId, candidates,
 *     pinnedExternalUserId, etc. -- things the Hub already knows.
 *
 *   - We do NOT persist secrets that haven't been used yet. The
 *     ephemeral P-256 private key (which decrypts the recovered API
 *     key bundle) is generated lazily at verify-time and stays
 *     in-memory; the user's chosen password is also never persisted.
 *     If the user closes the popup mid-password-step they'll have to
 *     redo the OTP -- accepted UX cost for not parking credentials in
 *     `chrome.storage`.
 *
 *   - The Hub-side challenge expires after 10 minutes
 *     (CHALLENGE_TTL_MS in recovery.ts); we mirror that TTL here so a
 *     stale resume attempt fails fast instead of round-tripping to
 *     the Hub for an "expired" error.
 *
 * We use `chrome.storage.session` (MV3-only) because:
 *   1. It's cleared on browser shutdown -- aligns with "OTPs are
 *      short-lived" and keeps the surface area small if the device is
 *      shared.
 *   2. It doesn't write to disk -- no on-disk leak of which email is
 *      mid-recovery.
 *
 * If `chrome.storage.session` is unavailable (unlikely in MV3) we
 * silently no-op rather than fall back to `local` -- the worst-case
 * UX is "you have to re-enter the email", which is the *current*
 * behaviour anyway.
 */

import type { RecoveryEmailCandidate } from "@arch-network/wallet-hub-sdk";

const KEY = "arch_wallet_recovery_session";
const TTL_MS = 10 * 60 * 1000;

export type RecoveryStep = "email" | "otp" | "pick" | "password" | "done";

export interface RecoverySessionCheckpoint {
  step: RecoveryStep;
  email: string;
  challengeId: string | null;
  candidates: RecoveryEmailCandidate[];
  emailMasked: string;
  pickedToken: string | null;
  pinnedExternalUserId: string | null;
  pinnedResourceId: string | null;
  /** Internal -- set on every save; used for TTL enforcement on load. */
  savedAt: number;
}

function sessionStore(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

export async function saveRecoverySession(
  s: Omit<RecoverySessionCheckpoint, "savedAt">,
): Promise<void> {
  const store = sessionStore();
  if (!store) return;
  const payload: RecoverySessionCheckpoint = { ...s, savedAt: Date.now() };
  try {
    await store.set({ [KEY]: payload });
  } catch {
    // Silently swallow -- this is best-effort UX, not a correctness
    // primitive. A failed write just means the popup won't auto-resume.
  }
}

export async function loadRecoverySession(): Promise<RecoverySessionCheckpoint | null> {
  const store = sessionStore();
  if (!store) return null;
  try {
    const res = await store.get(KEY);
    const v = res[KEY] as RecoverySessionCheckpoint | undefined;
    if (!v) return null;
    if (typeof v.savedAt !== "number" || Date.now() - v.savedAt > TTL_MS) {
      await clearRecoverySession();
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export async function clearRecoverySession(): Promise<void> {
  const store = sessionStore();
  if (!store) return;
  try {
    await store.remove(KEY);
  } catch {
    // ignore
  }
}

/**
 * Synchronous probe used by the route-restorer at popup boot to decide
 * whether to redirect into the recovery flow. Returns `true` if a
 * non-expired checkpoint exists for a post-`email` step (i.e. the user
 * has already kicked off an OTP and was likely off reading their
 * inbox when the popup closed).
 *
 * Note: `chrome.storage.session.get` is async, so true synchronous is
 * not possible -- this returns a promise but we keep the function
 * short-circuiting (`null` on any error) so the restorer can race it
 * against the normal route-restore without blocking the popup paint.
 */
export async function hasActiveRecoveryCheckpoint(): Promise<boolean> {
  const v = await loadRecoverySession();
  return !!v && v.step !== "email" && v.step !== "done";
}
