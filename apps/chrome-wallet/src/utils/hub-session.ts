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

import type { SessionSigner } from "@arch-network/wallet-hub-sdk";
import type { NetworkId, WalletAccount } from "../state/types";
import { isExternalAccount, isWatchAccount } from "../state/types";
import { getClient, getExternalUserId } from "./sdk";
import { signerForAccount } from "../signers/Signer";
import { getExternalWalletAdapter } from "../wallets/external-wallets";
import { readHubToken, writeHubToken } from "./hub-session-store";
import { log } from "./log";

/**
 * Build the {@link SessionSigner} the SDK uses to mint (and refresh) a
 * Hub session token for `account`. This is the single place that maps a
 * wallet to "how it proves control of itself":
 *
 *   - Turnkey (passkey/email) accounts schnorr-sign the 32-byte
 *     challenge payload with the session-stamped IndexedDB key (the
 *     same primitive the signing path uses). Requires an open Turnkey
 *     signing session (open it first via ensureSigningSessionForAccount).
 *   - External / linked wallets (Xverse, UniSat) BIP-322-sign the
 *     challenge message via their injected provider.
 *
 * Returns undefined for accounts that can't mint (watch-only, or a
 * Turnkey account with no resource id yet).
 */
export function buildSessionSigner(
  account: WalletAccount,
  externalUserId: string,
  network: NetworkId,
): SessionSigner | undefined {
  if (isWatchAccount(account)) return undefined;

  if (isExternalAccount(account)) {
    const adapter = getExternalWalletAdapter(account.externalProvider);
    const address = account.btcAddress;
    return {
      kind: "external",
      externalUserId,
      walletProvider: account.externalProvider,
      address,
      signMessage: async (message: string) => {
        const { signature } = await adapter.signMessage({ address, message, network });
        return signature;
      },
    };
  }

  if (!account.turnkeyResourceId) return undefined;
  return {
    kind: "turnkey",
    externalUserId,
    turnkeyResourceId: account.turnkeyResourceId,
    signChallenge: async (payloadHex: string) => {
      // Sign the 32-byte challenge payload directly (schnorr, no extra
      // hashing). `signArchPayload` uses HASH_FUNCTION_NO_OP and returns
      // r||s, which is exactly what the Hub's verifyChallengeSignature
      // checks against the resource's default (x-only Taproot) pubkey.
      const { signature64Hex } = await signerForAccount(account).signArchPayload({
        signingRequestId: "",
        payloadHex,
      });
      return signature64Hex;
    },
  };
}

/**
 * Ensure a Hub session token exists (and is attached to the cached SDK
 * client) for `account`, minting one if needed. Works for BOTH Turnkey
 * and external/linked wallets:
 *
 *   - Turnkey: reuse the just-opened signing session to schnorr-sign the
 *     challenge (no extra user prompt).
 *   - External: BIP-322-sign the challenge via the source wallet (this
 *     prompts the external wallet once; the result is cached for the
 *     browser session so repeat approvals don't re-prompt).
 *
 * `await` this before any enforced call (createSigningRequest/submit) so
 * the EXACT account being signed with has a token attached to the client
 * — independent of which account is "active" in the store. The token is
 * user-scoped (the Hub binds it to the install's externalUserId), but we
 * still attach the per-account cached token here so a never-minted active
 * account can't leave the client tokenless.
 *
 * Never throws -- failures are logged and ignored; an enforced call will
 * then surface a clear, correctly-labelled session 401 to the user.
 */
export async function ensureHubSession(
  account: WalletAccount,
  network: NetworkId,
): Promise<void> {
  try {
    if (isWatchAccount(account)) return;

    const externalUserId = await getExternalUserId();
    const client = await getClient();

    const existing = await readHubToken(externalUserId, account.id);
    if (existing) {
      // Already have a live token; make sure it's attached and stop.
      client.setSessionToken(existing);
      return;
    }

    const signer = buildSessionSigner(account, externalUserId, network);
    if (!signer) return;

    let sessionToken: string;
    let expiresAt: string;
    if (signer.kind === "turnkey") {
      const challenge = await client.createSessionChallenge({
        externalUserId: signer.externalUserId,
        turnkeyResourceId: signer.turnkeyResourceId,
      });
      const signatureHex = await signer.signChallenge(challenge.payloadHex);
      ({ sessionToken, expiresAt } = await client.mintSessionToken({
        challengeId: challenge.challengeId,
        signatureHex,
      }));
    } else {
      const challenge = await client.createExternalSessionChallenge({
        externalUserId: signer.externalUserId,
        walletProvider: signer.walletProvider,
        address: signer.address,
      });
      const signature = await signer.signMessage(challenge.message);
      ({ sessionToken, expiresAt } = await client.mintExternalSessionToken({
        challengeId: challenge.challengeId,
        signature,
      }));
    }

    const expiresAtMs = Date.parse(expiresAt);
    await writeHubToken(
      externalUserId,
      account.id,
      sessionToken,
      Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 23 * 60 * 60 * 1000,
    );
    client.setSessionToken(sessionToken);
    log.info("hub-session.minted", { accountId: account.id, kind: signer.kind });
  } catch (err) {
    // Fail soft: the wallet stays functional; an enforced call will
    // surface a correctly-labelled session error if no token results.
    log.warn("hub-session.mint-failed", {
      accountId: account.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
