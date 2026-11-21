import sensible from "@fastify/sensible";
import Fastify from "fastify";
import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it, vi } from "vitest";

/**
 * POST /v1/btc/build must return a PSBT whose real fee (inputs - outputs)
 * covers the requested rate for the inputs it actually selected, and is
 * not less than the `feeSats` it reports. Coin selection used to run
 * against a 1-input fee estimate, so a send that needed more inputs could
 * pass selection with too little left for the larger fee.
 */

// BIP-173 testnet P2WPKH vector: no ECC backend needed, so these exercise
// coin selection on their own.
const P2WPKH = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  utxos: [] as Array<{ txid: string; vout: number; value: number }>,
  address: "",
}));

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../db/apps.js", async (orig) => ({
  ...(await orig<typeof import("../../db/apps.js")>()),
  getOrCreateUserByExternalId: async () => ({ id: "user-1" }),
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  getTurnkeyResourceByIdForApp: async () => ({ id: RESOURCE_ID, user_id: "user-1", default_address: mocks.address }),
}));
vi.mock("../../indexer/forRequest.js", async (orig) => ({
  ...(await orig<typeof import("../../indexer/forRequest.js")>()),
  indexerForRequest: () => ({
    getBtcAddressUtxos: async () => mocks.utxos,
    getBtcFeeEstimates: async () => ({}),
  }),
}));

import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { registerBtcTransactionRoutes } from "../btcTransactions.js";

async function buildServer() {
  const app = Fastify();
  app.decorate("config", { SESSION_ENFORCED_ROUTES: "" } as never);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerSessionAuth);
  await app.register(registerBtcTransactionRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

async function build(address: string, utxoValues: number[], amountSats: number, feeRate: number) {
  mocks.address = address;
  mocks.utxos = utxoValues.map((value, i) => ({ txid: String(i + 1).repeat(64).slice(0, 64), vout: 0, value }));
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/v1/btc/build",
    payload: { externalUserId: "u", turnkeyResourceId: RESOURCE_ID, toAddress: address, amountSats, feeRate },
  });
  await app.close();
  return res;
}

/** Refused for lack of funds, or the PSBT pays at least the requested rate and its reported fee. */
function expectFeeHonoured(res: Awaited<ReturnType<typeof build>>, feeRate: number) {
  if (res.statusCode === 409) {
    expect(res.json().error).toBe("InsufficientBalance");
    return;
  }
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  const psbt = bitcoin.Psbt.fromHex(body.unsignedPsbtHex, { network: bitcoin.networks.testnet });
  const inputs = psbt.data.inputs.reduce((s, i) => s + i.witnessUtxo!.value, 0n);
  const outputs = psbt.txOutputs.reduce((s, o) => s + o.value, 0n);
  const paid = Number(inputs - outputs);
  const vsize = 10.5 + psbt.inputCount * 57.5 + psbt.txOutputs.length * 43;
  expect(paid).toBeGreaterThanOrEqual(Math.ceil(vsize * feeRate));
  expect(paid).toBeGreaterThanOrEqual(body.feeSats);
}

describe("POST /v1/btc/build fee", () => {
  it("does not underpay when selection needs three inputs", async () => {
    // At 10 sat/vB the old 1-input estimate was 1,540 sats: 6,000 + 5,000 +
    // 1,000 passed selection for 10,000 sats, but three inputs cost 2,690.
    expectFeeHonoured(await build(P2WPKH, [6_000, 5_000, 1_000], 10_000, 10), 10);
  });

  it("does not underpay when selection needs two inputs", async () => {
    // At 1 sat/vB: 10,100 + 60 passed the old 154-sat estimate; the
    // 2-input, 1-output tx needs 169 sats.
    expectFeeHonoured(await build(P2WPKH, [10_100, 60], 10_000, 1), 1);
  });

  it("adds an input when the 1-input estimate under-selects", async () => {
    // At 10 sat/vB, 6,000 + 5,800 covers 10,000 + the old 1,540-sat estimate
    // but not 10,000 + the 2,115-sat fee of the 2-input tx with change, so
    // the old builder dropped the -315 change and paid 1,800 while
    // reporting 2,115. With no room for change, 1,800 is the fee.
    const res = await build(P2WPKH, [6_000, 5_800, 3_000], 10_000, 10);
    expectFeeHonoured(res, 10);
    expect(res.json()).toMatchObject({ inputCount: 2, feeSats: 1_800, changeSats: 0 });
  });

  it("still builds a send whose inputs cover the fee without change", async () => {
    // 2 inputs, 1 output at 25 sat/vB need 4,213 sats; 16,233 - 11,462
    // leaves 4,771. Too little for change, enough for the fee.
    const res = await build(P2WPKH, [11_049, 5_184], 11_462, 25);
    expectFeeHonoured(res, 25);
    expect(res.json()).toMatchObject({ inputCount: 2, feeSats: 4_771, changeSats: 0 });
  });
});
