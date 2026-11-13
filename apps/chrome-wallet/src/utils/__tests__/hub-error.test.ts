import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HubErrorModule = typeof import("../hub-error");
let hubError: HubErrorModule;

beforeEach(async () => {
  // The recent-failure list is module state; a fresh module per test keeps it isolated.
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  hubError = await import("../hub-error");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hubErrorBodyMessage", () => {
  it("takes the message out of the Hub's JSON envelope", () => {
    const body = JSON.stringify({ statusCode: 404, error: "Not Found", message: "Unknown resourceId" });
    expect(hubError.hubErrorBodyMessage(body)).toBe("Unknown resourceId");
  });

  it("keeps a body that is not that envelope as it is", () => {
    expect(hubError.hubErrorBodyMessage("plain text error")).toBe("plain text error");
    expect(hubError.hubErrorBodyMessage('{"error":"nope"}')).toBe('{"error":"nope"}');
    expect(hubError.hubErrorBodyMessage("")).toBe("");
  });
});

describe("upstreamStatusOf", () => {
  it("reads the indexer's status from the start of the Hub's message", () => {
    expect(
      hubError.upstreamStatusOf("Indexer error 404 Not Found (https://indexer.test/accounts/abc): missing"),
    ).toBe(404);
    // An upstream answering over HTTP/2 has no status text.
    expect(hubError.upstreamStatusOf("Indexer error 429  (https://indexer.test/x): ")).toBe(429);
  });

  it("reads nothing from the url or body after it, or from any other message", () => {
    expect(
      hubError.upstreamStatusOf("Indexer request timeout after 8000ms: https://indexer.test/accounts/tb1q404429"),
    ).toBeUndefined();
    expect(hubError.upstreamStatusOf("upstream said: Indexer error 404 Not Found")).toBeUndefined();
    expect(hubError.upstreamStatusOf("Indexer error 4040 (x)")).toBeUndefined();
    expect(hubError.upstreamStatusOf("")).toBeUndefined();
  });
});

describe("hubRequestIdFor", () => {
  it("finds the request behind a message that contains the Hub's", () => {
    hubError.rememberHubFailure({ requestId: "req-1", bodyMessage: "Unknown resourceId" });
    expect(hubError.hubRequestIdFor("WalletHub error 404 Not Found: Not Found: Unknown resourceId")).toBe("req-1");
    expect(hubError.hubRequestIdFor("Couldn't load: Unknown resourceId")).toBe("req-1");
  });

  it("gives none to a message that does not contain it", () => {
    hubError.rememberHubFailure({ requestId: "req-1", bodyMessage: "Unknown resourceId" });
    expect(hubError.hubRequestIdFor("Incorrect password")).toBeUndefined();
    expect(hubError.hubRequestIdFor("Couldn't load your balances. Try again in a moment.")).toBeUndefined();
  });

  it("does not keep a failure that had no message to match on", () => {
    hubError.rememberHubFailure({ requestId: "req-1", bodyMessage: "" });
    expect(hubError.hubRequestIdFor("WalletHub error 500 : ")).toBeUndefined();
    expect(hubError.hubRequestIdFor("")).toBeUndefined();
  });

  it("prefers the latest of two failures with the same message", () => {
    hubError.rememberHubFailure({ requestId: "req-1", bodyMessage: "database is down" });
    hubError.rememberHubFailure({ requestId: "req-2", bodyMessage: "database is down" });
    expect(hubError.hubRequestIdFor("database is down")).toBe("req-2");
  });

  it("matches a long plain-text body on the part the SDK keeps", () => {
    const body = "x".repeat(500);
    hubError.rememberHubFailure({ requestId: "req-1", bodyMessage: body });
    expect(hubError.hubRequestIdFor(`WalletHub error 502 Bad Gateway: ${body.slice(0, 240)}...`)).toBe("req-1");
  });

  it("forgets a failure after two minutes", () => {
    hubError.rememberHubFailure({ requestId: "req-1", bodyMessage: "database is down" });
    vi.setSystemTime(1_000_000 + 2 * 60_000);
    expect(hubError.hubRequestIdFor("database is down")).toBe("req-1");
    vi.setSystemTime(1_000_000 + 2 * 60_000 + 1);
    expect(hubError.hubRequestIdFor("database is down")).toBeUndefined();
  });

  it("keeps only the 20 latest failures", () => {
    for (let i = 0; i <= 20; i++) hubError.rememberHubFailure({ requestId: `req-${i}`, bodyMessage: `failure #${i}.` });
    expect(hubError.hubRequestIdFor("failure #0.")).toBeUndefined();
    expect(hubError.hubRequestIdFor("failure #1.")).toBe("req-1");
    expect(hubError.hubRequestIdFor("failure #20.")).toBe("req-20");
  });
});

describe("rememberShownError", () => {
  const failed = (requestId?: string) =>
    new hubError.HubIndexerError("Hub indexer GET /btc/address/x 502 : boom", { status: 502, requestId });

  it("ties a screen's own wording to the request id of the error behind it", () => {
    hubError.rememberShownError("Couldn't load your balances.", failed("req-1"));
    expect(hubError.hubRequestIdFor("Couldn't load your balances.")).toBe("req-1");
  });

  it("takes the first error that has a request id", () => {
    hubError.rememberShownError("Couldn't load your balances.", null, new Error("timed out"), failed(), failed("req-2"));
    expect(hubError.hubRequestIdFor("Couldn't load your balances.")).toBe("req-2");
  });

  it("ties nothing when no error came from a Hub response", () => {
    hubError.rememberShownError("Couldn't load your balances.", new Error("Failed to fetch"), "text", undefined);
    expect(hubError.hubRequestIdFor("Couldn't load your balances.")).toBeUndefined();
  });
});
