import type { FastifyPluginAsync } from "fastify";
import { createIndexerClient, type IndexerClient } from "../indexer/client.js";

declare module "fastify" {
  interface FastifyInstance {
    indexer: IndexerClient | null;
  }
}

export const registerIndexer: FastifyPluginAsync = async (server) => {
  server.decorate("indexer", createIndexerClient(server));
};

