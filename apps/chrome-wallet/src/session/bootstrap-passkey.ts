/**
 * Passkey-based session bootstrap.
 *
 * The user already has a WebAuthn credential registered against their
 * sub-org from onboarding. We use that credential to stamp exactly
 * one Turnkey activity -- ACTIVITY_TYPE_STAMP_LOGIN -- which
 * server-side registers the freshly-minted IndexedDB public key as a
 * "Login API key" with bounded `expirationSeconds`. After this
 * round-trip, any holder of the matching IndexedDB private key (and
 * only that holder; it is unextractable, locked to this device's
 * SubtleCrypto) can stamp Turnkey activities on the user's behalf
 * until the TTL runs out.
 *
 * Cost: one WebAuthn prompt per `open()`. That's the *only* prompt
 * the user sees during the unlocked window; subsequent signs are
 * silent.
 *
 * What this module deliberately does NOT do:
 *   - Store the session JWT Turnkey returns. We don't use it.
 *     Signing only needs the registered API key, and the stamper
 *     already owns the private half locally.
 *   - Persist anything to localStorage or wallet-state. The
 *     IndexedDbStamper is the single source of truth for "is there
 *     a key on this device?"; SessionManager owns expiry tracking.
 *
 * Failure modes:
 *   - User dismisses WebAuthn -> Turnkey/SDK throws; the caller
 *     (SessionManager) catches and clears the half-minted IndexedDB
 *     key so we don't leave a "session-but-not-really" artifact.
 *   - Account org has no registered authenticator (orphan record
 *     after a sub-org deletion) -> Turnkey 4xx; same cleanup path.
 */

import { Turnkey } from "@turnkey/sdk-browser";
import type { WalletAccount } from "../state/types";
import { TURNKEY_API_BASE_URL } from "./constants";
import type { SessionBootstrap } from "./types";

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function allowCredentialsForAccount(
  account: WalletAccount,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!account.passkeyCredentialId) return undefined;
  return [
    {
      id: base64UrlToBytes(account.passkeyCredentialId),
      type: "public-key",
    },
  ];
}

function buildPasskeyTurnkey(account: WalletAccount): Turnkey {
  // rpId must match the WebAuthn relying party recorded at
  // registration. In dev that's localhost; in production it's
  // whatever document.location.hostname resolves to inside the
  // extension popup/sidepanel context.
  const hostname = globalThis.location?.hostname ?? "localhost";
  return new Turnkey({
    apiBaseUrl: TURNKEY_API_BASE_URL,
    defaultOrganizationId: account.organizationId,
    rpId: hostname === "localhost" ? "localhost" : hostname,
  });
}

export class PasskeyBootstrap implements SessionBootstrap {
  readonly id = "passkey";

  async register(args: {
    account: WalletAccount;
    publicKeyHex: string;
    expirationSeconds: number;
  }): Promise<void> {
    const tk = buildPasskeyTurnkey(args.account);
    // The passkey client stamps every activity it sends with a
    // WebAuthn assertion against the user's already-registered
    // authenticator. Turnkey's policy engine pins the new "Login
    // API key" to the same user that owns the stamping credential,
    // so we don't have to pass userId explicitly.
    await tk.passkeyClient({
      allowCredentials: allowCredentialsForAccount(args.account),
    }).stampLogin({
      publicKey: args.publicKeyHex,
      expirationSeconds: String(args.expirationSeconds),
      // Don't invalidate prior keys -- if we did, recovering on a
      // second device would lock out the first. Stale keys age out
      // on their own via expirationSeconds.
    });
  }
}

export const passkeyBootstrap = new PasskeyBootstrap();
