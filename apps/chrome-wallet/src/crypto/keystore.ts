/**
 * AES-GCM encrypted keystore for the wallet state blob.
 *
 * Architecture:
 *   - Password -> PBKDF2-SHA256 (>=600k iters) -> 256-bit KEK
 *   - KEK -> AES-GCM encrypt the JSON-serialized AppState
 *   - Ciphertext + salt + iv stored in chrome.storage.local under
 *     KEYSTORE_KEY. Plaintext is never persisted.
 *   - The derived KEK lives only in-memory in the service worker
 *     (`sessionKey`) and is mirrored into chrome.storage.session so the
 *     popup/sidepanel UI threads can decrypt without re-prompting.
 *   - chrome.storage.session is browser-session-scoped: it's cleared
 *     automatically on browser restart and never written to disk.
 *   - Locking deletes both copies. Unlocking re-derives from the password.
 *
 * Migration:
 *   - If a legacy plaintext `arch_wallet_state` blob is found and no
 *     keystore exists, `getMigrationStatus()` reports `needs_password`
 *     and onboarding prompts the user to set a password to seal the
 *     existing state. The legacy key is deleted after a successful seal.
 */

const KEYSTORE_KEY = "arch_wallet_keystore";
const LEGACY_STATE_KEY = "arch_wallet_state";
const SESSION_KEY_KEY = "arch_wallet_session_key";
const KEYSTORE_SCHEMA = 2;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface KeystoreBlob {
  schema: number;
  salt: string;
  iv: string;
  ciphertext: string;
  iterations: number;
  createdAt: number;
  updatedAt: number;
}

export type MigrationStatus =
  | { kind: "fresh" }
  | { kind: "needs_password"; legacyState: unknown }
  | { kind: "sealed"; blob: KeystoreBlob };

export class WrongPasswordError extends Error {
  constructor() {
    super("Incorrect password");
    this.name = "WrongPasswordError";
  }
}

