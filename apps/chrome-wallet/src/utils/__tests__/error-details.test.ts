import { describe, expect, it, vi } from "vitest";

// Only the pure helpers are under test; the store is read by
// `collectErrorDetails`, which error-banner.test.ts covers.
vi.mock("../../state/wallet-store", () => ({ walletStore: {} }));

import { formatErrorDetails, pageLabel, type ErrorDetails } from "../error-details";

const base: ErrorDetails = {
  message: "Wallet Hub error 503",
  version: "0.9.12",
  time: new Date("2026-11-13T12:00:00.000Z"),
  page: "popup.html#/send",
  wallet: { network: "testnet4", signer: "Passkey" },
  userAgent: "Mozilla/5.0 Chrome/142",
  logs: [],
};

describe("pageLabel", () => {
  it("names the extension page and the screen", () => {
    expect(pageLabel({ pathname: "/popup.html", hash: "#/dashboard" })).toBe("popup.html#/dashboard");
  });

  it("drops the query, which carries recipients and amounts", () => {
    expect(pageLabel({ pathname: "/popup.html", hash: "#/send?asset=btc&to=tb1pabc&amount=5" })).toBe(
      "popup.html#/send",
    );
  });

  it("drops route segments after the first, which name the asset", () => {
    expect(pageLabel({ pathname: "/sidepanel.html", hash: "#/send-inscription/abc123i0" })).toBe(
      "sidepanel.html#/send-inscription",
    );
  });

  it("is just the page when no screen is open", () => {
    expect(pageLabel({ pathname: "/popup.html", hash: "" })).toBe("popup.html");
  });
});

describe("formatErrorDetails", () => {
  it("leads with the error and what build and screen it happened on", () => {
    expect(formatErrorDetails(base).split("\n")).toEqual([
      "Arch Wallet error report",
      "Error: Wallet Hub error 503",
      "Version: 0.9.12",
      "Time: 2026-11-13T12:00:00.000Z",
      "Page: popup.html#/send",
      "Wallet: testnet4, Passkey",
      "Browser: Mozilla/5.0 Chrome/142",
      "",
      "Recent log: (empty)",
    ]);
  });

  it("says when the wallet is locked or its state could not be read", () => {
    expect(formatErrorDetails({ ...base, wallet: "locked" })).toContain("Wallet: locked");
    expect(formatErrorDetails({ ...base, wallet: undefined })).toContain("Wallet: unknown");
  });

  it("appends the recent log, oldest first", () => {
    const text = formatErrorDetails({
      ...base,
      logs: [
        { ts: Date.parse("2026-11-13T11:59:58.000Z"), level: "warn", msg: "hub request failed", extra: { status: 503 } },
        { ts: Date.parse("2026-11-13T11:59:59.000Z"), level: "error", msg: "uncaught error" },
      ],
    });
    expect(text.split("\n").slice(-3)).toEqual([
      "Recent log (2):",
      '[2026-11-13T11:59:58.000Z] WARN hub request failed {"status":503}',
      "[2026-11-13T11:59:59.000Z] ERROR uncaught error",
    ]);
  });
});
