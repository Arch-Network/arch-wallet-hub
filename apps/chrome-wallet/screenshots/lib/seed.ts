import { readFileSync, existsSync } from "node:fs";

// Shape of the data we inject into the extension's storage areas before
// capturing a screen. `local` → chrome.storage.local, `session` →
// chrome.storage.session.
export interface StorageSeed {
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
}

// Must mirror src/crypto/keystore.ts so the app recognizes the blob.
const KEYSTORE_KEY = "arch_wallet_keystore";
const KEYSTORE_SCHEMA = 2;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Build a storage seed that puts the wallet into the LOCKED state so the
 * harness can capture the Unlock screen WITHOUT any real wallet/secret.
 *
 * We seal a throwaway, empty state under a throwaway password using the exact
 * same crypto as the in-app keystore (AES-GCM + PBKDF2-SHA256). The result is
 * a structurally valid `arch_wallet_keystore` blob with NO session key, which
 * the App router renders as `<Unlock/>`. Nothing here is sensitive: there is
 * no mnemonic, no account, and the password is a constant.
 */
export async function makeLockedKeystoreSeed(): Promise<StorageSeed> {
  const subtle = globalThis.crypto.subtle;
  const password = "screenshot-harness";
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  // Empty placeholder state — only the blob's existence (sealed, no session
  // key) matters for rendering the locked Unlock screen.
  const json = JSON.stringify({});
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json)),
  );

  const now = Date.now();
  return {
    local: {
      [KEYSTORE_KEY]: {
        schema: KEYSTORE_SCHEMA,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        iterations: PBKDF2_ITERATIONS,
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

/**
 * Load a developer-provided seed file describing a real (unlocked) wallet's
 * storage so data-rich screens (dashboard / send / history) can be captured.
 *
 * To produce one: open the built extension, unlock your wallet, then in the
 * popup's DevTools console run and save the output of:
 *   JSON.stringify({
 *     local: await chrome.storage.local.get(null),
 *     session: await chrome.storage.session.get(null),
 *   })
 * Save it to the path given by WALLET_SEED_FILE (gitignored). It contains key
 * material, so it must NEVER be committed.
 */
export function loadSeedFile(filePath: string): StorageSeed | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as StorageSeed;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Seed file ${filePath} is not a JSON object`);
  }
  return parsed;
}
