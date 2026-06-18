/**
 * BTC transaction routes.
 *
 * Post-P3 the Hub never holds a signing key for any wallet, so this
 * module is intentionally thin:
 *
 *   - `/btc/build`     -- compose an unsigned PSBT from the
 *                         indexer's UTXO snapshot, the user's fee-rate
 *                         preference, and a target output. The
 *                         response is a PSBT hex + fee metadata that
 *                         the client signs locally via the
 *                         session-stamped signer.
 *   - `/btc/broadcast` -- relay a finalized signed transaction to the
 *                         indexer (which fans out to the Bitcoin
 *                         network). The wallet UI mostly skips this
 *                         and broadcasts via its own indexer client;
 *                         we keep the route so non-wallet SDK
 *                         consumers (back-office tooling, dapp
 *                         servers) don't need their own UTXO/relay
 *                         plumbing.
 *   - `/btc/estimate-fee` -- unchanged, pure compute.
 *
 * The old `/btc/send` (build + custodially sign + broadcast) and
 * `/btc/sign-psbt` (sign someone else's PSBT) endpoints are gone --
 * they only made sense when the Hub held the user's key, and that
 * model is dead.
 */

import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import { getDbPool } from "../db/pool.js";
import { withDbTransaction } from "../db/tx.js";
import { getOrCreateUserByExternalId } from "../db/apps.js";
import { getTurnkeyResourceByIdForApp } from "../db/queries.js";
import { indexerForRequest } from "../indexer/forRequest.js";
import type { IndexerClient } from "../indexer/client.js";
import * as bitcoin from "bitcoinjs-lib";
import { partitionByProtection, type BtcUtxo } from "../bitcoin/protection.js";
import { dustThresholdForAddress } from "../bitcoin/dust.js";

type Utxo = BtcUtxo;

/**
 * Coin selection for a plain BTC send. Filters out protected UTXOs
 * (inscriptions, runes, risky_runes) BEFORE sorting, so an inscribed
 * or runed output can never be spent as fee fodder. Mirrors the
 * wallet's selectUtxos in apps/chrome-wallet/src/utils/btc-psbt.ts.
 *
 * Two failure modes, distinguishable by error code:
 *   - INSUFFICIENT_SPENDABLE_BTC: the spendable subset alone can't
 *     cover target+fee, but the protected UTXOs would have. The
 *     client surfaces "you have BTC, but it's locked in
 *     inscriptions/runes".
 *   - INSUFFICIENT_BALANCE: total balance (spendable + protected) is
 *     also under target+fee. Plain "not enough BTC".
 *
 * Unenriched UTXO lists behave exactly as before: partitionByProtection
 * returns the whole set as spendable, so selection is unchanged.
 *
 * Exported for unit tests; `buildUnsignedPsbt` is the production entry.
 */
export function selectUtxos(utxos: Utxo[], targetSats: number, feeSats: number): { selected: Utxo[]; totalInput: number } {
  const { spendable, spendableSats, protectedSats } = partitionByProtection(utxos);

  const needed = targetSats + feeSats;
  const sorted = [...spendable].sort((a, b) => b.value - a.value);
  const selected: Utxo[] = [];
  let total = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= needed) break;
  }

  if (total < needed) {
    // Distinguish the two failure modes so the client can point the
    // user at their locked inscriptions/runes when those funds would
    // otherwise have covered the send.
    if (protectedSats > 0 && spendableSats + protectedSats >= needed) {
      throw Object.assign(
        new Error(
          `Insufficient spendable BTC: have ${spendableSats} sats spendable + ${protectedSats} sats locked in inscriptions/runes, need ${needed} sats (${targetSats} + ${feeSats} fee). Move or sell the protected assets first.`,
        ),
        { code: "INSUFFICIENT_SPENDABLE_BTC", spendableSats, protectedSats },
      );
    }
    throw Object.assign(
      new Error(
        `Insufficient BTC balance: have ${total} sats, need ${needed} sats (${targetSats} + ${feeSats} fee)`,
      ),
      { code: "INSUFFICIENT_BALANCE" },
    );
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

  // bitcoinjs-lib v7+ takes bigint for PSBT value fields. Our utxo / fee
  // / change math runs in `number` (safe for any realistic BTC amount in
  // sats), so we only convert at the PSBT boundary.
  for (const utxo of selected) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.address.toOutputScript(fromAddress, network),
        value: BigInt(utxo.value),
      },
    });
  }

  psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });

  // Change goes back to the sender; the dust floor is keyed on the
  // sender's address script type (P2TR/P2WPKH relay below a flat 546).
  // Anything under it is non-standard and won't relay, so we drop the
  // change output and fold it into the fee.
  const changeDust = dustThresholdForAddress(fromAddress);
  if (changeSats > changeDust) {
    psbt.addOutput({ address: fromAddress, value: BigInt(changeSats) });
  }

  return {
    psbt,
    network,
    fromAddress,
    toAddress,
    amountSats,
    feeSats: actualFee,
    feeRate,
    changeSats: changeSats > changeDust ? changeSats : 0,
    inputCount: selected.length,
  };
}

const BuildBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  turnkeyResourceId: Type.String({ minLength: 1 }),
  toAddress: Type.String({ minLength: 1 }),
  amountSats: Type.Integer({ minimum: 546 }),
  feeRate: Type.Optional(Type.Number({ minimum: 1 })),
});

