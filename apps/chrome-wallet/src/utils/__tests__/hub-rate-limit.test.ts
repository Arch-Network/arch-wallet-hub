import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RateLimitModule = typeof import("../hub-rate-limit");
type HubIndexerModule = typeof import("../hub-indexer");

let rl: RateLimitModule;
let ArchHubIndexerClient: HubIndexerModule["ArchHubIndexerClient"];
let isIndexerRateLimitError: typeof import("../indexer")["isIndexerRateLimitError"];

const HUB = "https://hub.arch.network";

function tooMany(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      statusCode: 429,
      error: "TooManyRequests",
      message: "Rate limit exceeded, retry in 1 minute",
    }),
    { status: 429, headers: { "content-type": "application/json", ...headers } },
  );
}

function ok(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** A fetch that answers from `queue` in order and counts calls. */
function scriptedFetch(queue: Array<() => Response>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("unexpected network call");
    return next();
  }) as typeof fetch;
  return { f, calls };
}

function indexerClient(fetchImpl: typeof fetch) {
  return new ArchHubIndexerClient({
    hubBaseUrl: HUB,
    hubApiKey: "test-app-key",
    installId: "11111111-2222-3333-4444-555555555555",
    network: "testnet",
    fetchImpl,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

beforeEach(async () => {
  // Cooldowns are module state; a fresh module per test keeps them isolated.
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0);
  rl = await import("../hub-rate-limit");
  ({ ArchHubIndexerClient } = await import("../hub-indexer"));
  ({ isIndexerRateLimitError } = await import("../indexer"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseRetryAfterMs", () => {
  it("reads retry-after as seconds", () => {
    expect(rl.parseRetryAfterMs(new Headers({ "retry-after": "42" }))).toBe(42_000);
  });

  it("falls back to x-ratelimit-reset, which the Hub also sends as seconds", () => {
    expect(rl.parseRetryAfterMs(new Headers({ "x-ratelimit-reset": "17" }))).toBe(17_000);
  });

  it("prefers retry-after when both are present", () => {
    const headers = new Headers({ "retry-after": "3", "x-ratelimit-reset": "50" });
    expect(rl.parseRetryAfterMs(headers)).toBe(3_000);
  });

  it("skips values that are not a number of seconds", () => {
    const headers = new Headers({
      "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT",
      "x-ratelimit-reset": "9",
    });
    expect(rl.parseRetryAfterMs(headers)).toBe(9_000);
    expect(rl.parseRetryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull();
    expect(rl.parseRetryAfterMs(new Headers())).toBeNull();
  });
});

describe("cooldownMs", () => {
  const noJitter = () => 0;

  it("doubles per consecutive 429 from 5s and caps at 60s", () => {
    const waits = [1, 2, 3, 4, 5, 6, 10].map((n) => rl.cooldownMs(n, null, noJitter));
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it("never waits less than the Hub asked, short of the cap", () => {
    expect(rl.cooldownMs(1, 30_000, noJitter)).toBe(30_000);
    expect(rl.cooldownMs(1, 120_000, noJitter)).toBe(60_000);
  });

  it("adds up to 25% jitter, still within the cap", () => {
    expect(rl.cooldownMs(1, null, () => 1)).toBe(6_250);
    expect(rl.cooldownMs(1, 30_000, () => 0.5)).toBe(33_750);
    expect(rl.cooldownMs(4, null, () => 1)).toBe(50_000);
    expect(rl.cooldownMs(5, null, () => 1)).toBe(60_000);
  });
});

describe("Hub 429 through the indexer client", () => {
  it("throws a typed rate-limit error carrying the Hub's delay", async () => {
    const { f } = scriptedFetch([() => tooMany({ "retry-after": "12", "x-ratelimit-remaining": "0" })]);
    const err = await rejection(indexerClient(f).getAccountTokens("addr"));

    expect(err).toBeInstanceOf(rl.HubRateLimitError);
    expect((err as InstanceType<RateLimitModule["HubRateLimitError"]>).retryAfterMs).toBe(12_000);
    expect(isIndexerRateLimitError(err)).toBe(true);
  });

  it("fails fast without a network call while the cooldown runs", async () => {
    const { f, calls } = scriptedFetch([() => tooMany({ "retry-after": "12" }), () => ok({ tokens: [] })]);
    const client = indexerClient(f);
    await rejection(client.getAccountTokens("addr"));

    vi.setSystemTime(1_000_000 + 4_000);
    const err = await rejection(client.getAccountSummary("addr"));
    expect(err).toBeInstanceOf(rl.HubRateLimitError);
    expect((err as InstanceType<RateLimitModule["HubRateLimitError"]>).retryAfterMs).toBe(8_000);
    expect(calls).toHaveLength(1);

    vi.setSystemTime(1_000_000 + 12_000);
    await expect(client.getAccountTokens("addr")).resolves.toEqual({ tokens: [] });
    expect(calls).toHaveLength(2);
  });

  it("uses the default backoff when the 429 has no usable header", async () => {
    const { f } = scriptedFetch([() => tooMany()]);
    await rejection(indexerClient(f).getAccountTokens("addr"));
    expect(rl.hubCooldownRemainingMs("indexer")).toBe(5_000);
  });

  it("backs off exponentially on repeated 429s and resets after a success", async () => {
    const { f } = scriptedFetch([tooMany, tooMany, tooMany, () => ok(), tooMany]);
    const client = indexerClient(f);
    let now = 1_000_000;
    const remainingAfter429 = async () => {
      await rejection(client.getAccountTokens("addr"));
      const remaining = rl.hubCooldownRemainingMs("indexer");
      now += remaining;
      vi.setSystemTime(now);
      return remaining;
    };

    expect(await remainingAfter429()).toBe(5_000);
    expect(await remainingAfter429()).toBe(10_000);
    expect(await remainingAfter429()).toBe(20_000);
    await client.getAccountTokens("addr");
    expect(await remainingAfter429()).toBe(5_000);
  });

  it("does not extend or escalate the cooldown for 429s from requests already in flight", async () => {
    const releases: Array<() => void> = [];
    const f = (async () => {
      await new Promise<void>((r) => releases.push(r));
      return tooMany();
    }) as unknown as typeof fetch;
    const client = indexerClient(f);
    const first = rejection(client.getAccountTokens("addr"));
    const second = rejection(client.getAccountSummary("addr"));
    await flush();
    expect(releases).toHaveLength(2);

    releases[0]();
    await first;
    vi.setSystemTime(1_000_000 + 1_000);
    releases[1]();
    await second;
    expect(rl.hubCooldownRemainingMs("indexer")).toBe(4_000);

    vi.setSystemTime(1_000_000 + 5_000);
    const third = rejection(client.getAccountTokens("addr"));
    await flush();
    expect(releases).toHaveLength(3);
    releases[2]();
    await third;
    expect(rl.hubCooldownRemainingMs("indexer")).toBe(10_000);
  });
});

describe("route groups (mirror the Hub's RATE_LIMITS)", () => {
  it("puts BTC broadcast, UTXOs, fee estimates and signing-request create/submit in send", () => {
    expect(rl.hubRouteGroup("POST", `${HUB}/v1/indexer/btc/tx`)).toBe("send");
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/indexer/btc/address/tb1pabc/utxo`)).toBe("send");
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/indexer/btc/fee-estimates`)).toBe("send");
    expect(rl.hubRouteGroup("POST", `${HUB}/v1/signing-requests`)).toBe("send");
    expect(rl.hubRouteGroup("POST", `${HUB}/v1/signing-requests/abc-123/submit`)).toBe("send");
  });

  it("puts the other indexer routes in indexer, and session routes in auth and recovery", () => {
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/indexer/arch/accounts/a/tokens`)).toBe("indexer");
    expect(rl.hubRouteGroup("POST", `${HUB}/v1/indexer/arch/rpc`)).toBe("indexer");
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/indexer/btc/address/tb1pabc/txs`)).toBe("indexer");
    expect(rl.hubRouteGroup("POST", `${HUB}/v1/auth/session/challenge`)).toBe("auth");
    expect(rl.hubRouteGroup("POST", `${HUB}/v1/recovery/email/start`)).toBe("recovery");
  });

  it("puts sending an error report in report", () => {
    expect(rl.hubRouteGroup("POST", `${HUB}/v1/error-reports`)).toBe("report");
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/error-reports`)).toBe("global");
  });

  it("puts unknown routes, and other signing-request routes, in global", () => {
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/turnkey/config`)).toBe("global");
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/signing-requests/abc-123`)).toBe("global");
    expect(rl.hubRouteGroup("GET", `${HUB}/v1/portfolio?x=1`)).toBe("global");
    expect(rl.hubRouteGroup("GET", `${HUB}/v2/whatever`)).toBe("global");
  });

  it("an indexer-read cooldown does not block send routes", async () => {
    const { f } = scriptedFetch([tooMany]);
    await rejection(indexerClient(f).getAccountTokens("addr"));
    expect(rl.hubCooldownRemainingMs("indexer")).toBeGreaterThan(0);

    const send = scriptedFetch([() => ok({}), () => ok({})]);
    await rl.fetchWithHubRateLimit(send.f, `${HUB}/v1/indexer/btc/tx`, { method: "POST" });
    await rl.fetchWithHubRateLimit(send.f, `${HUB}/v1/signing-requests`, { method: "POST" });
    expect(send.calls).toHaveLength(2);
  });

  it("a send cooldown does not block indexer reads", async () => {
    const send = scriptedFetch([tooMany]);
    await rejection(rl.fetchWithHubRateLimit(send.f, `${HUB}/v1/indexer/btc/fee-estimates`));
    expect(rl.hubCooldownRemainingMs("send")).toBeGreaterThan(0);
    await rejection(rl.fetchWithHubRateLimit(send.f, `${HUB}/v1/signing-requests/x/submit`, { method: "POST" }));
    expect(send.calls).toHaveLength(1);

    const { f, calls } = scriptedFetch([() => ok({ tokens: [] })]);
    await expect(indexerClient(f).getAccountTokens("addr")).resolves.toEqual({ tokens: [] });
    expect(calls).toHaveLength(1);
  });

  it("an indexer cooldown does not block session mint", async () => {
    const { f } = scriptedFetch([tooMany]);
    await rejection(indexerClient(f).getAccountTokens("addr"));

    const auth = scriptedFetch([() => ok({ challengeId: "c" })]);
    const res = await rl.fetchWithHubRateLimit(auth.f, `${HUB}/v1/auth/session/challenge`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(auth.calls).toHaveLength(1);
  });
});

describe("SDK-wrapped rate-limit errors", () => {
  it("still carry the delay through the SDK's network-error rewrap", () => {
    const wrapped = new Error("WalletHub network error: Wallet Hub rate limit: retry in 7s");
    expect(rl.hubRetryAfterMs(wrapped)).toBe(7_000);
    expect(rl.isHubRateLimitError(wrapped)).toBe(true);
    expect(rl.isHubRateLimitError(new Error("WalletHub error 500 Internal Server Error"))).toBe(false);
  });
});

describe("failed Hub responses in the diagnostics log", () => {
  const ADDRESS = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
  const REQUEST_ID = "4b1f6d0e-8a55-4c0e-9c1b-2f7f3a401e29";

  function failed(status: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({ statusCode: status, message: "boom" }), { status, headers });
  }

  async function hubFailures() {
    const { getRecentLogs } = await import("../log");
    return getRecentLogs().filter((entry) => entry.msg === "Hub request failed");
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("records the Hub's request id, the status and the route without the address", async () => {
    const { f } = scriptedFetch([() => failed(500, { "x-request-id": REQUEST_ID })]);
    const err = (await rejection(indexerClient(f).getAccountSummary(ADDRESS))) as Error;

    const entries = await hubFailures();
    expect(entries.map((entry) => [entry.level, entry.extra])).toEqual([
      ["warn", { status: 500, requestId: REQUEST_ID, method: "GET", route: "/v1/indexer/arch/accounts/:id" }],
    ]);
    expect(JSON.stringify(entries)).not.toContain(ADDRESS);
    // The id stays out of the message: callers classify errors by its text.
    expect(err.message).not.toContain(REQUEST_ID);
  });

  it("records a failure through the SDK's fetch, and a 429 before throwing", async () => {
    vi.stubGlobal(
      "fetch",
      scriptedFetch([() => failed(401, { "x-request-id": "req-a" }), () => tooMany({ "x-request-id": "req-b" })]).f,
    );
    await rl.hubRateLimitedFetch(`${HUB}/v1/signing-requests/0b9c2f1e-1111-4222-8333-444455556666/submit`, {
      method: "post",
    });
    await rejection(rl.hubRateLimitedFetch(`${HUB}/v1/auth/session/refresh`, { method: "POST" }));

    expect((await hubFailures()).map((entry) => entry.extra)).toEqual([
      { status: 401, requestId: "req-a", method: "POST", route: "/v1/signing-requests/:id/submit" },
      { status: 429, requestId: "req-b", method: "POST", route: "/v1/auth/session/refresh" },
    ]);
    vi.unstubAllGlobals();
  });

  it("records a failure that carries no request id", async () => {
    const { f } = scriptedFetch([() => failed(502)]);
    await rl.fetchWithHubRateLimit(f, `${HUB}/v1/indexer/btc/fee-estimates`);
    expect((await hubFailures()).map((entry) => entry.extra)).toEqual([
      { status: 502, method: "GET", route: "/v1/indexer/btc/fee-estimates" },
    ]);
  });

  // The Hub's proxy answers 502 whenever the indexer fails; its message leads with the indexer's status.
  function indexerFailed(upstream: string): Response {
    return new Response(
      JSON.stringify({
        statusCode: 502,
        error: "BadGateway",
        message: `Indexer error ${upstream} (https://explorer.test/api/v1/testnet/accounts/${ADDRESS}): {}`,
      }),
      { status: 502, statusText: "Bad Gateway", headers: { "x-request-id": REQUEST_ID } },
    );
  }

  it("does not record an account the indexer has not seen, which arrives as a 502", async () => {
    const { f } = scriptedFetch([() => indexerFailed("404 Not Found")]);
    const err = (await rejection(indexerClient(f).getAccountSummary(ADDRESS))) as Error;

    expect(await hubFailures()).toEqual([]);
    // Reading the body to tell did not take it from the caller.
    expect(err.message).toContain("Indexer error 404 Not Found");
    const { isIndexerNotFoundError } = await import("../indexer");
    expect(isIndexerNotFoundError(err)).toBe(true);
  });

  it("records the indexer's status when it is the indexer that failed", async () => {
    const { f } = scriptedFetch([() => indexerFailed("500 Internal Server Error")]);
    await rejection(indexerClient(f).getAccountSummary(ADDRESS));
    expect((await hubFailures()).map((entry) => entry.extra)).toEqual([
      { status: 502, upstreamStatus: 500, requestId: REQUEST_ID, method: "GET", route: "/v1/indexer/arch/accounts/:id" },
    ]);
  });

  it("keeps the request id for the banner that shows the error, logged or not", async () => {
    const { hubRequestIdFor } = await import("../hub-error");
    const { f } = scriptedFetch([
      () => indexerFailed("404 Not Found"),
      () => failed(500, { "x-request-id": "req-500" }),
      () => failed(500),
    ]);
    const notFound = (await rejection(indexerClient(f).getAccountSummary(ADDRESS))) as Error;
    const broken = (await rejection(indexerClient(f).getBtcFeeEstimates())) as Error;
    await rejection(indexerClient(f).getBtcFeeEstimates());

    expect(hubRequestIdFor(notFound.message)).toBe(REQUEST_ID);
    expect(hubRequestIdFor(`Couldn't load fees: ${broken.message}`)).toBe("req-500");
    expect(hubRequestIdFor("Incorrect password")).toBeUndefined();
  });

  it("still records and returns a response whose body cannot be copied", async () => {
    const res = failed(500, { "x-request-id": REQUEST_ID });
    await res.text();
    const { f } = scriptedFetch([() => res]);
    await expect(rl.fetchWithHubRateLimit(f, `${HUB}/v1/indexer/btc/fee-estimates`)).resolves.toBe(res);
    expect((await hubFailures()).map((entry) => (entry.extra as { requestId: string }).requestId)).toEqual([
      REQUEST_ID,
    ]);
  });

  it("does not record a success, a 404, or a call a cooldown stopped", async () => {
    const { f } = scriptedFetch([() => ok(), () => failed(404, { "x-request-id": REQUEST_ID }), () => tooMany()]);
    await rl.fetchWithHubRateLimit(f, `${HUB}/v1/indexer/btc/fee-estimates`);
    await rl.fetchWithHubRateLimit(f, `${HUB}/v1/indexer/arch/accounts/${ADDRESS}`);
    await rejection(rl.fetchWithHubRateLimit(f, `${HUB}/v1/indexer/arch/accounts/${ADDRESS}`));
    await rejection(rl.fetchWithHubRateLimit(f, `${HUB}/v1/indexer/arch/accounts/${ADDRESS}`));
    expect((await hubFailures()).map((entry) => (entry.extra as { status: number }).status)).toEqual([429]);
  });
});

describe("hubRouteLabel", () => {
  it("keeps route words and masks everything else", () => {
    const label = (path: string) => rl.hubRouteLabel(`${HUB}${path}`);
    expect(label("/v1/indexer/btc/fee-estimates")).toBe("/v1/indexer/btc/fee-estimates");
    expect(label("/v1/indexer/btc/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/utxo")).toBe(
      "/v1/indexer/btc/address/:id/utxo",
    );
    expect(label(`/v1/indexer/arch/transactions/${"ab".repeat(32)}/execution`)).toBe(
      "/v1/indexer/arch/transactions/:id/execution",
    );
    expect(label("/v1/indexer/btc/block-height/840000")).toBe("/v1/indexer/btc/block-height/:id");
    expect(label("/v1/indexer/btc/runes/UNCOMMON%E2%80%A2GOODS")).toBe("/v1/indexer/btc/runes/:id");
    expect(label("/v1/turnkey/wallets/4f2c?network=testnet4&address=tb1qsecret")).toBe("/v1/turnkey/wallets/:id");
  });

  it("drops a base path in front of /v1", () => {
    expect(rl.hubRouteLabel("https://example.com/hub/v1/auth/session")).toBe("/v1/auth/session");
  });
});
