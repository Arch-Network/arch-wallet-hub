import { describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Wallet Hub error classifiers in `utils/sdk.ts`.
 *
 * These lock the fix for the field bug where session-mint 401s (and any
 * error whose text merely contained the substring "401") were labelled
 * "Wallet Hub rejected the API key" -- sending users into Settings to
 * "fix" an API key that was never broken, and triggering an unnecessary
 * `resetHubConfigToDefaults()` in the Send flow. The real remedy for
 * those errors is re-establishing the signing session (what a manual
 * lock/unlock does), so they must classify as SESSION errors.
 */

// sdk.ts pulls in the wallet store (chrome.storage-backed) and the
// indexer at module level; neither is exercised by the classifier
// functions, so stub them out to keep this test hermetic.
vi.mock("../../state/wallet-store", () => ({
  walletStore: {},
}));
vi.mock("../indexer", () => ({
  invalidateIndexerCache: vi.fn(),
}));
vi.mock("../hub-session-store", () => ({
  readHubToken: vi.fn(),
}));

import {
  formatWalletHubError,
  isWalletHubAuthError,
  isWalletHubSessionError,
  walletHubErrorStatus,
} from "../sdk";

const SESSION_MESSAGE_SNIPPET = "Re-unlock your wallet";
const API_KEY_MESSAGE_SNIPPET = "rejected the API key";

describe("session-mint 401s classify as session errors, not API-key errors", () => {
  const turnkeyMint = new Error(
    "WalletHub error 401 Unauthorized: InvalidSignature: Challenge signature did not verify against any Turnkey resource for this user.",
  );
  const externalMint = new Error(
    "WalletHub error 401 Unauthorized: InvalidSignature: BIP-322 signature did not verify against the linked wallet for this user.",
  );

  it("Turnkey mint rejection is a session error", () => {
    expect(isWalletHubSessionError(turnkeyMint)).toBe(true);
    expect(isWalletHubAuthError(turnkeyMint)).toBe(false);
    expect(formatWalletHubError(turnkeyMint)).toContain(SESSION_MESSAGE_SNIPPET);
  });

  it("external (BIP-322) mint rejection is a session error", () => {
    expect(isWalletHubSessionError(externalMint)).toBe(true);
    expect(isWalletHubAuthError(externalMint)).toBe(false);
    expect(formatWalletHubError(externalMint)).toContain(SESSION_MESSAGE_SNIPPET);
  });
});

describe("sessionAuth plugin 401s stay session errors (regression)", () => {
  it.each([
    "WalletHub error 401 Unauthorized: Unauthorized: Missing or malformed session bearer",
    "WalletHub error 401 Unauthorized: Unauthorized: Invalid or expired session token",
  ])("%s", (message) => {
    const err = new Error(message);
    expect(isWalletHubSessionError(err)).toBe(true);
    expect(isWalletHubAuthError(err)).toBe(false);
    expect(formatWalletHubError(err)).toContain(SESSION_MESSAGE_SNIPPET);
  });
});

describe("genuine app-API-key 401s still classify as auth errors", () => {
  it.each([
    "WalletHub error 401 Unauthorized: Unauthorized: Invalid API key",
    "WalletHub error 401 Unauthorized: Unauthorized: API key revoked",
    "WalletHub error 401 Unauthorized: Unauthorized: App disabled",
    "WalletHub error 401 Unauthorized: Unauthorized: Missing API key (send X-API-Key or Authorization: Bearer)",
  ])("%s", (message) => {
    const err = new Error(message);
    expect(isWalletHubAuthError(err)).toBe(true);
    expect(isWalletHubSessionError(err)).toBe(false);
    expect(formatWalletHubError(err)).toContain(API_KEY_MESSAGE_SNIPPET);
  });

  it("matches 'invalid api key' even without a parseable WalletHub status", () => {
    // e.g. the Hub-routed indexer client formats its own error string.
    const err = new Error(
      'Indexer POST /v1/bitcoin/broadcast 401 Unauthorized: {"message":"Invalid API key"}',
    );
    expect(isWalletHubAuthError(err)).toBe(true);
  });
});

describe("no more false positives from stray '401' substrings", () => {
  it("an amount containing '401' is not an auth error", () => {
    const err = new Error("Insufficient funds: 240100 sats required, 5000 available");
    expect(isWalletHubAuthError(err)).toBe(false);
    expect(isWalletHubSessionError(err)).toBe(false);
    expect(formatWalletHubError(err)).toBe(
      "Insufficient funds: 240100 sats required, 5000 available",
    );
  });

  it("a non-WalletHub 401 without an API-key body is not an auth error", () => {
    const err = new Error("Indexer GET /v1/blocks 401 Unauthorized: nope");
    expect(isWalletHubAuthError(err)).toBe(false);
  });

  it("a bare unknown-body WalletHub 401 is neither bucket (falls through to raw message)", () => {
    const err = new Error("WalletHub error 401 Unauthorized: something novel");
    expect(isWalletHubAuthError(err)).toBe(false);
    expect(isWalletHubSessionError(err)).toBe(false);
    expect(formatWalletHubError(err)).toBe(
      "WalletHub error 401 Unauthorized: something novel",
    );
  });

  it("a 403 principal mismatch is neither bucket", () => {
    const err = new Error(
      "WalletHub error 403 Forbidden: Forbidden: Body/query externalUserId does not match session principal",
    );
    expect(isWalletHubAuthError(err)).toBe(false);
    expect(isWalletHubSessionError(err)).toBe(false);
  });
});

describe("walletHubErrorStatus", () => {
  it("parses the SDK error format and ignores other numbers", () => {
    expect(walletHubErrorStatus(new Error("WalletHub error 401 Unauthorized: x"))).toBe(401);
    expect(walletHubErrorStatus(new Error("need 240100 sats"))).toBeNull();
    expect(walletHubErrorStatus(new Error("Indexer GET /x 401 Unauthorized"))).toBeNull();
  });
});
