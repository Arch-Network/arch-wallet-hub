import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

/**
 * Transfer amounts must be plain base-10 u64 strings. `BigInt()` accepts
 * "0x..", "0b..", "0o.." and surrounding whitespace, and `setBigUint64`
 * wraps negatives and >= 2^64 modulo 2^64, so any of those used to reach
 * the instruction encoder as a different number than the one displayed.
 */

const getOrCreateUserByExternalId = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("handler must reject before touching the DB");
  }),
);

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../db/apps.js", async (orig) => ({
  ...(await orig<typeof import("../../db/apps.js")>()),
  getOrCreateUserByExternalId,
}));

import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { parseU64Decimal, registerSigningRequestRoutes } from "../signingRequests.js";

const U64_MAX = "18446744073709551615";
const BAD = ["0x10", "0b101", "0o7", "-1", " 5", "5 ", "1e3", "1.5", "", "18446744073709551616", "99999999999999999999", "123456789012345678901"];

describe("parseU64Decimal", () => {
  it.each(BAD)("rejects %j", (v) => {
    expect(() => parseU64Decimal(v, "amount")).toThrow();
  });

  it("accepts 0 and u64 max exactly", () => {
    expect(parseU64Decimal("0", "amount")).toBe(0n);
    expect(parseU64Decimal(U64_MAX, "amount")).toBe((1n << 64n) - 1n);
  });
});

describe("POST /signing-requests amount validation", () => {
  async function buildServer() {
    const app = Fastify();
    app.decorate("config", { SESSION_ENFORCED_ROUTES: "" } as never);
    app.addHook("onRequest", async (request) => {
      (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
    });
    await app.register(sensible);
    await app.register(registerSessionAuth);
    await app.register(registerSigningRequestRoutes, { prefix: "/v1" });
    await app.ready();
    return app;
  }

  const signer = { kind: "external", taprootAddress: "tb1pexample" };

  it.each(BAD)("400s arch.transfer lamports %j", async (lamports) => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/signing-requests",
      payload: { externalUserId: "u", signer, action: { type: "arch.transfer", toAddress: "x", lamports } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("no longer serves the removed server-side sign-with-turnkey route", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/signing-requests/11111111-1111-4111-8111-111111111111/sign-with-turnkey",
      payload: { externalUserId: "u" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it.each(BAD)("400s arch.token_transfer amount %j", async (amount) => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/signing-requests",
      payload: {
        externalUserId: "u",
        signer,
        action: { type: "arch.token_transfer", mintAddress: "m", toAddress: "x", amount },
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  const swap = {
    type: "swap.rune_native",
    programId: "p",
    poolAddress: "q",
    runeId: { block: "840000", tx: 1 },
    baseToQuote: true,
    amountIn: "1000",
    minOut: "1",
    nonce: "0",
    userInput: { txid: "a".repeat(64), vout: 0 },
    recipientScriptHex: "5120",
    feeRateSatVb: "5",
  };
  const addLiquidity = {
    type: "pool.add_liquidity",
    programId: "p",
    poolAddress: "q",
    positionAddress: "r",
    baseTxid: "a".repeat(64),
    baseVout: 0,
    quoteTxid: "b".repeat(64),
    quoteVout: 1,
    minConfirmations: 6,
  };

  async function postAction(action: unknown) {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/signing-requests",
      payload: { externalUserId: "u", signer, action },
    });
    await app.close();
    return res.statusCode;
  }

  // Valid payloads pass validation and reach the (mocked, throwing) DB, so the
  // 400s below come from the field under test.
  it.each([
    ["swap at the boundaries", { ...swap, amountIn: U64_MAX, minOut: "0", nonce: U64_MAX, feeRateSatVb: "1000" }],
    ["swap with zero amounts", { ...swap, amountIn: "0", minOut: "0", nonce: "0", feeRateSatVb: "0" }],
    ["add_liquidity at u32 max", { ...addLiquidity, baseVout: 2 ** 32 - 1, quoteVout: 2 ** 32 - 1, minConfirmations: 2 ** 32 - 1 }],
  ])("accepts %s", async (_name, action) => {
    getOrCreateUserByExternalId.mockClear();
    expect(await postAction(action)).toBe(500);
    expect(getOrCreateUserByExternalId).toHaveBeenCalledTimes(1);
  });

  describe.each(["amountIn", "minOut", "nonce", "feeRateSatVb"])("swap.rune_native %s", (field) => {
    it.each(BAD)("400s %j", async (value) => {
      expect(await postAction({ ...swap, [field]: value })).toBe(400);
    });
  });

  it.each(["1001", U64_MAX])("400s swap.rune_native feeRateSatVb %j above the protocol ceiling", async (feeRateSatVb) => {
    expect(await postAction({ ...swap, feeRateSatVb })).toBe(400);
  });

  const BAD_U32 = [-1, 1.5, 2 ** 32];
  it.each(BAD_U32)("400s swap.rune_native userInput.vout %j", async (vout) => {
    expect(await postAction({ ...swap, userInput: { ...swap.userInput, vout } })).toBe(400);
  });
  it.each(BAD_U32)("400s swap.rune_native runeId.tx %j", async (tx) => {
    expect(await postAction({ ...swap, runeId: { ...swap.runeId, tx } })).toBe(400);
  });
  describe.each(["baseVout", "quoteVout", "minConfirmations"])("pool.add_liquidity %s", (field) => {
    it.each(BAD_U32)("400s %j", async (value) => {
      expect(await postAction({ ...addLiquidity, [field]: value })).toBe(400);
    });
  });
});
