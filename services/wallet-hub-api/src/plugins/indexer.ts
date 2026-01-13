import type { FastifyPluginAsync } from "fastify";
import { createIndexerClient, type IndexerClient } from "../indexer/client.js";
import { setIndexerClient } from "../indexer/store.js";

declare module "fastify" {
  interface FastifyInstance {
    indexer: IndexerClient | null;
  }
}

export const registerIndexer: FastifyPluginAsync = async (server) => {
  const indexer = createIndexerClient(server);
  server.decorate("indexer", indexer);
  setIndexerClient(indexer);
  if (indexer) {
    server.log.info(
      { INDEXER_BASE_URL: server.config.INDEXER_BASE_URL, INDEXER_TIMEOUT_MS: (server.config as any).INDEXER_TIMEOUT_MS },
      "indexer configured"
    );
  } else {
    server.log.warn("indexer not configured (INDEXER_BASE_URL missing)");
  }
};
