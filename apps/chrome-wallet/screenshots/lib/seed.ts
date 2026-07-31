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
const KEYSTORE_PASSWORD = "screenshot-harness";
const SESSION_KEY_KEY = "arch_wallet_session_key";

const SCREENSHOT_ACCOUNT = {
  id: "screenshot-account",
  label: "Arch Wallet",
  btcAddress: "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m",
  publicKeyHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  archAddress: "11111111111111111111111111111111",
  kind: "turnkey",
  turnkeyResourceId: "screenshot-resource",
  organizationId: "screenshot-org",
  authMethod: "email",
  createdAt: 0,
};

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function sealState(state: Record<string, unknown>): Promise<{
  keystore: Record<string, unknown>;
  sessionKey: string;
}> {
  const subtle = globalThis.crypto.subtle;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(KEYSTORE_PASSWORD),
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
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(state)),
    ),
  );
  const now = Date.now();
  const rawKey = new Uint8Array(await subtle.exportKey("raw", key));

  return {
    keystore: {
      schema: KEYSTORE_SCHEMA,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
      iterations: PBKDF2_ITERATIONS,
      createdAt: now,
      updatedAt: now,
    },
    sessionKey: toBase64(rawKey),
  };
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
  const { keystore } = await sealState({});
  return {
    local: {
      [KEYSTORE_KEY]: keystore,
    },
  };
}

/**
 * Produce an unlocked, synthetic wallet. The matching capture fixture
 * intercepts every request to its private host, so no credentials, wallet,
 * network, or live service are used.
 */
export async function makeDeterministicWalletSeed(): Promise<StorageSeed> {
  const { keystore, sessionKey } = await sealState({
    schemaVersion: 5,
    initialized: true,
    locked: false,
    network: "testnet4",
    activeAccountId: SCREENSHOT_ACCOUNT.id,
    accounts: [SCREENSHOT_ACCOUNT],
    connectedSites: {},
    hubBaseUrl: "https://screenshots.arch.network",
    hubApiKey: "screenshot-key",
    indexerBaseUrl: "",
    indexerApiKey: "",
    openAs: "popup",
    recentRecipients: [],
    contacts: [],
    autoLockMinutes: 15,
    sentryOptIn: false,
    debugMode: false,
  });

  return {
    local: {
      [KEYSTORE_KEY]: keystore,
      arch_wallet_install_id: "screenshot-install",
    },
    session: { [SESSION_KEY_KEY]: sessionKey },
  };
}