export class KeystoreLockedError extends Error {
  constructor() {
    super("Keystore is locked");
    this.name = "KeystoreLockedError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * WebCrypto wants its BufferSources backed by ArrayBuffer (not
 * SharedArrayBuffer). lib.dom.d.ts as of TS 5.6 picks up the
 * `Uint8Array<ArrayBufferLike>` typing which trips that check, so we
 * pin everything to a concrete ArrayBuffer-backed Uint8Array here.
 */
function asBuffer(input: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(input.byteLength);
  new Uint8Array(out).set(input);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    asBuffer(enc.encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

async function exportKeyBase64(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return bytesToBase64(raw);
}

async function importKeyBase64(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    asBuffer(base64ToBytes(b64)),
    "AES-GCM",
    true,
    ["encrypt", "decrypt"],
  );
}

let sessionKey: CryptoKey | null = null;

async function loadSessionKeyFromStorage(): Promise<CryptoKey | null> {
  if (sessionKey) return sessionKey;
  try {
    if (!chrome?.storage?.session) return null;
    const result = await chrome.storage.session.get(SESSION_KEY_KEY);
    const b64 = result?.[SESSION_KEY_KEY];
    if (typeof b64 !== "string") return null;
    sessionKey = await importKeyBase64(b64);
    return sessionKey;
  } catch {
    return null;
  }
}

async function saveSessionKey(key: CryptoKey): Promise<void> {
  sessionKey = key;
  try {
    if (!chrome?.storage?.session) return;
    const b64 = await exportKeyBase64(key);
    await chrome.storage.session.set({ [SESSION_KEY_KEY]: b64 });
  } catch {
    /* best-effort: in-memory fallback still works for the current thread */
  }
}

async function clearSessionKey(): Promise<void> {
  sessionKey = null;
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.remove(SESSION_KEY_KEY);
  } catch {
    /* ignore */
  }
}

async function readKeystoreBlob(): Promise<KeystoreBlob | null> {
  const result = await chrome.storage.local.get(KEYSTORE_KEY);
  return (result?.[KEYSTORE_KEY] as KeystoreBlob | undefined) ?? null;
}

async function writeKeystoreBlob(blob: KeystoreBlob): Promise<void> {
  await chrome.storage.local.set({ [KEYSTORE_KEY]: blob });
}

async function readLegacyState(): Promise<unknown | null> {
  const result = await chrome.storage.local.get(LEGACY_STATE_KEY);
  return result?.[LEGACY_STATE_KEY] ?? null;
}

async function removeLegacyState(): Promise<void> {
  await chrome.storage.local.remove(LEGACY_STATE_KEY);
}

export const keystore = {
  /**
   * Returns whether the wallet has a sealed keystore yet. Used by the
   * App router to decide between Onboarding, Unlock, and the normal UI.
   */
  async getMigrationStatus(): Promise<MigrationStatus> {
    const blob = await readKeystoreBlob();
    if (blob) return { kind: "sealed", blob };
    const legacy = await readLegacyState();
    if (legacy && typeof legacy === "object") {
      return { kind: "needs_password", legacyState: legacy };
    }
    return { kind: "fresh" };
  },

  async isSealed(): Promise<boolean> {
    return (await readKeystoreBlob()) !== null;
  },

  async isUnlocked(): Promise<boolean> {
    const key = await loadSessionKeyFromStorage();
    return key !== null;
  },

  /**
   * Initialize the keystore with a password and the initial plaintext
   * state. Used during onboarding and during legacy migration.
   */
  async seal(password: string, plaintextState: unknown): Promise<void> {
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const json = JSON.stringify(plaintextState);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: asBuffer(iv) },
        key,
        asBuffer(new TextEncoder().encode(json)),
      ),
    );
    const now = Date.now();
    const blob: KeystoreBlob = {
      schema: KEYSTORE_SCHEMA,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
      iterations: PBKDF2_ITERATIONS,
      createdAt: now,
      updatedAt: now,
    };
    await writeKeystoreBlob(blob);
    await saveSessionKey(key);
    await removeLegacyState();
  },

  /**
   * Unlock with a password. Throws WrongPasswordError on bad input.
   * The derived key is cached for subsequent reads.
   */
  async unlock(password: string): Promise<unknown> {
    const blob = await readKeystoreBlob();
    if (!blob) throw new Error("No keystore initialized");
    const salt = base64ToBytes(blob.salt);
    const iv = base64ToBytes(blob.iv);
    const key = await deriveKey(password, salt, blob.iterations);
    let plaintextJson: string;
    try {
      const plaintextBytes = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: asBuffer(iv) },
          key,
          asBuffer(base64ToBytes(blob.ciphertext)),
        ),
      );
      plaintextJson = new TextDecoder().decode(plaintextBytes);
    } catch {
      throw new WrongPasswordError();
    }
    await saveSessionKey(key);
    return JSON.parse(plaintextJson);
  },

  /**
   * Read the plaintext state using the cached session key. Returns null
   * if locked.
   */
  async read(): Promise<unknown | null> {
    const blob = await readKeystoreBlob();
    if (!blob) return null;
    const key = await loadSessionKeyFromStorage();
    if (!key) return null;
    const iv = base64ToBytes(blob.iv);
    try {
      const plaintextBytes = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: asBuffer(iv) },
          key,
          asBuffer(base64ToBytes(blob.ciphertext)),
        ),
      );
      const plaintextJson = new TextDecoder().decode(plaintextBytes);
      return JSON.parse(plaintextJson);
    } catch {
      // Session key was stale (e.g. password was changed in another tab).
      await clearSessionKey();
      return null;
    }
  },

  /**
   * Re-encrypt the existing plaintext with the current key under a fresh
   * IV. Used on every state write.
   */
  async write(plaintextState: unknown): Promise<void> {
    const blob = await readKeystoreBlob();
    if (!blob) throw new Error("No keystore initialized");
    const key = await loadSessionKeyFromStorage();
    if (!key) throw new KeystoreLockedError();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const json = JSON.stringify(plaintextState);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: asBuffer(iv) },
        key,
        asBuffer(new TextEncoder().encode(json)),
      ),
    );
    const next: KeystoreBlob = {
      ...blob,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
      updatedAt: Date.now(),
    };
    await writeKeystoreBlob(next);
  },

  /**
   * Change password by re-deriving a new KEK and re-encrypting the
   * current plaintext. The old password is required to authenticate
   * the change.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!newPassword || newPassword.length < 8) {
      throw new Error("New password must be at least 8 characters");
    }
    const plaintext = await this.unlock(oldPassword);
    await this.seal(newPassword, plaintext);
  },

  /**
   * Locks by wiping the in-memory + session-storage copies of the KEK.
   * The encrypted blob remains; user must re-enter the password to
   * decrypt.
   */
  async lock(): Promise<void> {
    await clearSessionKey();
  },

  /**
   * Wipe everything — keystore blob, session key, and any lingering
   * legacy state. Used by Settings -> Reset Wallet.
   */
  async wipe(): Promise<void> {
    // Make the durable local wipe the first awaited operation. This
    // function is used by "forget this wallet" as an escape hatch, so
    // it must not be blocked by best-effort session cleanup.
    sessionKey = null;
    await chrome.storage.local.remove([KEYSTORE_KEY, LEGACY_STATE_KEY]);
    void clearSessionKey();
  },
};

/**
 * A very lightweight password strength scorer used by the onboarding
 * UI. Returns an integer 0..4 with a short label. Not a substitute for
 * a real password manager, just enough to nudge users away from "1234".
 */
export function scorePasswordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!password) return { score: 0, label: "Empty" };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  const labels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;
  const clamped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
  return { score: clamped, label: labels[clamped] };
}
