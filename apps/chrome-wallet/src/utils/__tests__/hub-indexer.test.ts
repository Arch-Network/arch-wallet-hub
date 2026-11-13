/**
 * Behavioral tests for `ArchHubIndexerClient`.
 *
 * Two things we explicitly do NOT test here:
 *   1. The wire protocol of the upstream indexer (responsibility of
 *      the Hub-side `IndexerClient`).
 *   2. The auth chain through the Hub (PR #17's tests).
 *
 * What we DO test:
 *   - URL composition: every method targets the right Hub route.
 *   - Header injection: x-api-key, x-network, x-arch-install-id
 *     show up on every request.
 *   - Error mapping: Hub 502 envelopes keep `isIndexerRateLimitError`,
 *     `isIndexerAuthError`, `isIndexerNotFoundError` working
 *     unchanged.
 *   - Auth-failure cooldown: 401 from Hub blocks subsequent calls
 *     for the configured cooldown window.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HubIndexerError } from "../hub-error";
import { ArchHubIndexerClient } from "../hub-indexer";
import {
  isIndexerAuthError,
  isIndexerNotFoundError,
  isIndexerRateLimitError
} from "../indexer";

type CapturedRequest = {
  url: string;
  init?: RequestInit;
};

function mockFetch(handler: (req: CapturedRequest) => Response): {
  fetch: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const f = (async (input: any, init?: any) => {
    const req: CapturedRequest = {
      url: typeof input === "string" ? input : (input as Request).url,
      init
    };
    calls.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Each call returns a fresh client with a UNIQUE hubApiKey. The
 * auth-failure cooldown lives in a module-level Map keyed on
 * (hubBaseUrl, network, hubApiKey); without a unique key per test,
 * a 401 in one test would synchronously block later tests with a
 * stale `IndexerApiKeyRejectedError` (not under test).
 */
let n = 0;
function makeClient(opts: { fetchImpl: typeof fetch }) {
  n += 1;
  return new ArchHubIndexerClient({
    hubBaseUrl: "https://hub.arch.network/",
    hubApiKey: `test-app-key-${n}-${Math.random().toString(36).slice(2)}`,
    installId: "11111111-2222-3333-4444-555555555555",
    network: "testnet",
    fetchImpl: opts.fetchImpl
  });
}

describe("ArchHubIndexerClient — URL composition", () => {
  it("strips trailing slash from hubBaseUrl when building URLs", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({}));
    const c = makeClient({ fetchImpl: f });
    await c.getBtcFeeEstimates();
    expect(calls[0].url).toBe(
      "https://hub.arch.network/v1/indexer/btc/fee-estimates"
    );
  });

  it("routes /accounts requests under /v1/indexer/arch/accounts/...", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({}));
    const c = makeClient({ fetchImpl: f });
    await c.getAccountSummary("acc123");
    expect(calls[0].url).toBe(
      "https://hub.arch.network/v1/indexer/arch/accounts/acc123"
    );
  });

  it("routes BTC requests under /v1/indexer/btc/...", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({}));
    const c = makeClient({ fetchImpl: f });
    await c.getBtcAddressSummary("bc1q...");
    expect(calls[0].url).toBe(
      "https://hub.arch.network/v1/indexer/btc/address/bc1q..."
    );
  });

  it("URL-encodes path params", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({}));
    const c = makeClient({ fetchImpl: f });
    await c.getAccountSummary("addr/with spaces&stuff");
    expect(calls[0].url).toContain(
      encodeURIComponent("addr/with spaces&stuff")
    );
  });

  it("routes legacy rpc through /v1/indexer/arch/rpc", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({ ok: true }));
    const c = makeClient({ fetchImpl: f });
    await c.rpc("read_account_info", ["pubkey"]);
    expect(calls[0].url).toBe(
      "https://hub.arch.network/v1/indexer/arch/rpc"
    );
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body).toEqual({ method: "read_account_info", params: ["pubkey"] });
  });

  it("routes broadcast through POST /v1/indexer/btc/tx with structured body", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({ txid: "abc" }));
    const c = makeClient({ fetchImpl: f });
    const txid = await c.broadcastBtc("01000000...");
    expect(calls[0].url).toBe("https://hub.arch.network/v1/indexer/btc/tx");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      rawTxHex: "01000000..."
    });
    expect(txid).toBe("abc");
  });
});

