/**
 * Per-user session token primitives.
 *
 * The Hub used to trust a caller-supplied `externalUserId` on every
 * mutating endpoint. Any client with the shared platform x-api-key
 * could impersonate any user of the same app. This module
 * implements the proof-of-control handshake that closes audit
 * findings X1 / Backend M7 / SDK C1:
 *
 *   1. Server issues a random-nonce challenge for (app_id, user_id,
 *      turnkey_resource).
 *   2. Client signs the challenge's `payload_hex` with the user's
 *      Turnkey-stamped IndexedDB session (or any caller holding the
 *      resource's default private key). Signature is a 64-byte
 *      schnorr sig over the 32-byte payload.
 *   3. Server verifies via @noble/curves/secp256k1 schnorr.verify
 *      against the resource's stored `default_public_key_hex`.
 *      On success, mints a token, stores its sha256 hash, returns
 *      the plaintext token once.
 *   4. Protected routes use `requireSessionToken` (see
 *      ../plugins/sessionAuth.ts) which looks the bearer up,
 *      checks expiry + revocation, and binds {appId, userId,
 *      externalUserId} to `request.session`.
 *
 * Token format: `whs_v1_<base64url>`. The version prefix
 * disambiguates session bearers from any future token shape and
 * lets the access layer skip API-key lookup for session-shaped
 * Authorization headers.
 */

import type { PoolClient } from "pg";
import crypto from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { Verifier } from "@saturnbtcio/bip322-js";

export const SESSION_TOKEN_PREFIX = "whs_v1_";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_LAST_USED_DEBOUNCE_MS = 60 * 1000;

export type AuthSessionRow = {
  id: string;
  app_id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
};

export type AuthChallengeRow = {
  id: string;
  app_id: string;
  user_id: string;
  payload_hex: string;
  message: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  /**
   * External (BIP-322) challenges only (migration 015). NULL for the
   * Turnkey schnorr path. A non-null `address` is what marks a challenge
   * as belonging to the external-wallet mint flow.
   */
  wallet_provider: string | null;
  address: string | null;
};

export type SessionPrincipal = {
  sessionId: string;
  appId: string;
  userId: string;
  externalUserId: string;
};

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Build the canonical challenge message + payload hash. The message
 * is a multi-line human-readable string the client can show to the
 * user before approval; the payload hash is what actually gets
 * signed (32 bytes, hex-encoded).
 */
function buildChallengeMessage(params: {
  appId: string;
  externalUserId: string;
  resourceId: string;
  nonceHex: string;
  expiresAt: Date;
}): { message: string; payloadHex: string } {
  const message = [
    "Wallet Hub session challenge",
    `App: ${params.appId}`,
    `User: ${params.externalUserId}`,
    `Resource: ${params.resourceId}`,
    `Nonce: ${params.nonceHex}`,
    `Expires: ${params.expiresAt.toISOString()}`,
  ].join("\n");
  const payloadHex = crypto.createHash("sha256").update(message, "utf8").digest("hex");
  return { message, payloadHex };
}

