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

import { WalletHubError } from "@arch-network/wallet-hub-sdk";
import {
  formatWalletHubError,
  isWalletHubAuthError,
  isWalletHubSessionError,
  isWalletHubUnknownResourceError,
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

describe("a WalletHubError is classified by its status field, not its text", () => {
  it("reads the status from the field", () => {
    expect(walletHubErrorStatus(new WalletHubError("Unknown resourceId", 404, undefined))).toBe(404);
    expect(walletHubErrorStatus(new WalletHubError("WalletHub error 401 Unauthorized: x", 500, undefined))).toBe(500);
  });

  it("is an unknown-resource error only when the status is 404", () => {
    const unknown = new WalletHubError("WalletHub error 404 Not Found: Not Found: Unknown resourceId", 404, "req-1");
    // A 400 about a wallet whose address happens to hold "404".
    const text = "WalletHub error 400 Bad Request: Bad Request: Unknown resourceId for tb1q404d8h0k5e9u3n7m2c6v4z0y8s5r3j";
    expect(isWalletHubUnknownResourceError(unknown)).toBe(true);
    expect(isWalletHubUnknownResourceError(new WalletHubError(text, 400, "req-2"))).toBe(false);
    // Without the field the text is all there is, and it is misread.
    expect(isWalletHubUnknownResourceError(new Error(text))).toBe(true);
  });

  it("keeps the session and API-key classification for typed errors", () => {
    const session = new WalletHubError("WalletHub error 401 Unauthorized: Unauthorized: Expired session token", 401, "r");
    const appKey = new WalletHubError("WalletHub error 401 Unauthorized: Unauthorized: Missing API key", 401, "r");
    expect(isWalletHubSessionError(session)).toBe(true);
    expect(isWalletHubAuthError(session)).toBe(false);
    expect(isWalletHubAuthError(appKey)).toBe(true);
  });
});

describe("the Hub's request id stays findable when its wording is replaced", () => {
  it("ties the canned text to the failed request", async () => {
    const { hubRequestIdFor } = await import("../hub-error");
    const err = new WalletHubError('WalletHub error 404 Not Found: NotFound: Unknown resourceId', 404, "req-404");
    const shown = formatWalletHubError(err);
    expect(shown).toMatch(/^Wallet Hub does not recognize this wallet yet/);
    expect(hubRequestIdFor(shown)).toBe("req-404");
  });
});
