import type { IndexerClient } from "./client.js";

let indexerClient: IndexerClient | null = null;
const networkClients = new Map<string, IndexerClient>();

export function setIndexerClient(client: IndexerClient | null) {
  indexerClient = client;
}

export function getIndexerClient(): IndexerClient | null {
  return indexerClient;
}

export function setNetworkIndexerClient(network: string, client: IndexerClient) {
  networkClients.set(network, client);
}

export function getNetworkIndexerClient(network: string): IndexerClient | null {
  return networkClients.get(network) ?? null;
}
