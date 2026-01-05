import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";

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
};
