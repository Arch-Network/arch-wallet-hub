import type { FastifyPluginAsync } from "fastify";
import { createIndexerClient, type IndexerClient } from "../indexer/client.js";
import { setIndexerClient, setNetworkIndexerClient } from "../indexer/store.js";
import { resolveNetworkBaseUrl } from "../indexer/networkUrl.js";

declare module "fastify" {
  interface FastifyInstance {
    indexer: IndexerClient | null;
  }
}

export const registerIndexer: FastifyPluginAsync = async (server) => {
  const timeoutMs = (server.config as any).INDEXER_TIMEOUT_MS ?? 30_000;

  const indexer = createIndexerClient(server);
  server.decorate("indexer", indexer);
  setIndexerClient(indexer);

  if (indexer) {
    const baseUrl = server.config.INDEXER_BASE_URL!;
    server.log.info(
      { INDEXER_BASE_URL: baseUrl, INDEXER_TIMEOUT_MS: timeoutMs },
      "indexer configured"
    );

    // Upstream indexer uses PATH-based network selection (no header).
    // Legacy `.../api/v1/bitcoin/...` requests default to TESTNET on
    // the upstream, which silently misroutes mainnet wallet traffic
    // if INDEXER_BASE_URL doesn't already include a /{network}/ segment.
    // resolveNetworkBaseUrl normalizes both shapes -- with or without
    // an existing /testnet/ or /mainnet/ segment -- to the canonical
    // `.../api/v1/{network}` form.
    const testnetUrl = resolveNetworkBaseUrl(baseUrl, "testnet");
    const mainnetUrl = resolveNetworkBaseUrl(baseUrl, "mainnet");

    const testnetClient = createIndexerClient(server, testnetUrl);
    const mainnetClient = createIndexerClient(server, mainnetUrl);

    if (testnetClient) setNetworkIndexerClient("testnet", testnetClient);
    if (mainnetClient) setNetworkIndexerClient("mainnet", mainnetClient);

    // Log the resolved URLs prominently so CloudWatch verification
    // is one search query, not a code-read. Anyone debugging a
    // "why is mainnet returning testnet data" incident should be
    // able to land here in 30s.
    server.log.info(
      { testnetUrl, mainnetUrl },
      "network-specific indexer clients created (path-based routing)"
    );
  } else {
    server.log.warn("indexer not configured (INDEXER_BASE_URL missing)");
  }
};
