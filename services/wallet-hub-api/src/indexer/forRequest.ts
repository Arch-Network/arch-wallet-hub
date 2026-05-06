import type { FastifyRequest, FastifyReply, FastifyInstance } from "fastify";
import { getIndexerClient, getNetworkIndexerClient } from "./store.js";
import type { IndexerClient } from "./client.js";

export type ArchNetwork = "mainnet" | "testnet";

export function requestNetwork(request: FastifyRequest): ArchNetwork {
  const h = (request.headers["x-network"] as string)?.toLowerCase();
  return h === "mainnet" ? "mainnet" : "testnet";
}

/**
 * Resolve the Arch Indexer client to use for this request, picking by `x-network`
 * header with a graceful fallback to the legacy singleton when the deployment
 * isn't configured for split networks.
 *
 * Sends a 501 reply and returns null when no Indexer is configured at all, so
 * routes can `if (!indexer) return;` and skip the rest.
 */
export function indexerForRequest(request: FastifyRequest, reply: FastifyReply): IndexerClient | null {
  const network = requestNetwork(request);
  const client = getNetworkIndexerClient(network);
  if (client) return client;
  const fallback = getIndexerClient();
  if (!fallback) {
    reply.notImplemented("Indexer not configured (INDEXER_BASE_URL missing)");
    return null;
  }
  return fallback;
}

/**
 * Pick the Arch RPC node URL for this request, using `ARCH_RPC_NODE_URL_*`
 * when configured and the legacy single-URL `ARCH_RPC_NODE_URL` otherwise.
 */
export function archRpcUrlForRequest(
  request: FastifyRequest,
  server: FastifyInstance
): string | null {
  const network = requestNetwork(request);
  const cfg = server.config;
  const networked = network === "mainnet" ? cfg.ARCH_RPC_NODE_URL_MAINNET : cfg.ARCH_RPC_NODE_URL_TESTNET;
  return networked || cfg.ARCH_RPC_NODE_URL || null;
}
