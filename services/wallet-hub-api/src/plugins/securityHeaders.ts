import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import helmet from "@fastify/helmet";

/**
 * Security headers
 *
 * Defense-in-depth headers via `@fastify/helmet`. Most of these are
 * inert for a JSON API (no UA renders our 200 responses as HTML), but
 * `/v1/docs` serves Swagger UI which is a real HTML surface and needs
 * clickjacking + MIME-sniffing protection, and HSTS + Referrer-Policy
 * are cheap insurance across the board.
 *
 * We deliberately do NOT set `contentSecurityPolicy` to the default
 * strict policy because Swagger UI inlines styles and scripts; instead
 * we set a CSP scoped to known-safe sources. If the docs UI is ever
 * disabled in prod (recommended) we can tighten this further.
 */
const securityHeadersPlugin: FastifyPluginAsync = async (server) => {
  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: false,
    },
    frameguard: { action: "deny" },
    noSniff: true,
    xssFilter: true,
    hidePoweredBy: true,
  });
};

export const registerSecurityHeaders = fp(securityHeadersPlugin, {
  name: "security-headers",
});
