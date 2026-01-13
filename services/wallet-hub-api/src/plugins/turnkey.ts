import type { FastifyPluginAsync } from "fastify";
import { TurnkeyService } from "../turnkey/client.js";
import { setTurnkeyClient } from "../turnkey/store.js";

declare module "fastify" {
  interface FastifyInstance {
    turnkey: TurnkeyService;
  }
}

function normalizeHexKey(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
}

export const registerTurnkey: FastifyPluginAsync = async (server) => {
  const turnkey = new TurnkeyService({
    baseUrl: server.config.TURNKEY_BASE_URL,
    organizationId: server.config.TURNKEY_ORGANIZATION_ID,
    apiPublicKey: normalizeHexKey(server.config.TURNKEY_API_PUBLIC_KEY),
    apiPrivateKey: normalizeHexKey(server.config.TURNKEY_API_PRIVATE_KEY)
  });

  server.decorate("turnkey", turnkey);
  setTurnkeyClient(turnkey);
};
