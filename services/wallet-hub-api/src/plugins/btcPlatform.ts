import type { FastifyPluginAsync } from "fastify";
import { createBtcPlatformClient, type BtcPlatformClient } from "../btcPlatform/client.js";
import { setBtcPlatformClient } from "../btcPlatform/store.js";

declare module "fastify" {
  interface FastifyInstance {
    btcPlatform: BtcPlatformClient | null;
  }
}

export const registerBtcPlatform: FastifyPluginAsync = async (server) => {
  const btcPlatform = createBtcPlatformClient(server);
  server.decorate("btcPlatform", btcPlatform);
  setBtcPlatformClient(btcPlatform);
};
