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
};
