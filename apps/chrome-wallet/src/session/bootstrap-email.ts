/**
 * Email-OTP-based session bootstrap.
 *
 * The contract: the caller already ran the Hub-mediated OTP_AUTH flow
 * (`/recovery/email/init` + `/recovery/email/verify`) and ended up
 * with two artefacts:
 *
 *   1. A short-lived recovery API key, decrypted locally from the
 *      Hub-returned HPKE `credentialBundle`. This key has a hard
 *      15-minute expiration baked in by Turnkey at OTP_AUTH time, so
 *      it isn't a long-lived secret even if it leaked.
 *   2. The user's sub-org id and root-user id.
 *
 * The bootstrap's only job is to spend that recovery key once: stamp
 * a single STAMP_LOGIN activity that promotes the freshly-minted
 * IndexedDB pubkey to a "Login API key" on the user's sub-org. After
 * `register()` returns, the recovery key reference is dropped from
 * memory (the calling code wraps the construction in a try/finally
 * that nulls the bundle, and we do not store the key anywhere
 * outside of locals in this function).
 *
 * Trade-off vs passkey bootstrap:
 *   - Passkey: one WebAuthn prompt per unlock (~2s, no network).
 *   - Email:   one OTP_AUTH round-trip + a code typed in by the user
 *              per unlock. Heavier but doesn't depend on the device
 *              having a registered authenticator.
 *
 * Why we don't roll the OTP flow into this module: that flow is also
 * the recovery path (Recover.tsx) for passkey wallets, and lives
 * naturally in the UI layer where the user is typing the code. This
 * module is the "I already have the bundle, finish the bootstrap"
 * primitive. Two callers wrap it:
 *   - Unlock.tsx for unlocking an existing email wallet.
 *   - Recover.tsx when the user is recovering an email wallet onto a
 *     new device (P2 wires this in).
 */

import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient } from "@turnkey/http";
import type { WalletAccount } from "../state/types";
import {
  decryptRecoveryBundle,
  type RecoveredApiKey,
} from "../crypto/turnkey-bundle";
import { TURNKEY_API_BASE_URL } from "./constants";
import type { SessionBootstrap } from "./types";
import { log } from "../utils/log";

export interface EmailBootstrapArgs {
  /**
   * Hub-returned HPKE-encrypted bundle wrapping the recovery API key.
   * Decrypted inside `register()` and discarded immediately after.
   */
  credentialBundle: string;
  /**
   * Hex private key of the ephemeral P-256 keypair the bundle was
   * encrypted to. Pair with `generateRecoveryKeypair()` from
   * `crypto/turnkey-bundle.ts`.
   */
  ephemeralPrivateKeyHex: string;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  code: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(code)), ms);
    }),
  ]);
}

export class EmailBootstrap implements SessionBootstrap {
  readonly id = "email";

  constructor(private readonly args: EmailBootstrapArgs) {}

  async register(args: {
    account: WalletAccount;
    publicKeyHex: string;
    expirationSeconds: number;
  }): Promise<void> {
    let recovered: RecoveredApiKey | null = null;
    try {
      recovered = decryptRecoveryBundle({
        credentialBundle: this.args.credentialBundle,
        ephemeralPrivateKeyHex: this.args.ephemeralPrivateKeyHex,
      });

      const stamper = new ApiKeyStamper({
        apiPublicKey: recovered.publicKeyHex,
        apiPrivateKey: recovered.privateKeyHex,
      });
      const client = new TurnkeyClient(
        { baseUrl: TURNKEY_API_BASE_URL },
        stamper,
      );

      // STAMP_LOGIN on the user's sub-org registers `publicKeyHex` as
      // a Login API key tied to the same user that owns the stamping
      // credential (which Turnkey resolves from the API key id baked
      // into the recovered key). We don't need the returned session
      // JWT -- our stamper holds the private half, that's enough.
      log.info("email-bootstrap.stamp-login.start", {
        accountId: args.account.id,
        organizationId: args.account.organizationId,
      });
      await withTimeout(
        (client as any).stampLogin({
          type: "ACTIVITY_TYPE_STAMP_LOGIN",
          timestampMs: String(Date.now()),
          organizationId: args.account.organizationId,
          parameters: {
            publicKey: args.publicKeyHex,
            expirationSeconds: String(args.expirationSeconds),
          },
        }),
        30_000,
        "stamp-login-timeout",
      );
      log.info("email-bootstrap.stamp-login.complete", {
        accountId: args.account.id,
      });
    } finally {
      // Drop references; the GC reclaims the buffers next pass.
      recovered = null;
      // The caller is also expected to drop `credentialBundle` and
      // `ephemeralPrivateKeyHex` from their state after this returns.
    }
  }
}
