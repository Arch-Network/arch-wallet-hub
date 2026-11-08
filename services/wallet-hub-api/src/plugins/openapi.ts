import type { FastifyPluginAsync } from "fastify";
import swagger from "@fastify/swagger";

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

  // The Swagger UI (and its /docs/json spec route) exposes the full
  // API surface to unauthenticated callers. Only mount it outside
  // production so prod scanners can't enumerate routes; the spec is
  // still generated in-memory for tests/tooling.
  // @fastify/swagger-ui is a devDependency (the prod image runs
  // `npm prune --omit=dev`), so it must only be imported here.
  if (server.config.NODE_ENV !== "production") {
    const { default: swaggerUi } = await import("@fastify/swagger-ui");
    await server.register(swaggerUi, {
      routePrefix: `${opts.basePath}/docs`,
      uiConfig: {
        docExpansion: "list",
        deepLinking: false
      }
    });
  }
};
