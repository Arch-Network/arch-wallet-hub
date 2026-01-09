import Fastify from "fastify";
import sensible from "@fastify/sensible";
import crypto from "node:crypto";
import { getEnv } from "./config/env.js";
import { registerDb } from "./plugins/db.js";
import { registerObservability } from "./plugins/observability.js";
import { registerOpenApi } from "./plugins/openapi.js";
import { registerTurnkey } from "./plugins/turnkey.js";
import { registerIndexer } from "./plugins/indexer.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTurnkeyRoutes } from "./routes/turnkey.js";
import { registerWalletLinkingRoutes } from "./routes/walletLinking.js";
import { registerArchTransactionRoutes } from "./routes/archTransactions.js";

declare module "fastify" {
  interface FastifyInstance {
    config: ReturnType<typeof getEnv>;
  }
}

export async function createServer() {
  const config = getEnv(process.env);

  const server = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-api-key']",
          "req.headers['turnkey-api-private-key']",
          "req.headers['turnkey-api-public-key']",
          "req.headers['x-turnkey-api-private-key']",
          "req.headers['x-turnkey-api-public-key']"
        ],
        remove: true
      }
    },
    requestIdHeader: "x-request-id",
    genReqId(req) {
      // If client provides x-request-id, Fastify will use it; otherwise generate a short one.
      return req.headers["x-request-id"]?.toString() ?? crypto.randomUUID();
    }
  });

  server.decorate("config", config);

  await server.register(sensible);
  await server.register(registerObservability);
  await server.register(registerDb);
  await server.register(registerTurnkey);
  await server.register(registerIndexer);
  await server.register(registerOpenApi, { basePath: "/v1" });
  await server.register(registerHealthRoutes, { prefix: "/v1" });
  await server.register(registerTurnkeyRoutes, { prefix: "/v1" });
  await server.register(registerWalletLinkingRoutes, { prefix: "/v1" });
  await server.register(registerArchTransactionRoutes, { prefix: "/v1" });

  return server;
}