export async function createChallenge(
  client: PoolClient,
  params: {
    appId: string;
    userId: string;
    externalUserId: string;
    resourceId: string;
  },
): Promise<{
  challengeId: string;
  message: string;
  payloadHex: string;
  expiresAt: string;
}> {
  const nonceHex = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const { message, payloadHex } = buildChallengeMessage({
    appId: params.appId,
    externalUserId: params.externalUserId,
    resourceId: params.resourceId,
    nonceHex,
    expiresAt,
  });
  const res = await client.query<{ id: string }>(
    `
      INSERT INTO auth_challenges (app_id, user_id, payload_hex, message, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    [params.appId, params.userId, payloadHex, message, expiresAt.toISOString()],
  );
  return {
    challengeId: res.rows[0]!.id,
    message,
    payloadHex,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Build the canonical challenge message for an EXTERNAL (linked /
 * BIP-322) wallet. Unlike the Turnkey path, the signature surface is
 * the human-readable `message` string itself (BIP-322 signs the
 * message, not a 32-byte payload hash), so this message is what the
 * wallet actually signs. The format mirrors the wallet-linking
 * challenge (routes/walletLinking.ts) so external wallets that already
 * implement that flow need no new signing logic.
 */
function buildExternalChallengeMessage(params: {
  appId: string;
  externalUserId: string;
  walletProvider: string;
  address: string;
  nonceHex: string;
  expiresAt: Date;
}): string {
  return [
    "Wallet Hub session challenge",
    `App: ${params.appId}`,
    `User: ${params.externalUserId}`,
    `Provider: ${params.walletProvider}`,
    `Address: ${params.address}`,
    `Nonce: ${params.nonceHex}`,
    `Expires: ${params.expiresAt.toISOString()}`,
    "",
    "Only sign this message if you trust the application.",
  ].join("\n");
}

/**
 * Create a session challenge for an external (linked / BIP-322)
 * wallet. The resulting `message` is the exact string the wallet must
 * BIP-322-sign; the (provider, address) it targets are persisted on
 * the row so the mint can verify the signature against that address
 * and re-check `linked_wallets` ownership.
 *
 * `payload_hex` is still populated (sha256 of the message) only to
 * satisfy the NOT NULL column from migration 013; it is NOT part of
 * the external signature surface.
 */
export async function createExternalChallenge(
  client: PoolClient,
  params: {
    appId: string;
    userId: string;
    externalUserId: string;
    walletProvider: string;
    address: string;
  },
): Promise<{
  challengeId: string;
  message: string;
  expiresAt: string;
}> {
  const nonceHex = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const message = buildExternalChallengeMessage({
    appId: params.appId,
    externalUserId: params.externalUserId,
    walletProvider: params.walletProvider,
    address: params.address,
    nonceHex,
    expiresAt,
  });
  const payloadHex = crypto.createHash("sha256").update(message, "utf8").digest("hex");
  const res = await client.query<{ id: string }>(
    `
      INSERT INTO auth_challenges (app_id, user_id, payload_hex, message, expires_at, wallet_provider, address)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [
      params.appId,
      params.userId,
      payloadHex,
      message,
      expiresAt.toISOString(),
      params.walletProvider,
      params.address,
    ],
  );
  return {
    challengeId: res.rows[0]!.id,
    message,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Look up a challenge under a row lock and return it if it's still
 * usable. Caller is expected to be inside a transaction so the
 * lock survives until consume/mint completes.
 */
async function loadConsumableChallenge(
  client: PoolClient,
  params: { challengeId: string; appId: string },
): Promise<AuthChallengeRow | null> {
  const res = await client.query<AuthChallengeRow>(
    `
      SELECT * FROM auth_challenges
      WHERE id = $1 AND app_id = $2
        AND consumed_at IS NULL
        AND expires_at > NOW()
      FOR UPDATE
    `,
    [params.challengeId, params.appId],
  );
  return res.rows[0] ?? null;
}

async function markChallengeConsumed(
  client: PoolClient,
  challengeId: string,
): Promise<void> {
  await client.query(
    `UPDATE auth_challenges SET consumed_at = NOW() WHERE id = $1`,
    [challengeId],
  );
}

/**
 * Verify the signature over the challenge's payload using the
 * resource's stored default Taproot xOnly pubkey. Returns true on
 * success. Implementation deliberately uses the same
 * `schnorr.verify` primitive the signing-requests route already
 * uses for Taproot sighash verification.
 */
export function verifyChallengeSignature(params: {
  payloadHex: string;
  signatureHex: string;
  defaultPublicKeyHex: string;
}): boolean {
  // Defensive shape checks: the noble primitive will throw on bad
  // inputs, so we convert those into a boolean here so callers can
  // reply with a consistent 400 rather than a 500.
  const cleanSig = params.signatureHex.replace(/^0x/, "");
  const cleanPayload = params.payloadHex.replace(/^0x/, "");
  const cleanPub = params.defaultPublicKeyHex.replace(/^0x/, "");
  if (cleanSig.length !== 128) return false;
  if (cleanPayload.length !== 64) return false;
  if (cleanPub.length !== 64) return false;
  try {
    return schnorr.verify(
      Buffer.from(cleanSig, "hex"),
      Buffer.from(cleanPayload, "hex"),
      Buffer.from(cleanPub, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Verify a BIP-322 signature over an external challenge's
 * human-readable `message`, produced by a linked wallet that controls
 * `address`. Reuses the exact `@saturnbtcio/bip322-js` Verifier the
 * wallet-linking flow uses (routes/walletLinking.ts), so any wallet
 * that can link can also mint a session. Returns a boolean; the
 * library throws on malformed input, which we map to `false` so the
 * caller can reply with a consistent 401 rather than a 500.
 */
export function verifyExternalChallengeSignature(params: {
  address: string;
  message: string;
  signature: string;
}): boolean {
  try {
    return Verifier.verifySignature(params.address, params.message, params.signature);
  } catch {
    return false;
  }
}

/**
 * Mint a fresh session token after challenge verification. Caller
 * is responsible for verifying the signature; this function only
 * does the bookkeeping (consume challenge + insert session row).
 *
 * Returns the plaintext token (visible exactly once) plus the
 * session row metadata.
 */
export async function mintSession(
  client: PoolClient,
  params: { challengeId: string; appId: string; userId: string },
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const random = crypto.randomBytes(32).toString("base64url");
  const token = `${SESSION_TOKEN_PREFIX}${random}`;
  const tokenHash = sha256Hex(token);
  const res = await client.query<{ id: string }>(
    `
      INSERT INTO auth_sessions (app_id, user_id, token_hash, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [params.appId, params.userId, tokenHash, expiresAt.toISOString()],
  );
  await markChallengeConsumed(client, params.challengeId);
  return {
    token,
    sessionId: res.rows[0]!.id,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Resolve a bearer token to its principal. Returns null if the
 * token doesn't exist, is revoked, or has expired. Bumps
 * `last_used_at` opportunistically (debounced by
 * SESSION_LAST_USED_DEBOUNCE_MS) so the audit trail is useful
 * without making every request pay an UPDATE.
 *
 * The caller's appId is passed in so we never resolve a token
 * minted for a different app even if it somehow matched on
 * token_hash (defence in depth; the unique constraint should make
 * this impossible).
 */
export async function resolveSessionToken(
  client: PoolClient,
  params: { token: string; appId: string },
): Promise<SessionPrincipal | null> {
  if (!params.token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const tokenHash = sha256Hex(params.token);
  const res = await client.query<{
    id: string;
    app_id: string;
    user_id: string;
    last_used_at: string;
    external_user_id: string | null;
  }>(
    `
      SELECT s.id, s.app_id, s.user_id, s.last_used_at, u.external_user_id
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.app_id = $2
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
    `,
    [tokenHash, params.appId],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!row.external_user_id) return null;

  const lastUsedMs = new Date(row.last_used_at).getTime();
  if (Date.now() - lastUsedMs > SESSION_LAST_USED_DEBOUNCE_MS) {
    // Best-effort; failure here doesn't invalidate the session.
    await client
      .query(`UPDATE auth_sessions SET last_used_at = NOW() WHERE id = $1`, [row.id])
      .catch(() => undefined);
  }

  return {
    sessionId: row.id,
    appId: row.app_id,
    userId: row.user_id,
    externalUserId: row.external_user_id,
  };
}

export async function revokeSession(
  client: PoolClient,
  params: { sessionId: string; appId: string },
): Promise<void> {
  await client.query(
    `UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1 AND app_id = $2 AND revoked_at IS NULL`,
    [params.sessionId, params.appId],
  );
}

export { loadConsumableChallenge };
