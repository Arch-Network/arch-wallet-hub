import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { parsePubkey } from "../arch/arch.js";

async function callJsonRpc(nodeUrl: string, body: any): Promise<any> {
  const res = await fetch(nodeUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Arch RPC HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json?.error) {
    const msg = json?.error?.message ?? JSON.stringify(json?.error);
    throw new Error(`Arch RPC error: ${msg}`);
  }
  return json?.result;
}

const AirdropBody = Type.Object({
  archAccountAddress: Type.String({ minLength: 1 }),
  // Optional in case Arch RPC supports it; we try both signatures.
  lamports: Type.Optional(Type.String({ minLength: 1 }))
});

const AirdropResponse = Type.Object({
  archAccountAddress: Type.String(),
  result: Type.Unknown()
});

export const registerArchAccountRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/arch/accounts/airdrop",
    {
      schema: {
        summary: "Dev helper: request an airdrop for an Arch account address (creates the account if missing)",
        tags: ["arch"],
        body: AirdropBody,
        response: { 200: AirdropResponse }
      }
    },
    async (request, reply) => {
      const appId = request.app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");
      if (!server.config.ARCH_RPC_NODE_URL) return reply.notImplemented("ARCH_RPC_NODE_URL not configured");

      const body = request.body as any;
      const archAccountAddress = String(body.archAccountAddress);
      const pubkeyBytes = Array.from(parsePubkey(archAccountAddress));
      const lamportsRaw = body?.lamports ? String(body.lamports) : null;

      // Arch RPC in some environments expects params: [u8[]]
      // Others may accept params: [u8[], lamports]. We'll try both.
      const base = { jsonrpc: "2.0", id: "wallet-hub-airdrop", method: "request_airdrop" };
      try {
        const result = await callJsonRpc(server.config.ARCH_RPC_NODE_URL, {
          ...base,
          params: [pubkeyBytes]
        });
        return { archAccountAddress, result };
      } catch (e1: any) {
        if (!lamportsRaw) throw e1;
        const lamports = Number(lamportsRaw);
        const result = await callJsonRpc(server.config.ARCH_RPC_NODE_URL, {
          ...base,
          params: [pubkeyBytes, lamports]
        });
        return { archAccountAddress, result };
      }
    }
  );
};