const BroadcastBody = Type.Object({
  /**
   * Hex-encoded, fully-finalised Bitcoin transaction. The Hub does
   * NOT extract transactions from PSBTs -- the client is expected to
   * call `psbt.finalizeAllInputs().extractTransaction().toHex()`
   * before posting. This keeps the route ignorant of PSBT shape and
   * therefore immune to malleability surprises.
   */
  signedTxHex: Type.String({ minLength: 1 }),
});

const EstimateFeeBody = Type.Object({
  externalUserId: Type.String({ minLength: 1 }),
  turnkeyResourceId: Type.String({ minLength: 1 }),
  toAddress: Type.String({ minLength: 1 }),
  amountSats: Type.Integer({ minimum: 546 }),
});

export const registerBtcTransactionRoutes: FastifyPluginAsync = async (server) => {
  // ── Build an unsigned PSBT ─────────────────────────────────────────────
  server.post(
    "/btc/build",
    {
      preHandler: server.enforceSessionForRoute("btc.build"),
      schema: {
        summary:
          "Build an unsigned BTC PSBT from the indexer's UTXO snapshot. The client signs and broadcasts.",
        tags: ["btc"],
        body: BuildBody,
      },
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;

      const db = getDbPool();
      const body = request.body as typeof BuildBody.static;

      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId: body.externalUserId }),
      );

      const resource = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: body.turnkeyResourceId, appId }),
      );
      if (!resource) return reply.notFound("Turnkey resource not found");
      if (resource.user_id !== user.id) return reply.forbidden("Resource does not belong to user");
      if (!resource.default_address) return reply.badRequest("Turnkey resource has no address");

      try {
        const result = await buildUnsignedPsbt({
          indexer,
          fromAddress: resource.default_address,
          toAddress: body.toAddress,
          amountSats: body.amountSats,
          feeRate: body.feeRate,
        });
        return {
          unsignedPsbtHex: result.psbt.toHex(),
          fromAddress: result.fromAddress,
          toAddress: body.toAddress,
          amountSats: body.amountSats,
          feeSats: result.feeSats,
          feeRate: result.feeRate,
          inputCount: result.inputCount,
          changeSats: result.changeSats,
        };
      } catch (err: any) {
        if (err.code === "NO_UTXOS") {
          return reply.code(409).send({ error: "NoUtxos", message: err.message });
        }
        if (err.code === "INSUFFICIENT_SPENDABLE_BTC") {
          return reply.code(409).send({
            error: "InsufficientSpendableBtc",
            message: err.message,
            spendableSats: err.spendableSats,
            protectedSats: err.protectedSats,
          });
        }
        if (err.code === "INSUFFICIENT_BALANCE") {
          return reply.code(409).send({ error: "InsufficientBalance", message: err.message });
        }
        return reply.code(502).send({ error: "PsbtBuildFailed", message: err.message });
      }
    },
  );

  // ── Broadcast a client-signed transaction ──────────────────────────────
  server.post(
    "/btc/broadcast",
    {
      schema: {
        summary: "Broadcast a hex-encoded, finalised BTC transaction via the indexer.",
        tags: ["btc"],
        body: BroadcastBody,
      },
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;

      const body = request.body as typeof BroadcastBody.static;
      try {
        const txid = (await indexer.broadcastBtcTransaction(body.signedTxHex)) as string;
        return { txid };
      } catch (err: any) {
        request.log.error({ err }, "btc.broadcast_failed");
        return reply.code(502).send({ error: "BroadcastFailed", message: err.message });
      }
    },
  );

  // ── Exact fee estimate (still useful for wallet UX previews) ───────────
  server.post(
    "/btc/estimate-fee",
    {
      preHandler: server.enforceSessionForRoute("btc.estimate-fee"),
      schema: {
        summary:
          "Estimate the fee for a planned BTC send using the actual UTXO set the indexer can see.",
        tags: ["btc"],
        body: EstimateFeeBody,
      },
    },
    async (request, reply) => {
      const appId = (request as any).app?.appId;
      if (!appId) return reply.unauthorized("Missing app context");

      const indexer = indexerForRequest(request, reply);
      if (!indexer) return;

      const db = getDbPool();
      const body = request.body as typeof EstimateFeeBody.static;

      const user = await withDbTransaction(db, (client) =>
        getOrCreateUserByExternalId(client, { appId, externalUserId: body.externalUserId }),
      );

      const resource = await withDbTransaction(db, (client) =>
        getTurnkeyResourceByIdForApp(client, { id: body.turnkeyResourceId, appId }),
      );
      if (!resource) return reply.notFound("Turnkey resource not found");
      if (resource.user_id !== user.id) return reply.forbidden("Resource does not belong to user");
      if (!resource.default_address) return reply.badRequest("Turnkey resource has no address");

      try {
        const result = await buildUnsignedPsbt({
          indexer,
          fromAddress: resource.default_address,
          toAddress: body.toAddress,
          amountSats: body.amountSats,
        });
        return {
          feeSats: result.feeSats,
          feeRate: result.feeRate,
          inputCount: result.inputCount,
          changeSats: result.changeSats,
        };
      } catch (err: any) {
        if (err.code === "NO_UTXOS") {
          return reply.code(409).send({ error: "NoUtxos", message: err.message });
        }
        if (err.code === "INSUFFICIENT_SPENDABLE_BTC") {
          return reply.code(409).send({
            error: "InsufficientSpendableBtc",
            message: err.message,
            spendableSats: err.spendableSats,
            protectedSats: err.protectedSats,
          });
        }
        if (err.code === "INSUFFICIENT_BALANCE") {
          return reply.code(409).send({ error: "InsufficientBalance", message: err.message });
        }
        return reply.code(502).send({ error: "EstimateFailed", message: err.message });
      }
    },
  );
};
