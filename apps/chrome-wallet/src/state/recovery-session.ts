/**
 * Recovery-session checkpoint storage.
 *
 * Chrome closes the wallet window when the user switches apps — a
 * password manager, Mail, another Space. The page unloads and every
 * piece of React state goes with it.
 *
 * Two steps have to survive that:
 *
 *   - OTP / wallet pick. The Hub challenge is still pending, so we
 *     restore the code form (or the picker) and the same challenge.
 *
 *   - Password. Verify has already consumed the one-time code and
 *     Turnkey will not accept it again. The encrypted credential
 *     bundle and the ephemeral key that decrypts it have to be here,
 *     or the next open sends the user back to a dead code and the
 *     Hub answers 410. The password they are copying is never written
 *     here; they paste it again. See the onboarding handoff for the
 *     same rule about the keystore password.
 *
 * The bundle and ephemeral key are a short-lived decrypt pair, not
 * the keystore password. They live only in `chrome.storage.session`
 * (memory, cleared when the browser quits), only until recovery
 * finishes, the user backs out, or the TTL below. We do not fall
 * back to `chrome.storage.local` — that would put the pair on disk.
 *
 * The Hub challenge expires after 10 minutes (CHALLENGE_TTL_MS in
 * recovery.ts). The recovered API key lives longer, but a password
 * step nobody came back to within 10 minutes starts over cleanly
 * instead of decrypting a bundle the user has walked away from.
 *
 * Saves and clears share one queue. A slow OTP write must not land
 * after the password write and resurrect a consumed challenge.
 */

import type { RecoveryEmailCandidate } from "@arch-network/wallet-hub-sdk";

const KEY = "arch_wallet_recovery_session";
const TTL_MS = 10 * 60 * 1000;

export type RecoveryStep = "email" | "otp" | "pick" | "password" | "done";

/**
 * What verify already returned, plus the key that can decrypt it.
 * Present only while `step` is `"password"`.
 */
export interface RecoveryVerifiedMaterial {
  credentialBundle: string;
  organizationId: string;
  rootUserId: string | null;
  walletId: string | null;
  /** Hub resource id. Null on checkpoints written before it was returned. */
  resourceId: string | null;
  defaultAddress: string | null;
  defaultPublicKeyHex: string | null;
  externalUserId: string | null;
  authMethod: "passkey" | "email";
  ephemeralPrivateKeyHex: string;
}

export interface RecoverySessionCheckpoint {
  step: RecoveryStep;
  email: string;
  challengeId: string | null;
  candidates: RecoveryEmailCandidate[];
  emailMasked: string;
  pickedToken: string | null;
  pinnedExternalUserId: string | null;
  pinnedResourceId: string | null;
  verified?: RecoveryVerifiedMaterial;
  /** Internal -- set on every save; used for TTL enforcement on load. */
  savedAt: number;
}

let writeChain: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = writeChain.then(task, task);
  // Keep the chain alive after a failure so a later save still runs.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sessionStore(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readVerified(value: unknown): RecoveryVerifiedMaterial | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.credentialBundle !== "string" || v.credentialBundle.length === 0) return null;
  if (typeof v.organizationId !== "string" || v.organizationId.length === 0) return null;
  if (typeof v.ephemeralPrivateKeyHex !== "string" || v.ephemeralPrivateKeyHex.length === 0) {
    return null;
  }
  if (v.authMethod !== "passkey" && v.authMethod !== "email") return null;
  return {
    credentialBundle: v.credentialBundle,
    organizationId: v.organizationId,
    rootUserId: nullableString(v.rootUserId),
    walletId: nullableString(v.walletId),
    resourceId: nullableString(v.resourceId),
    defaultAddress: nullableString(v.defaultAddress),
    defaultPublicKeyHex: nullableString(v.defaultPublicKeyHex),
    externalUserId: nullableString(v.externalUserId),
    authMethod: v.authMethod,
    ephemeralPrivateKeyHex: v.ephemeralPrivateKeyHex,
  };
}

export async function saveRecoverySession(
  s: Omit<RecoverySessionCheckpoint, "savedAt">,
): Promise<void> {
  const store = sessionStore();
  if (!store) return;
  const payload: RecoverySessionCheckpoint = { ...s, savedAt: Date.now() };
  await enqueue(async () => {
    try {
      await store.set({ [KEY]: payload });
    } catch {
      // Best-effort. A failed write means the next open starts at email.
    }
  });
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
    if (v.step === "password") {
      const verified = readVerified(v.verified);
      if (!verified) {
        await clearRecoverySession();
        return null;
      }
      return { ...v, verified };
    }
    if (v.step !== "otp" && v.step !== "pick" && v.step !== "email" && v.step !== "done") {
      await clearRecoverySession();
      return null;
    }
    const rest = { ...v };
    delete rest.verified;
    return rest;
  } catch {
    return null;
  }
}

export async function clearRecoverySession(): Promise<void> {
  const store = sessionStore();
  if (!store) return;
  await enqueue(async () => {
    try {
      await store.remove(KEY);
    } catch {
      // ignore
    }
  });
}

/**
 * True when a non-expired checkpoint is waiting on a step the user
 * cannot safely redo from scratch: OTP, wallet pick, or the password
 * step after a code was already accepted.
 */
export async function hasActiveRecoveryCheckpoint(): Promise<boolean> {
  const v = await loadRecoverySession();
  return !!v && v.step !== "email" && v.step !== "done";
}

/**
 * The Hub's 410 for a challenge that verify already consumed, or that
 * expired. Callers should drop the checkpoint and ask for a new code
 * instead of leaving the typed code on a form that cannot succeed.
 */
export function isSpentRecoveryChallenge(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /challenge already consumed|challenge expired/i.test(message);
}
