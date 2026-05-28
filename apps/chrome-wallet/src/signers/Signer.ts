/**
 * Signer -- the unified interface every wallet uses to talk to
 * Turnkey.
 *
 * History: pre-refactor there were two implementations, one for
 * passkey wallets (per-tx WebAuthn) and one for parent-org custodial
 * wallets where the Hub held the signing key. Both are gone: every
 * wallet now lives in its own sub-org, and signing happens locally
 * via an IndexedDB-stamped session whose pubkey is registered with
 * Turnkey for a bounded TTL at unlock-time.
 *
 * Post-refactor the only Signer is `SessionStampedSigner`. It
 * picks up whatever TurnkeyClient `sessionManager` currently has
 * open for the active account and signs by stamping activities with
 * the unextractable IndexedDB key on this device. The Hub holds no
 * signing material for any wallet, period.
 *
 * Auth method (passkey vs email) controls *how the session was
 * opened*, not how it signs. By the time any method on this signer
 * runs, the session is already open; if it isn't, we throw and the
 * caller redirects to unlock. We deliberately don't try to re-open
 * a session from inside the signer -- bootstrapping a passkey
 * session requires a fresh user gesture (WebAuthn), and an email
 * session requires the user to type an OTP. Hiding either of those
 * behind a "sign this transaction please" call would be a bad UX.
 */

import {
  assertActivityCompleted,
  getSignatureFromActivity,
  getSignedTransactionFromActivity,
  type TurnkeyClient,
} from "@turnkey/http";
import { bytesToHex, computeBip322ToSignTaprootSighash } from "../utils/bip322";
import { isExternalAccount, isWatchAccount, type WalletAccount } from "../state/types";
import { sessionManager } from "../session/SessionManager";

export interface SignArchOptions {
  /**
   * Identifier of the server-side signing request this payload is
   * for. Retained as an opaque correlator the caller may use to tie
   * the resulting signature back to a Hub-side request; the signer
   * itself does nothing with it.
   */
  signingRequestId: string;
  /** Hex of the payload bytes to sign (no hashing applied). */
  payloadHex?: string;
}

export interface SignArchResult {
  /** 64-byte (r||s) hex signature. */
  signature64Hex: string;
}

export interface SignPsbtOptions {
  psbtHex: string;
}

export interface SignPsbtResult {
  signedPsbtHex: string;
}

/**
 * Sign an arbitrary Arch SanitizedMessage hash.
 *
 * What gets BIP-322'd is the **hex string** form of the hash (its
 * UTF-8 bytes), not the 32 raw bytes the hex represents. That's the
 * convention `@saturnbtcio/arch-sdk` and the on-chain Arch validator
 * agree on: `SanitizedMessageUtil.hash` itself returns
 * `TextEncoder().encode(hex.encode(finalHash))` -- i.e. the 64-char
 * lowercase hex string as UTF-8 bytes -- and `bip322-js`'s
 * `Signer.sign(wif, taprootAddress, hexString)` is what dapps use to
 * produce a signature the validator accepts. Wrapping the **raw 32
 * bytes** instead (which is what we used to do here) produced a
 * different sighash and signatures that Arch rejected at submit
 * time with "error checking transaction sigs".
 *
 * The signer wraps that hex-string-as-bytes into the BIP-322 to-sign
 * taproot sighash for the account's BTC address and Schnorr-signs
 * that digest -- returning a 64-byte (r||s) signature Arch (and any
 * stock BIP-322 verifier) accepts.
 */
export interface SignArchMessageHashOptions {
  /** 64-char lowercase hex of the SanitizedMessageUtil.hash output. */
  messageHashHex: string;
}

export interface Signer {
  kind: "session-stamped";
  account: WalletAccount;
  signArchPayload(opts: SignArchOptions): Promise<SignArchResult>;
  signArchMessageHash(opts: SignArchMessageHashOptions): Promise<SignArchResult>;
  signPsbt(opts: SignPsbtOptions): Promise<SignPsbtResult>;
}

