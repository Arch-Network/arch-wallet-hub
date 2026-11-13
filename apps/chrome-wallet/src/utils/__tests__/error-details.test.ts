import { describe, expect, it, vi } from "vitest";

// Only the pure helpers are under test; the store is read by
// `collectErrorDetails`, which error-banner.test.ts covers.
vi.mock("../../state/wallet-store", () => ({ walletStore: {} }));

import {
  formatErrorDetails,
  formatErrorDetailsToFit,
  maskIdentifiers,
  pageContext,
  pageLabel,
  type ErrorDetails,
  type ReportLogEntry,
} from "../error-details";

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

describe("pageContext", () => {
  it("is the page's file without its extension", () => {
    expect(pageContext({ pathname: "/popup.html" })).toBe("popup");
    expect(pageContext({ pathname: "/sidepanel.html" })).toBe("sidepanel");
    expect(pageContext({ pathname: "/" })).toBe("page");
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

  it("appends the recent log, oldest first, saying which context wrote each line", () => {
    const text = formatErrorDetails({
      ...base,
      logs: [
        {
          ts: Date.parse("2026-11-13T11:59:58.000Z"),
          level: "warn",
          msg: "hub request failed",
          extra: { status: 503 },
          context: "popup",
        },
        { ts: Date.parse("2026-11-13T11:59:59.000Z"), level: "error", msg: "uncaught error", context: "background" },
      ],
    });
    expect(text.split("\n").slice(-3)).toEqual([
      "Recent log (2):",
      '[2026-11-13T11:59:58.000Z] popup WARN hub request failed {"status":503}',
      "[2026-11-13T11:59:59.000Z] background ERROR uncaught error",
    ]);
  });

  it("names the Hub request the error came from, when there is one", () => {
    const requestId = "4b1f6d0e-8a55-4c0e-9c1b-2f7f3a401e29";
    expect(formatErrorDetails({ ...base, requestId }).split("\n").slice(1, 3)).toEqual([
      "Error: Wallet Hub error 503",
      `Hub request: ${requestId}`,
    ]);
    expect(formatErrorDetails(base)).not.toContain("Hub request:");
  });

  it("masks an address and a txid quoted in the error or in a log line", () => {
    const address = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const txid = "ab".repeat(32);
    const text = formatErrorDetails({
      ...base,
      message: `Hub indexer GET /arch/accounts/${address} 502 Bad Gateway: boom`,
      logs: [{ ts: 0, level: "error", msg: "uncaught error", extra: { message: `tx ${txid} failed` }, context: "popup" }],
    });
    expect(text).toContain("Error: Hub indexer GET /arch/accounts/[address] 502 Bad Gateway: boom");
    expect(text).toContain('{"message":"tx [hex] failed"}');
    expect(text).not.toContain(address);
    expect(text).not.toContain(txid);
  });
});

describe("maskIdentifiers", () => {
  it("masks Bitcoin and Arch addresses, txids, inscription ids and emails", () => {
    expect(maskIdentifiers("to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq now")).toBe("to [address] now");
    expect(maskIdentifiers("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr")).toBe("[address]");
    expect(maskIdentifiers("legacy 1BoatSLRHtKNngkdXEeobR76b53LETtpyT")).toBe("legacy [id]");
    expect(maskIdentifiers("arch 7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK")).toBe("arch [id]");
    expect(maskIdentifiers(`tx ${"0f".repeat(32)}`)).toBe("tx [hex]");
    expect(maskIdentifiers(`inscription ${"0f".repeat(32)}i0`)).toBe("inscription [hex]i0");
    expect(maskIdentifiers("No wallet for satoshi@example.com.")).toBe("No wallet for [email].");
  });

  it("leaves a request id, a version, a time and a browser alone", () => {
    const kept = [
      "Hub request: 4b1f6d0e-8a55-4c0e-9c1b-2f7f3a401e29",
      "Version: 0.9.13",
      "Time: 2026-11-13T12:00:00.000Z",
      "Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
      '[2026-11-13T11:59:58.000Z] popup WARN Hub request failed {"status":502,"route":"/v1/indexer/arch/accounts/:id"}',
      "IndexerApiKeyRejectedError: Indexer rejected the API key. Update it in Settings > Indexer API.",
    ].join("\n");
    expect(maskIdentifiers(kept)).toBe(kept);
  });
});

describe("formatErrorDetailsToFit", () => {
  const encodedBytes = (text: string) => new TextEncoder().encode(JSON.stringify(text)).length;
  const entry = (i: number): ReportLogEntry => ({
    ts: Date.parse("2026-11-13T11:00:00.000Z") + i * 1000,
    level: "warn",
    msg: `entry ${i} says "quoted"`,
    context: "popup",
  });
  const logs = Array.from({ length: 200 }, (_, i) => entry(i));

  it("is the whole report when it fits", () => {
    const details = { ...base, logs: logs.slice(0, 3) };
    expect(formatErrorDetailsToFit(details, 12_000)).toBe(formatErrorDetails(details));
  });

  it("leaves out the oldest log entries, and says how many, until it fits", () => {
    const text = formatErrorDetailsToFit({ ...base, logs }, 12_000);
    expect(encodedBytes(text)).toBeLessThanOrEqual(12_000);

    const lines = text.split("\n");
    const heading = lines.find((line) => line.startsWith("Recent log"))!;
    const kept = lines.filter((line) => line.includes(" popup WARN entry "));
    expect(heading).toBe(`Recent log (latest ${kept.length}, ${200 - kept.length} older left out):`);
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.at(-1)).toContain('entry 199 says "quoted"');
    expect(lines.slice(0, 2)).toEqual(["Arch Wallet error report", "Error: Wallet Hub error 503"]);
    // One more entry would not have fit.
    const oneMore = formatErrorDetails({ ...base, logs: logs.slice(200 - kept.length - 1) }, 200 - kept.length - 1);
    expect(encodedBytes(oneMore)).toBeGreaterThan(12_000);
  });

  it("cuts an error message too long to fit on its own", () => {
    const text = formatErrorDetailsToFit({ ...base, message: "boom ".repeat(5_000), logs }, 12_000);
    expect(encodedBytes(text)).toBeLessThanOrEqual(12_000);
    expect(text.startsWith("Arch Wallet error report\nError: boom boom")).toBe(true);
  });
});
