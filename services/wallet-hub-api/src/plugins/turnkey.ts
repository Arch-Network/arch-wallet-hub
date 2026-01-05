import type { FastifyPluginAsync } from "fastify";
import { TurnkeyService } from "../turnkey/client.js";

declare module "fastify" {
  interface FastifyInstance {
    turnkey: TurnkeyService;
  }
}

export const registerTurnkey: FastifyPluginAsync = async (server) => {
  const turnkey = new TurnkeyService({
    baseUrl: server.config.TURNKEY_BASE_URL,
    organizationId: server.config.TURNKEY_ORGANIZATION_ID,
    apiPublicKey: server.config.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: server.config.TURNKEY_API_PRIVATE_KEY
  });

  server.decorate("turnkey", turnkey);
};

