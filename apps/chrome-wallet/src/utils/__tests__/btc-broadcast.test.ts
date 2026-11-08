import { describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { broadcastOrReconcile } from "../btc-broadcast";

function rawTx(): { hex: string; txid: string } {
  const tx = new bitcoin.Transaction();
  tx.addInput(new Uint8Array(32).fill(7), 0);
  tx.addOutput(new Uint8Array([0x51]), 1_000n);
  return { hex: tx.toHex(), txid: tx.getId() };
}

describe("broadcastOrReconcile", () => {
  it("returns the indexer's txid on a normal broadcast", async () => {
    const { hex, txid } = rawTx();
    const indexer = { broadcastBtc: vi.fn().mockResolvedValue(txid), getBtcTransaction: vi.fn() };
    await expect(broadcastOrReconcile(indexer, hex)).resolves.toBe(txid);
    expect(indexer.getBtcTransaction).not.toHaveBeenCalled();
  });

  it("reports sent when the broadcast errors but the indexer already has this txid", async () => {
    const { hex, txid } = rawTx();
    const indexer = {
      broadcastBtc: vi.fn().mockRejectedValue(new Error("txn-already-known")),
      getBtcTransaction: vi.fn().mockResolvedValue({ txid }),
    };
    await expect(broadcastOrReconcile(indexer, hex)).resolves.toBe(txid);
    expect(indexer.getBtcTransaction).toHaveBeenCalledWith(txid);
    expect(indexer.broadcastBtc).toHaveBeenCalledTimes(1);
  });

  it("rethrows the broadcast error when the txid is unknown", async () => {
    const { hex } = rawTx();
    const indexer = {
      broadcastBtc: vi.fn().mockRejectedValue(new Error("bad-txns-inputs-missingorspent")),
      getBtcTransaction: vi.fn().mockRejectedValue(new Error("404")),
    };
    await expect(broadcastOrReconcile(indexer, hex)).rejects.toThrow("bad-txns-inputs-missingorspent");
  });
});
