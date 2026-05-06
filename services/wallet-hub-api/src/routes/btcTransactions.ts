import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";
import { getTurnkeyResourceByIdForApp } from "../db/queries.js";
import { getTurnkeyClient } from "../turnkey/store.js";
import { indexerForRequest } from "../indexer/forRequest.js";
import type { IndexerClient } from "../indexer/client.js";
import * as bitcoin from "bitcoinjs-lib";

type Utxo = {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
};

function selectUtxos(utxos: Utxo[], targetSats: number, feeSats: number): { selected: Utxo[]; totalInput: number } {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const needed = targetSats + feeSats;
  const selected: Utxo[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= needed) break;
  }

  if (total < needed) {
    throw new Error(`Insufficient BTC balance: have ${total} sats, need ${needed} sats (${targetSats} + ${feeSats} fee)`);
  }

  return { selected, totalInput: total };
}

function estimateTxSize(inputCount: number, outputCount: number): number {
  return 10.5 + inputCount * 57.5 + outputCount * 43;
}

async function buildUnsignedPsbt(params: {
  indexer: IndexerClient;
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeRate?: number;
}) {
  const { indexer, fromAddress, toAddress, amountSats } = params;

  const utxos = (await indexer.getBtcAddressUtxos(fromAddress)) as Utxo[];
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw Object.assign(new Error("No UTXOs available for this address"), { code: "NO_UTXOS" });
  }

  let feeRate = params.feeRate;
  if (!feeRate) {
    try {
      const estimates = (await indexer.getBtcFeeEstimates()) as Record<string, number>;
      feeRate = estimates["6"] ?? estimates["3"] ?? 5;
    } catch {
      feeRate = 5;
    }
  }

  const estimatedFee = Math.ceil(estimateTxSize(1, 2) * feeRate);
  const { selected, totalInput } = selectUtxos(utxos, amountSats, estimatedFee);

  const actualSize = estimateTxSize(selected.length, 2);
  const actualFee = Math.ceil(actualSize * feeRate);
  const changeSats = totalInput - amountSats - actualFee;

  const isTestnet = fromAddress.startsWith("tb1") || fromAddress.startsWith("bcrt1");
  const network = isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const psbt = new bitcoin.Psbt({ network });

  for (const utxo of selected) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.address.toOutputScript(fromAddress, network),
        value: utxo.value
      }
    });
  }

  psbt.addOutput({ address: toAddress, value: amountSats });

  if (changeSats > 546) {
    psbt.addOutput({ address: fromAddress, value: changeSats });
  }

  return {
    psbt,
    network,
    fromAddress,
    toAddress,
    amountSats,
    feeSats: actualFee,
    feeRate,
    changeSats: changeSats > 546 ? changeSats : 0,
    inputCount: selected.length,
  };
}

const SendBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  turnkeyResourceId: Type.String({ minLength: 1 }),
  toAddress: Type.String({ minLength: 1 }),
  amountSats: Type.Integer({ minimum: 546 }),
  feeRate: Type.Optional(Type.Number({ minimum: 1 }))
});

export const registerBtcTransactionRoutes: FastifyPluginAsync = async (server) => {

  // ── Full send: server-side construction + signing (custodial only) ────
  server.post(
    "/btc/send",
    {
      schema: {
        summary: "Send BTC from a Turnkey wallet (server-side construction + signing)",
        tags: ["btc"],
        body: SendBody
      }
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;

      const db = getDbPool();
      const body = request.body as typeof SendBody.static;

      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId: body.externalUserId })
      );

      const resource = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: body.turnkeyResourceId, appId })
      );
      if (!resource) return reply.notFound("Turnkey resource not found");
      if (resource.user_id !== user.id) return reply.forbidden("Resource does not belong to user");
      if (!resource.default_address) return reply.badRequest("Turnkey resource has no address");

      const rootOrgId = server.config.TURNKEY_ORGANIZATION_ID;
      if (resource.organization_id !== rootOrgId) {
        return reply.code(400).send({
          statusCode: 400,
          error: "PasskeyWalletNotSupported",
          message: "BTC sending from passkey wallets must be built and broadcast by the client."
        });
      }

      const fromAddress = resource.default_address;

      let result;
      try {
        result = await buildUnsignedPsbt({
          indexer,
          fromAddress,
          toAddress: body.toAddress,
          amountSats: body.amountSats,
          feeRate: body.feeRate,
        });
      } catch (err: any) {
        if (err.code === "NO_UTXOS") {
          return reply.code(409).send({ error: "NoUtxos", message: err.message });
        }
        return reply.code(502).send({ error: "PsbtBuildFailed", message: err.message });
      }

      const turnkey = getTurnkeyClient();
      if (!turnkey) return reply.notImplemented("Turnkey not configured");

      let signedTxHex: string;
      try {
        const psbtBase64 = result.psbt.toBase64();
        const signResult = await turnkey.signBitcoinTransaction({
          signWith: fromAddress,
          unsignedTransaction: psbtBase64
        });

        const signedPsbt = bitcoin.Psbt.fromBase64(signResult.signedTransaction, { network: result.network });
        signedPsbt.finalizeAllInputs();
        signedTxHex = signedPsbt.extractTransaction().toHex();
      } catch (err: any) {
        request.log.error({ err }, "btc.send.turnkey_sign_failed");
        return reply.internalServerError(`Turnkey signing failed: ${err.message}`);
      }

      let txid: string;
      try {
        txid = (await indexer.broadcastBtcTransaction(signedTxHex)) as string;
      } catch (err: any) {
        request.log.error({ err }, "btc.send.broadcast_failed");
        return reply.code(502).send({ error: "BroadcastFailed", message: err.message });
      }

      return {
        txid,
        fromAddress,
        toAddress: body.toAddress,
        amountSats: body.amountSats,
        feeSats: result.feeSats,
        feeRate: result.feeRate
      };
    }
  );
};
