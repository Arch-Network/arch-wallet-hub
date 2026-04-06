import type { FastifyPluginAsync } from "fastify";
import { createIndexerClient, withTitanBtc, type IndexerClient } from "../indexer/client.js";
import { setIndexerClient, setNetworkIndexerClient } from "../indexer/store.js";

declare module "fastify" {
  interface FastifyInstance {
    indexer: IndexerClient | null;
  }
}

function swapNetworkSegment(url: string, target: "testnet" | "mainnet"): string {
  return url.replace(/\/(testnet|mainnet)(\/|$)/, `/${target}$2`);
}

function applyTitanOverride(client: IndexerClient | null, titanUrl: string | undefined, timeoutMs: number, log: any): IndexerClient | null {
  if (!client || !titanUrl) return client;
  log.info({ TITAN_BASE_URL: titanUrl }, "Titan BTC override active — Bitcoin calls go directly to Titan");
  return withTitanBtc(client, titanUrl, timeoutMs);
}

export const registerIndexer: FastifyPluginAsync = async (server) => {
  const titanUrl = (server.config as any).TITAN_BASE_URL || (server.config as any).BTC_PLATFORM_BASE_URL;
  const timeoutMs = (server.config as any).INDEXER_TIMEOUT_MS ?? 30_000;

  let indexer = createIndexerClient(server);
  indexer = applyTitanOverride(indexer, titanUrl, timeoutMs, server.log);

  server.decorate("indexer", indexer);
  setIndexerClient(indexer);

  if (indexer) {
    const baseUrl = server.config.INDEXER_BASE_URL!;
    server.log.info(
      { INDEXER_BASE_URL: baseUrl, INDEXER_TIMEOUT_MS: timeoutMs },
      "indexer configured"
    );

    const testnetUrl = swapNetworkSegment(baseUrl, "testnet");
    const mainnetUrl = swapNetworkSegment(baseUrl, "mainnet");

    let testnetClient = createIndexerClient(server, testnetUrl);
    let mainnetClient = createIndexerClient(server, mainnetUrl);

    testnetClient = applyTitanOverride(testnetClient, titanUrl, timeoutMs, server.log);
    mainnetClient = applyTitanOverride(mainnetClient, titanUrl, timeoutMs, server.log);

    if (testnetClient) setNetworkIndexerClient("testnet", testnetClient);
    if (mainnetClient) setNetworkIndexerClient("mainnet", mainnetClient);

    server.log.info({ testnetUrl, mainnetUrl }, "network-specific indexer clients created");
  } else {
    server.log.warn("indexer not configured (INDEXER_BASE_URL missing)");
  }
};