function archMessageHashToSighashHex(
  account: WalletAccount,
  messageHashHex: string,
): string {
  // Pass the hex *string* (not the parsed 32 raw bytes) so
  // `computeBip322ToSignTaprootSighash` UTF-8-encodes it via
  // bip322-js's internal `Buffer.from(message)`. That matches what
  // dapps produce when they call `bip322-js`'s `Signer.sign(wif, addr,
  // hexString)` on the local-wallet path, which in turn is what Arch
  // validators verify against. See the SignArchMessageHashOptions
  // docstring above for the full why.
  const sighash = computeBip322ToSignTaprootSighash({
    signerAddress: account.btcAddress,
    message: messageHashHex,
  });
  return bytesToHex(sighash);
}

class SessionLockedError extends Error {
  constructor(accountId: string) {
    super(
      `No active Turnkey session for account ${accountId}. Unlock the wallet to open one.`,
    );
    this.name = "SessionLockedError";
  }
}

export class SessionStampedSigner implements Signer {
  readonly kind = "session-stamped" as const;

  constructor(public account: WalletAccount) {}

  /**
   * Resolve a TurnkeyClient for this account, rehydrating from
   * `chrome.storage.session` + IndexedDB when our current document
   * didn't open the session itself (e.g. the dapp-triggered Approve
   * popup, which is a fresh JS realm relative to the main popup
   * where the user unlocked the wallet). Throws `SessionLockedError`
   * only when *no* document has an open session.
   */
  private async client(): Promise<TurnkeyClient> {
    const c = await sessionManager.ensureClient(this.account.id);
    if (!c) throw new SessionLockedError(this.account.id);
    return c;
  }

  async signArchPayload(opts: SignArchOptions): Promise<SignArchResult> {
    if (!opts.payloadHex) {
      throw new Error("SessionStampedSigner requires payloadHex");
    }
    const res = await (await this.client()).signRawPayload({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      timestampMs: String(Date.now()),
      organizationId: this.account.organizationId,
      parameters: {
        signWith: this.account.btcAddress,
        payload: opts.payloadHex,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP",
      },
    });
    assertActivityCompleted(res.activity);
    const sig = getSignatureFromActivity(res.activity);
    return { signature64Hex: `${sig.r}${sig.s}` };
  }

  async signArchMessageHash(
    opts: SignArchMessageHashOptions,
  ): Promise<SignArchResult> {
    const payloadHex = archMessageHashToSighashHex(
      this.account,
      opts.messageHashHex,
    );
    return this.signArchPayload({ signingRequestId: "", payloadHex });
  }

  async signPsbt(opts: SignPsbtOptions): Promise<SignPsbtResult> {
    const res = await (await this.client()).signTransaction({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      timestampMs: String(Date.now()),
      organizationId: this.account.organizationId,
      parameters: {
        signWith: this.account.btcAddress,
        unsignedTransaction: opts.psbtHex,
        type: "TRANSACTION_TYPE_BITCOIN",
      },
    });
    assertActivityCompleted(res.activity);
    const signedTransaction = getSignedTransactionFromActivity(res.activity);
    return { signedPsbtHex: signedTransaction };
  }
}

export class WatchOnlyAccountError extends Error {
  constructor(public readonly account: WalletAccount) {
    super(
      `Watch-only account "${account.label}" cannot sign. Import a signing wallet first.`,
    );
    this.name = "WatchOnlyAccountError";
  }
}

export function signerForAccount(account: WalletAccount): Signer {
  if (isWatchAccount(account)) {
    // Refuse before we even instantiate a session-stamped signer. The
    // wallet UI gates the action paths so we don't expect to land here
    // in practice; throwing rather than returning a null signer keeps
    // the call sites' types tight (Signer | never thrown vs. nullable).
    throw new WatchOnlyAccountError(account);
  }
  if (isExternalAccount(account)) {
    throw new Error("External wallets must sign in their source wallet");
  }
  return new SessionStampedSigner(account);
}

/**
 * Stub left as a contract-validating placeholder until a real
 * ledger integration ships.
 */
export class LedgerSigner implements Signer {
  readonly kind = "session-stamped" as const;
  constructor(public account: WalletAccount) {}
  async signArchPayload(): Promise<SignArchResult> {
    throw new Error("Ledger signing is not yet supported");
  }
  async signArchMessageHash(): Promise<SignArchResult> {
    throw new Error("Ledger signing is not yet supported");
  }
  async signPsbt(): Promise<SignPsbtResult> {
    throw new Error("Ledger signing is not yet supported");
  }
}
