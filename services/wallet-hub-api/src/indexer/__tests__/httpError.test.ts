import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createIndexerClient, IndexerHttpError } from "../client.js";

/**
 * An error status from the indexer is thrown with the status as a field.
 * The message is what callers and the wallet already see, and must not
 * change: the wallet reads the status out of its first words.
 */
const BASE = "https://indexer.test/api/v1/testnet";

function client() {
  const server = { config: { INDEXER_BASE_URL: BASE, INDEXER_API_KEY: "k" } } as unknown as FastifyInstance;
  return createIndexerClient(server)!;
}

function answer(status: number, statusText: string, body: string) {
  vi.stubGlobal("fetch", async () => new Response(body, { status, statusText }));
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("IndexerHttpError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["a GET", (c: ReturnType<typeof client>) => c.getAccountSummary("abc"), `${BASE}/accounts/abc`],
    ["a JSON POST", (c: ReturnType<typeof client>) => c.archRpc("read_account_info", []), `${BASE}/rpc`],
    ["a text POST", (c: ReturnType<typeof client>) => c.broadcastBtcTransaction("00"), `${BASE}/bitcoin/tx`],
    [
      "inscription content",
      (c: ReturnType<typeof client>) => c.getBtcInscriptionContent("i0"),
      `${BASE}/bitcoin/inscriptions/i0/content`,
    ],
  ])("carries the status of %s the indexer refused, with the message unchanged", async (_what, call, url) => {
    answer(404, "Not Found", "missing");
    const err = await rejection(call(client()));
    expect(err).toBeInstanceOf(IndexerHttpError);
    expect((err as IndexerHttpError).status).toBe(404);
    expect((err as Error).message).toBe(`Indexer error 404 Not Found (${url}): missing`);
  });

  it("is not what a request that got no answer throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const err = await rejection(client().getAccountSummary("abc"));
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(IndexerHttpError);
  });
});
