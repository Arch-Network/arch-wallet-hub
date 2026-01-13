import type { IndexerClient } from "./client.js";

// Global Indexer client instance - set by the indexer plugin, accessible to all routes.
let indexerClient: IndexerClient | null = null;

export function setIndexerClient(client: IndexerClient | null) {
  indexerClient = client;
}

export function getIndexerClient(): IndexerClient | null {
  return indexerClient;
}
