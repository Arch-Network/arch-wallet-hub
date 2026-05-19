/**
 * Phase 1.10 -- Turnkey recovery credential-bundle handling.
 *
 * The OTP_AUTH activity (`/recovery/email/verify` on the Hub) returns
 * an HPKE-encrypted "credential bundle". This bundle is a bs58check
 * envelope wrapping (a) a 33-byte compressed encapsulated public key
 * and (b) the AES-GCM ciphertext of a freshly-issued P-256 API key
 * private key. The client decrypts it locally so the recovered key
 * never crosses the wire in plaintext, then uses the recovered
 * keypair as a single-use Turnkey ApiKeyStamper to call
 * CREATE_AUTHENTICATORS against the sub-org -- attaching a new
 * passkey without further help from the Hub.
 *
 * Why a wrapper at all: `@turnkey/crypto` ships the low-level
 * primitives but its API is keyed to internal name conventions
 * (`embeddedKey` etc.) that don't match the rest of our code.
 * Wrapping them here gives the recovery UI a clean "generate
 * keypair / decrypt bundle / use to stamp" surface, and lets us swap
 * out the implementation (port to vanilla WebCrypto if the
 * @turnkey/crypto bundle size becomes a problem) without rewriting
 * the call sites.
 */

import {
  decryptCredentialBundle,
  getPublicKey,
} from "@turnkey/crypto";

export interface EphemeralRecoveryKeypair {
  /** Hex of the 32-byte raw private key. Keep in memory only. */
  privateKeyHex: string;
  /** Hex of the 33-byte compressed public key. */
  publicKeyHex: string;
  /** Hex of the 65-byte (0x04-prefixed) uncompressed public key. This
   *  is the format Turnkey's `targetPublicKey` parameter expects. */
  publicKeyUncompressedHex: string;
}

/**
 * Generate a fresh P-256 keypair to use as the recovery target.
 *
 * Important: this uses browser WebCrypto instead of
 * `@turnkey/crypto.generateP256KeyPair()`. The Turnkey helper is
 * synchronous and can do enough elliptic-curve work on the extension
 * UI thread that OTP submit appears to freeze Chrome. WebCrypto runs
 * asynchronously in the browser crypto backend, which keeps the
 * popup/sidepanel responsive while the key is minted.
 *
 * The private half stays in this process (don't persist it); the
 * uncompressed public half is sent to the Hub.
 */
export async function generateRecoveryKeypair(): Promise<EphemeralRecoveryKeypair> {
  const keypair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);
  if (!jwk.d || !jwk.x || !jwk.y) {
    throw new Error("Failed to export recovery key material");
  }
  const d = base64UrlToBytes(jwk.d);
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (d.length !== 32 || x.length !== 32 || y.length !== 32) {
    throw new Error("Unexpected P-256 recovery key shape");
  }
  const privateKeyHex = uint8ArrayToHex(d);
  const xHex = uint8ArrayToHex(x);
  const yHex = uint8ArrayToHex(y);
  const compressedPrefix = (y[y.length - 1]! & 1) === 1 ? "03" : "02";
  return {
    privateKeyHex,
    publicKeyHex: `${compressedPrefix}${xHex}`,
    publicKeyUncompressedHex: `04${xHex}${yHex}`,
  };
}

export interface RecoveredApiKey {
  /** Hex of the recovered P-256 private key (use for ApiKeyStamper). */
  privateKeyHex: string;
  /** Hex of the matching 33-byte compressed public key. */
  publicKeyHex: string;
}

/**
 * Decrypt the Hub-returned `credentialBundle` using the ephemeral
 * private key we generated at the start of the flow. Returns the
 * recovered API key as a (privateKey, publicKey) hex pair ready to
 * feed into `@turnkey/api-key-stamper`.
 *
 * Throws on bundle malformation, wrong key, or decryption failure --
 * the caller surfaces a generic "verification failed" message rather
 * than leaking which specific check failed.
 */
export function decryptRecoveryBundle(params: {
  credentialBundle: string;
  ephemeralPrivateKeyHex: string;
}): RecoveredApiKey {
  const privateKeyHex = decryptCredentialBundle(
    params.credentialBundle,
    params.ephemeralPrivateKeyHex,
  );

  // `getPublicKey` accepts a hex string and defaults to compressed.
  // We want the compressed form so the stamper can prove ownership
  // of the same `apiKeyId` Turnkey just issued.
  const compressed = getPublicKey(privateKeyHex, true);
  const publicKeyHex = uint8ArrayToHex(compressed);
  return { privateKeyHex, publicKeyHex };
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
