import type { FastifyPluginAsync } from "fastify";
import { createIndexerClient, type IndexerClient } from "../indexer/client.js";
import { setIndexerClient, setNetworkIndexerClient } from "../indexer/store.js";

declare module "fastify" {
  interface FastifyInstance {
    indexer: IndexerClient | null;
  }
}

function swapNetworkSegment(url: string, target: "testnet" | "mainnet"): string {
  return url.replace(/\/(testnet|mainnet)(\/|$)/, `/${target}$2`);
}

export const registerIndexer: FastifyPluginAsync = async (server) => {
  const indexer = createIndexerClient(server);
  server.decorate("indexer", indexer);
  setIndexerClient(indexer);

  if (indexer) {
    const baseUrl = server.config.INDEXER_BASE_URL!;
    server.log.info(
      { INDEXER_BASE_URL: baseUrl, INDEXER_TIMEOUT_MS: (server.config as any).INDEXER_TIMEOUT_MS },
      "indexer configured"
    );

    const testnetUrl = swapNetworkSegment(baseUrl, "testnet");
    const mainnetUrl = swapNetworkSegment(baseUrl, "mainnet");

    const testnetClient = createIndexerClient(server, testnetUrl);
    const mainnetClient = createIndexerClient(server, mainnetUrl);
    if (testnetClient) setNetworkIndexerClient("testnet", testnetClient);
    if (mainnetClient) setNetworkIndexerClient("mainnet", mainnetClient);

    server.log.info({ testnetUrl, mainnetUrl }, "network-specific indexer clients created");
  } else {
    server.log.warn("indexer not configured (INDEXER_BASE_URL missing)");
  }
};
