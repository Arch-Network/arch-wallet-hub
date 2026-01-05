import type { FastifyPluginAsync } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

export const registerOpenApi: FastifyPluginAsync<{ basePath: string }> = async (
  server,
  opts
) => {
  await server.register(swagger, {
    openapi: {
      info: {
        title: "Arch Wallet Hub API",
        description:
          "Wallet hub / orchestration layer (Turnkey is custody+policy+signing only; Arch owns Bitcoin semantics).",
        version: "0.0.0"
      },
      servers: [{ url: opts.basePath }]
    }
  });

  await server.register(swaggerUi, {
    routePrefix: `${opts.basePath}/docs`,
    uiConfig: {
      docExpansion: "list",
      deepLinking: false
    }
  });
};
