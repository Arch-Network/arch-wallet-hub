import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { registerIndexerRoutes } from "../indexer.js";
import { registerObservability } from "../../plugins/observability.js";
import { setIndexerClient, setNetworkIndexerClient } from "../../indexer/store.js";
import { IndexerHttpError, type IndexerClient } from "../../indexer/client.js";

/**
 * The proxy answers 502 whenever the indexer fails, whatever the indexer
 * said. The status the indexer gave goes on the request's
 * `request.completed` line as `upstreamStatus`, which is how the
 * UpstreamErrors alarm (infra/cdk/lib/api-error-alarms.ts) tells an
 * account the indexer has never seen from an indexer that is down.
 * The response itself must not change.
 */
const INSCRIPTION_ID = `${"a".repeat(64)}i0`;

function notFound(what: string): IndexerHttpError {
  return new IndexerHttpError(`Indexer error 404 Not Found (https://indexer.test/${what}): missing`, 404);
}

async function buildApp(indexer: Partial<IndexerClient>) {
  const client = indexer as IndexerClient;
  setIndexerClient(client);
  setNetworkIndexerClient("testnet", client);
  setNetworkIndexerClient("mainnet", client);

  const logged: Array<Record<string, unknown>> = [];
  const app = Fastify({
    logger: { level: "info", stream: { write: (line: string) => logged.push(JSON.parse(line)) } },
  });
  await app.register(sensible);
  await app.register(registerObservability);
  await app.register(registerIndexerRoutes, { prefix: "/v1" });
  await app.ready();
  const completed = () => logged.filter((l) => l.msg === "request.completed");
  return { app, completed };
}

describe("the indexer's status on the request log", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"] | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each([
    {
      site: "a proxied read",
      indexer: { getAccountSummary: async () => Promise.reject(notFound("accounts/a1")) },
      request: { method: "GET" as const, url: "/v1/indexer/arch/accounts/upstream-status-a1" },
      message: "Indexer error 404 Not Found (https://indexer.test/accounts/a1): missing",
    },
    {
      site: "the faucet",
      indexer: { requestFaucetAirdrop: async () => Promise.reject(notFound("faucet")) },
      request: { method: "POST" as const, url: "/v1/indexer/arch/faucet/airdrop", payload: { address: "upstream-status-a2" } },
      message: "Indexer error 404 Not Found (https://indexer.test/faucet): missing",
    },
    {
      site: "inscription content",
      indexer: { getBtcInscriptionContent: async () => Promise.reject(notFound("content")) },
      request: { method: "GET" as const, url: `/v1/indexer/btc/inscriptions/${INSCRIPTION_ID}/content` },
      message: "Indexer error 404 Not Found (https://indexer.test/content): missing",
    },
    {
      site: "a broadcast",
      indexer: { broadcastBtcTransaction: async () => Promise.reject(notFound("tx")) },
      request: { method: "POST" as const, url: "/v1/indexer/btc/tx", payload: { rawTxHex: "00" } },
      message: "Indexer error 404 Not Found (https://indexer.test/tx): missing",
    },
  ])("logs it for $site, and answers the same 502 as before", async ({ indexer, request, message }) => {
    const built = await buildApp(indexer);
    app = built.app;
    const res = await app.inject(request);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ statusCode: 502, error: "BadGateway", message });
    expect(built.completed()).toHaveLength(1);
    expect(built.completed()[0]).toMatchObject({ statusCode: 502, upstreamStatus: 404 });
  });

  it("logs a status other than 404 too", async () => {
    const built = await buildApp({
      getAccountSummary: async () =>
        Promise.reject(new IndexerHttpError("Indexer error 429 Too Many Requests (https://indexer.test/x): slow down", 429)),
    });
    app = built.app;
    await app.inject({ method: "GET", url: "/v1/indexer/arch/accounts/upstream-status-a3" });
    expect(built.completed()[0]).toMatchObject({ statusCode: 502, upstreamStatus: 429 });
  });

  it("leaves the field off when the indexer gave no status", async () => {
    const built = await buildApp({
      getAccountSummary: async () => Promise.reject(new Error("Indexer request timeout after 30000ms: https://indexer.test/x")),
    });
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/v1/indexer/arch/accounts/upstream-status-a4" });
    expect(res.statusCode).toBe(502);
    expect(built.completed()[0]).toMatchObject({ statusCode: 502 });
    // Absent, not null: the alarm's filter counts a 502 line that has no such field.
    expect(built.completed()[0]).not.toHaveProperty("upstreamStatus");
  });

  it("leaves the field off a read that worked", async () => {
    const built = await buildApp({ getAccountSummary: async () => ({ address: "a5" }) });
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/v1/indexer/arch/accounts/upstream-status-a5" });
    expect(res.statusCode).toBe(200);
    expect(built.completed()[0]).not.toHaveProperty("upstreamStatus");
  });
});
