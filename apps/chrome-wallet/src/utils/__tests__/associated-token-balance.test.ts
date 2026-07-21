import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { fetchAssociatedTokenBalance } from "../arch-rpc";

const mint = "ByGq5t5rdDcVUBKcnNcB2qNA5DPYWwFr15CFZLzq4DTz";
const ownerPublicKey = "11".repeat(32);
const tokenProgram = [
  6, 221, 246, 225, 185, 234, 132, 65, 44, 16, 184, 223, 2, 28, 16, 15,
  200, 135, 25, 7, 195, 9, 195, 53, 53, 222, 32, 156, 52, 23, 99, 191,
];

function tokenAccountData(opts: { mintMatches?: boolean; ownerMatches?: boolean; amount?: bigint } = {}) {
  const data = new Uint8Array(165);
  data.set(
    opts.mintMatches === false
      ? new Uint8Array(32).fill(2)
      : bs58.decode(mint),
    0,
  );
  data.fill(opts.ownerMatches === false ? 3 : 0x11, 32, 64);
  const amount = opts.amount ?? 123_456_789n;
  const view = new DataView(data.buffer);
  view.setUint32(64, Number(amount & 0xffff_ffffn), true);
  view.setUint32(68, Number(amount >> 32n), true);
  return Array.from(data);
}

function indexerReturning(account: unknown) {
  return {
    rpc: async () => account,
  } as any;
}

describe("fetchAssociatedTokenBalance", () => {
  it("returns the raw balance only after matching mint and owner", async () => {
    await expect(
      fetchAssociatedTokenBalance(
        indexerReturning({
          data: tokenAccountData({ amount: 0x1_0000_0001n }),
          owner: tokenProgram,
        }),
        mint,
        mint,
        ownerPublicKey,
      ),
    ).resolves.toEqual({ kind: "found", amount: 0x1_0000_0001n });
  });

  it("reports a missing or short account without inventing a balance", async () => {
    await expect(
      fetchAssociatedTokenBalance(indexerReturning(null), mint, mint, ownerPublicKey),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(
      fetchAssociatedTokenBalance(
        indexerReturning({ data: [1, 2, 3], owner: tokenProgram }),
        mint,
        mint,
        ownerPublicKey,
      ),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("rejects an account for another mint or wallet", async () => {
    await expect(
      fetchAssociatedTokenBalance(
        indexerReturning({
          data: tokenAccountData({ mintMatches: false }),
          owner: tokenProgram,
        }),
        mint,
        mint,
        ownerPublicKey,
      ),
    ).resolves.toMatchObject({ kind: "error" });
    await expect(
      fetchAssociatedTokenBalance(
        indexerReturning({
          data: tokenAccountData({ ownerMatches: false }),
          owner: tokenProgram,
        }),
        mint,
        mint,
        ownerPublicKey,
      ),
    ).resolves.toMatchObject({ kind: "error" });
    await expect(
      fetchAssociatedTokenBalance(
        indexerReturning({
          data: tokenAccountData(),
          owner: new Array(32).fill(0),
        }),
        mint,
        mint,
        ownerPublicKey,
      ),
    ).resolves.toMatchObject({ kind: "error" });
  });

  it("returns an error when the account lookup fails", async () => {
    const failingIndexer = {
      rpc: async () => {
        throw new Error("timeout");
      },
    } as any;
    await expect(
      fetchAssociatedTokenBalance(failingIndexer, mint, mint, ownerPublicKey),
    ).resolves.toMatchObject({ kind: "error", reason: "timeout" });
  });
});
