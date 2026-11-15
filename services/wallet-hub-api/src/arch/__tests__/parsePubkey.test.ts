import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import bs58 from "bs58";
import { parsePubkey } from "../arch.js";

describe("parsePubkey", () => {
  it("decodes a 32-byte base58 address", () => {
    const address = bs58.encode(Buffer.alloc(32, 7));
    expect(Array.from(parsePubkey(address))).toEqual(Array.from(Buffer.alloc(32, 7)));
  });

  it("rejects a non-base58 address as a 400", async () => {
    const app = Fastify();
    app.get("/addr", async () => {
      parsePubkey("0");
      return { ok: true };
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/addr" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid base58 address");
    expect(res.body).not.toContain("Non-base58");
    await app.close();
  });
});
