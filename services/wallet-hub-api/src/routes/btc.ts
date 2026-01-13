import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getBtcPlatformClient } from "../btcPlatform/store.js";

const AddressParams = Type.Object({
  address: Type.String({ minLength: 1 })
});

const BtcAddressSummaryResponse = Type.Object({
  address: Type.String(),
  summary: Type.Unknown()
});

const BtcAddressUtxosResponse = Type.Object({
  address: Type.String(),
  utxos: Type.Unknown()
});

export const registerBtcRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/btc/address/:address",
    {
      schema: {
        summary: "Get BTC address summary (served via Arch API platform BTC endpoints)",
        tags: ["btc"],
        params: AddressParams,
        response: { 200: BtcAddressSummaryResponse }
      }
    },
    async (request, reply) => {
      const btc = getBtcPlatformClient();
      if (!btc) return reply.notImplemented("BTC platform not configured");
      const { address } = request.params as any;
      try {
        const summary = await btc.getAddressSummary(address);
        return { address, summary };
      } catch (err: any) {
        const status = typeof err?.statusCode === "number" ? err.statusCode : 502;
        return reply.code(status).send({
          statusCode: status,
          error: "BTCPlatformError",
          message: String(err?.message ?? err)
        });
      }
    }
  );

  server.get(
    "/btc/address/:address/utxos",
    {
      schema: {
        summary: "Get BTC address UTXOs (served via Arch API platform BTC endpoints)",
        tags: ["btc"],
        params: AddressParams,
        response: { 200: BtcAddressUtxosResponse }
      }
    },
    async (request, reply) => {
      const btc = getBtcPlatformClient();
      if (!btc) return reply.notImplemented("BTC platform not configured");
      const { address } = request.params as any;
      try {
        const utxos = await btc.getAddressUtxos(address, { confirmedOnly: false });
        return { address, utxos };
      } catch (err: any) {
        const status = typeof err?.statusCode === "number" ? err.statusCode : 502;
        return reply.code(status).send({
          statusCode: status,
          error: "BTCPlatformError",
          message: String(err?.message ?? err)
        });
      }
    }
  );
};