describe("ArchHubIndexerClient — header injection", () => {
  it("sends x-api-key, x-network, and x-arch-install-id on every call", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({}));
    // Inline-constructed so we control the api key for the assertion.
    const c = new ArchHubIndexerClient({
      hubBaseUrl: "https://hub.arch.network",
      hubApiKey: "header-injection-fixed-key",
      installId: "11111111-2222-3333-4444-555555555555",
      network: "testnet",
      fetchImpl: f
    });
    await c.getBtcFeeEstimates();
    const h = new Headers(calls[0].init?.headers);
    expect(h.get("x-api-key")).toBe("header-injection-fixed-key");
    expect(h.get("x-network")).toBe("testnet");
    expect(h.get("x-arch-install-id")).toBe(
      "11111111-2222-3333-4444-555555555555"
    );
  });

  it("sets content-type only on POSTs (avoids preflight bloat on GETs)", async () => {
    const { fetch: f, calls } = mockFetch(() => jsonRes({ txid: "x" }));
    const c = makeClient({ fetchImpl: f });
    await c.getBtcFeeEstimates();
    await c.broadcastBtc("ff");
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe(null);
    expect(new Headers(calls[1].init?.headers).get("content-type")).toBe(
      "application/json"
    );
  });
});

describe("ArchHubIndexerClient — error mapping", () => {
  it("maps Hub 502 with 'rate limit' upstream message via isIndexerRateLimitError", async () => {
    const { fetch: f } = mockFetch(() =>
      jsonRes(
        {
          statusCode: 502,
          error: "BadGateway",
          message: "Per-second rate limit exceeded for this API key."
        },
        502
      )
    );
    const c = makeClient({ fetchImpl: f });
    try {
      await c.getBtcFeeEstimates();
      throw new Error("expected throw");
    } catch (err) {
      expect(isIndexerRateLimitError(err)).toBe(true);
    }
  });

  it("maps Hub 502 with '429' substring via isIndexerRateLimitError", async () => {
    const { fetch: f } = mockFetch(() =>
      jsonRes({ message: "upstream returned 429 Too Many Requests" }, 502)
    );
    const c = makeClient({ fetchImpl: f });
    try {
      await c.getBtcFeeEstimates();
      throw new Error("expected throw");
    } catch (err) {
      expect(isIndexerRateLimitError(err)).toBe(true);
    }
  });

  it("maps Hub 401 to isIndexerAuthError", async () => {
    const { fetch: f } = mockFetch(() => jsonRes({ message: "no key" }, 401));
    const c = makeClient({ fetchImpl: f });
    try {
      await c.getBtcFeeEstimates();
      throw new Error("expected throw");
    } catch (err) {
      expect(isIndexerAuthError(err)).toBe(true);
    }
  });

  it("maps upstream 'Not found' message via isIndexerNotFoundError", async () => {
    const { fetch: f } = mockFetch(() =>
      jsonRes({ message: "Not found: account does not exist" }, 502)
    );
    const c = makeClient({ fetchImpl: f });
    try {
      await c.getAccountSummary("missing");
      throw new Error("expected throw");
    } catch (err) {
      expect(isIndexerNotFoundError(err)).toBe(true);
    }
  });

  // What the Hub's proxy really sends when the indexer fails: a 502
  // whose message starts with the indexer's status and names its URL.
  function indexerFailure(upstream: string, address: string, requestId = "4b1f6d0e-8a55-4c0e-9c1b-2f7f3a401e29") {
    return new Response(
      JSON.stringify({
        statusCode: 502,
        error: "BadGateway",
        message: `Indexer error ${upstream} (https://explorer.test/api/v1/testnet/accounts/${address}): {"detail":"x"}`,
      }),
      { status: 502, statusText: "Bad Gateway", headers: { "x-request-id": requestId } },
    );
  }

  async function failure(c: ArchHubIndexerClient, address: string): Promise<HubIndexerError> {
    try {
      await c.getAccountSummary(address);
    } catch (err) {
      return err as HubIndexerError;
    }
    throw new Error("expected throw");
  }

  it("throws a HubIndexerError with the Hub's status, the indexer's, and the request id", async () => {
    const { fetch: f } = mockFetch(() => indexerFailure("404 Not Found", "abc"));
    const err = await failure(makeClient({ fetchImpl: f }), "abc");
    expect(err).toBeInstanceOf(HubIndexerError);
    expect(err).toMatchObject({
      name: "HubIndexerError",
      status: 502,
      upstreamStatus: 404,
      requestId: "4b1f6d0e-8a55-4c0e-9c1b-2f7f3a401e29",
      // The text is what it was before the error was typed.
      message:
        'Hub indexer GET /arch/accounts/abc 502 Bad Gateway: Indexer error 404 Not Found (https://explorer.test/api/v1/testnet/accounts/abc): {"detail":"x"}',
    });
    expect(isIndexerNotFoundError(err)).toBe(true);
    expect(isIndexerRateLimitError(err)).toBe(false);
    expect(isIndexerAuthError(err)).toBe(false);
  });

  it("classifies by the indexer's status when its response had no status text", async () => {
    const throttled = mockFetch(() => indexerFailure("429 ", "abc"));
    const rejected = mockFetch(() => indexerFailure("401 ", "abc"));
    expect(isIndexerRateLimitError(await failure(makeClient({ fetchImpl: throttled.fetch }), "abc"))).toBe(true);
    expect(isIndexerAuthError(await failure(makeClient({ fetchImpl: rejected.fetch }), "abc"))).toBe(true);
  });

  it("is not misled by a status that only appears inside an address", async () => {
    // Bech32 addresses hold digits; this one spells all three statuses.
    const address = "tb1q429w401x404d8h0k5e9u3n7m2c6v4z0y8s5r3j";
    const { fetch: f } = mockFetch(() => indexerFailure("500 Internal Server Error", address));
    const err = await failure(makeClient({ fetchImpl: f }), address);

    expect(err.message).toContain(address);
    expect(isIndexerRateLimitError(err)).toBe(false);
    expect(isIndexerAuthError(err)).toBe(false);
    expect(isIndexerNotFoundError(err)).toBe(false);

    // The same text without the fields can only be searched, and is misread.
    const asText = new Error(err.message);
    expect(isIndexerRateLimitError(asText)).toBe(true);
    expect(isIndexerAuthError(asText)).toBe(true);
    expect(isIndexerNotFoundError(asText)).toBe(true);
  });

  it("falls back to raw body text when 502 envelope has no message field", async () => {
    const { fetch: f } = mockFetch(
      () => new Response("plain text error", { status: 502 })
    );
    const c = makeClient({ fetchImpl: f });
    try {
      await c.getBtcFeeEstimates();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("plain text error");
    }
  });
});

describe("ArchHubIndexerClient — auth-failure cooldown", () => {
  beforeEach(() => {
    // The cooldown map is module-level. Force a fresh state by
    // using a unique hubApiKey per test (the cache is keyed on it).
  });

  it("a 401 blocks subsequent calls for the cooldown window", async () => {
    let n = 0;
    const { fetch: f } = mockFetch(() => {
      n += 1;
      if (n === 1) return jsonRes({ message: "no key" }, 401);
      return jsonRes({ fastestFee: 1 });
    });
    const c = new ArchHubIndexerClient({
      hubBaseUrl: "https://hub.arch.network",
      hubApiKey: `cooldown-test-key-${Math.random()}`,
      installId: "11111111-2222-3333-4444-555555555555",
      network: "testnet",
      fetchImpl: f
    });
    // First call: 401 → records auth failure.
    await expect(c.getBtcFeeEstimates()).rejects.toThrow();
    // Second call: blocked synchronously by assertAuthAvailable; the
    // fetch counter should still be 1.
    await expect(c.getBtcFeeEstimates()).rejects.toThrow(
      /API key/
    );
    expect(n).toBe(1);
  });
});
