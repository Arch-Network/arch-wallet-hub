import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getIndexerClient } from "../indexer/store.js";

const PROBE_TIMEOUT_MS = 5_000;

interface NetworkProbeResult {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

async function probeWithTimeout(
  fn: () => Promise<unknown>,
  label: string
): Promise<NetworkProbeResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`${label} timeout after ${PROBE_TIMEOUT_MS}ms`))
        );
      }),
    ]);
    clearTimeout(timer);
    return { available: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return {
      available: false,
      latencyMs: Date.now() - start,
      error: err?.message || `${label} unreachable`,
    };
  }
}

export const registerHealthRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/health",
    {
      schema: {
        summary: "Health check",
        tags: ["system"],
        response: {
          200: Type.Object({
            ok: Type.Boolean(),
            service: Type.String(),
            env: Type.String()
          })
        }
      }
    },
    async () => ({
      ok: true,
      service: "wallet-hub-api",
      env: server.config.NODE_ENV
    })
  );

  const NetworkAvailabilitySchema = Type.Object({
    available: Type.Boolean(),
    latencyMs: Type.Optional(Type.Number()),
    error: Type.Optional(Type.String()),
  });

  server.get(
    "/health/status",
    {
      schema: {
        summary: "Per-network health status",
        tags: ["system"],
        response: {
          200: Type.Object({
            ok: Type.Boolean(),
            service: Type.String(),
            networks: Type.Object({
              bitcoin: NetworkAvailabilitySchema,
              arch: NetworkAvailabilitySchema,
            }),
          }),
        },
      },
    },
    async () => {
      const indexer = getIndexerClient();

      const [bitcoin, arch] = await Promise.all([
        indexer
          ? probeWithTimeout(() => indexer.getBtcFeeEstimates(), "Bitcoin indexer")
          : Promise.resolve<NetworkProbeResult>({
              available: false,
              error: "Bitcoin indexer not configured",
            }),
        probeArch(indexer, server.config.ARCH_RPC_NODE_URL),
      ]);

      return {
        ok: true,
        service: "wallet-hub-api",
        networks: { bitcoin, arch },
      };
    }
  );
};

async function probeArch(
  indexer: ReturnType<typeof getIndexerClient>,
  rpcNodeUrl: string | undefined
): Promise<NetworkProbeResult> {
  if (rpcNodeUrl) {
    return probeWithTimeout(async () => {
      const res = await fetch(rpcNodeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_block_count", params: [] }),
      });
      if (!res.ok) throw new Error(`Arch RPC HTTP ${res.status}`);
      const json = await res.json();
      if (json?.error) throw new Error(json.error.message || "Arch RPC error");
    }, "Arch RPC");
  }

  if (indexer) {
    return probeWithTimeout(() => indexer.getNetworkStats(), "Arch indexer");
  }

  return { available: false, error: "Arch not configured (no RPC URL or indexer)" };
}
