import { describe, expect, it, vi } from "vitest";

import { isAccountNotFound, resolveDestTokenAccount } from "../tokenAccount.js";

const DERIVED = new Uint8Array(32).fill(1);
const INDEXED = new Uint8Array(32).fill(2);

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { error: { code, message } });

describe("resolveDestTokenAccount", () => {
  it("uses the account the indexer names without probing", async () => {
    const probe = vi.fn();
    await expect(resolveDestTokenAccount({ indexedDestAta: INDEXED, derivedDestAta: DERIVED, probe })).resolves.toEqual({ destAta: INDEXED, create: false });
    expect(probe).not.toHaveBeenCalled();
  });

  // Mainnet 2026-11-25, tx d7ff419a…: the recipient's aUSD ATA held 0, the indexer listed no row for it, and the
  // non-idempotent Create failed with "an account with the same address already exists".
  it("skips the create when the chain holds an empty account the indexer leaves out", async () => {
    const probe = vi.fn(async () => ({ lamports: 586, data: [], owner: [], is_executable: false }));
    await expect(resolveDestTokenAccount({ indexedDestAta: null, derivedDestAta: DERIVED, probe })).resolves.toEqual({ destAta: DERIVED, create: false });
    expect(probe).toHaveBeenCalledWith(DERIVED);
  });

  it.each([
    ["the indexer's not-found", rpcError(-32002, "account aa… not found")],
    ["a validator's not-found", rpcError(404, "Account not found")],
    ["an older node's message", new Error("account is not in database")],
  ])("creates the account on %s", async (_, err) => {
    const onProbeError = vi.fn();
    const probe = vi.fn(async () => {
      throw err;
    });
    await expect(resolveDestTokenAccount({ indexedDestAta: null, derivedDestAta: DERIVED, probe, onProbeError })).resolves.toEqual({ destAta: DERIVED, create: true });
    expect(onProbeError).not.toHaveBeenCalled();
  });

  it("keeps the create and reports a probe that fails for another reason", async () => {
    const onProbeError = vi.fn();
    const err = new Error("fetch failed");
    const probe = vi.fn(async () => {
      throw err;
    });
    await expect(resolveDestTokenAccount({ indexedDestAta: null, derivedDestAta: DERIVED, probe, onProbeError })).resolves.toEqual({ destAta: DERIVED, create: true });
    expect(onProbeError).toHaveBeenCalledWith(err);
  });
});

describe("isAccountNotFound", () => {
  it("does not read a transport failure as absent", () => {
    expect(isAccountNotFound(new Error("fetch failed"))).toBe(false);
    expect(isAccountNotFound(rpcError(-32603, "internal error"))).toBe(false);
  });
});
