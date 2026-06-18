/**
 * Phase 2a of the session-auth rollout (docs/security/session-auth-rollout.md):
 * mint a per-user Wallet Hub session token and let the SDK attach it to
 * outgoing requests.
 *
 * Why this is safe to ship ahead of server enforcement
 * ----------------------------------------------------
 * The Hub does NOT yet REQUIRE a session token on the routes the wallet
 * calls. This module only makes the wallet START SENDING one. It is
 * strictly fail-soft: any error minting (offline, older Hub, missing
 * default pubkey, locked signing session) is swallowed and the wallet
 * keeps working on app-API-key-only auth exactly as before. Once shipped
 * builds reliably carry tokens, the Hub can begin enforcing
 * `requireSession` per route (Phase 2b) without breaking anyone.
 *
 * Minting cost
 * ------------
 * Minting reuses the Turnkey signing session that just opened (passkey
 * WebAuthn / email OTP already happened), so it adds no extra user
 * prompt -- only one `createSessionChallenge` + one raw-payload stamp +
 * one `mintSessionToken` round trip, and only ONCE per signing session
 * (the result is cached until it expires or the wallet locks).
 */

import type { WalletAccount } from "../state/types";
import { isExternalAccount, isWatchAccount } from "../state/types";
import { getClient, getExternalUserId } from "./sdk";
import { signerForAccount } from "../signers/Signer";
import { readHubToken, writeHubToken } from "./hub-session-store";
import { log } from "./log";

/**
 * Ensure a Hub session token exists (and is attached to the cached SDK
 * client) for `account`, minting one if needed.
 *
 * Call this right after a Turnkey signing session opens. Fire-and-forget
 * is fine: the SDK re-reads the cached token on every `getClient()`, so
 * once this resolves the token flows on subsequent requests from any
 * extension context.
 *
 * Never throws -- failures are logged and ignored.
 */
export async function ensureHubSession(account: WalletAccount): Promise<void> {
  try {
    // External/watch accounts have no Turnkey key on this device to
    // schnorr-sign the challenge with, so there's nothing to mint.
    if (isExternalAccount(account) || isWatchAccount(account)) return;
    if (!account.turnkeyResourceId) return;

    const externalUserId = await getExternalUserId();
    const existing = await readHubToken(externalUserId, account.id);
    if (existing) {
      // Already have a live token; make sure it's attached and stop.
      (await getClient()).setSessionToken(existing);
      return;
    }

    const client = await getClient();
    const challenge = await client.createSessionChallenge({
      externalUserId,
      turnkeyResourceId: account.turnkeyResourceId,
    });

    // Sign the 32-byte challenge payload directly (schnorr, no extra
    // hashing). `signArchPayload` uses HASH_FUNCTION_NO_OP and returns
    // r||s, which is exactly what the Hub's verifyChallengeSignature
    // checks against the resource's default (x-only Taproot) pubkey.
    const signer = signerForAccount(account);
    const { signature64Hex } = await signer.signArchPayload({
      signingRequestId: "",
      payloadHex: challenge.payloadHex,
    });

    const { sessionToken, expiresAt } = await client.mintSessionToken({
      challengeId: challenge.challengeId,
      signatureHex: signature64Hex,
    });

    const expiresAtMs = Date.parse(expiresAt);
    await writeHubToken(
      externalUserId,
      account.id,
      sessionToken,
      Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 23 * 60 * 60 * 1000,
    );
    client.setSessionToken(sessionToken);
    log.info("hub-session.minted", { accountId: account.id });
  } catch (err) {
    // Fail soft: the wallet stays fully functional on app-key auth.
    log.warn("hub-session.mint-failed", {
      accountId: account.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
