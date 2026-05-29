/**
 * Tests for the rune-transfer PSBT builder.
 *
 * Verifies the OUTPUT LAYOUT INVARIANT: every emitted PSBT MUST have
 *   output[0] = OP_RETURN runestone, value 0
 *   output[1] = recipient, dust value
 *   output[2] = sender change, change value
 *
 * Plus: the embedded runestone script matches the canonical encoder
 * output for the same edict + pointer parameters. A drift here would
 * mean the runestone disagrees with the PSBT outputs and the user
 * could lose rune balance silently.
 */
import { describe, it, expect } from "vitest";
import { buildUnsignedRunePsbt, estimateRuneTxSize } from "../rune-psbt";
import { buildRunestoneOpReturn, bytesToHex } from "../runestone";
import type { BtcUtxo } from "../indexer";

const RUNE_A = "73393:191";

// bitcoinjs validates txids as 32-byte hex; use distinguishable
// hex strings padded out so PSBT addInput accepts them.
function fullTxid(seed: string): string {
  return seed.padEnd(64, "0");
}

function makeUtxo(
  txidSeed: string,
  vout: number,
  value: number,
  extras: {
    runes?: Array<{ rune_id: string; amount: string }>;
  } = {}
): BtcUtxo {
  return {
    txid: fullTxid(txidSeed),
    vout,
    value,
    status: { confirmed: true },
    ...extras
  } as BtcUtxo;
}

function mockIndexer(utxos: BtcUtxo[], feeRate = 5) {
  return {
    getBtcAddressUtxos: async () => utxos,
    getBtcFeeEstimates: async () => ({ "1": feeRate, "3": feeRate, "6": feeRate })
  } as any;
}

// Sender + recipient: both valid testnet P2TR addresses. Using the
// same one for both isolates the rune logic from address-parsing
// edge cases (bitcoinjs needs a real bech32 to derive output script,
// so we can't synthesize garbage strings).
const FROM = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";
const TO = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";

describe("buildUnsignedRunePsbt — output layout invariant", () => {
  it("always emits exactly 3 outputs in the canonical order", async () => {
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      makeUtxo("b", 0, 50000)
    ];
    const r = await buildUnsignedRunePsbt({
      indexer: mockIndexer(utxos),
      fromAddress: FROM,
      toAddress: TO,
      runeId: RUNE_A,
      amount: 50n,
      feeRate: 5
    });
    const tx = (r.psbt as any).__CACHE.__TX;
    expect(tx.outs).toHaveLength(3);
    // Output 0: OP_RETURN runestone (value 0)
    expect(Number(tx.outs[0].value)).toBe(0);
    expect(tx.outs[0].script[0]).toBe(0x6a); // OP_RETURN
    expect(tx.outs[0].script[1]).toBe(0x5d); // OP_13 (runestone marker)
    // Output 1: recipient, dust value
    expect(Number(tx.outs[1].value)).toBe(546);
    // Output 2: change, > dust
    expect(Number(tx.outs[2].value)).toBeGreaterThanOrEqual(546);
  });

  it("runestone OP_RETURN matches canonical encoder output (with pointer)", async () => {
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      makeUtxo("b", 0, 50000)
    ];
    const r = await buildUnsignedRunePsbt({
      indexer: mockIndexer(utxos),
      fromAddress: FROM,
      toAddress: TO,
      runeId: RUNE_A,
      amount: 50n,
      feeRate: 5
    });
    const expected = buildRunestoneOpReturn(
      [{ runeId: RUNE_A, amount: 50n, output: 1 }],
      { pointer: 2 }
    );
    expect(r.runestoneScriptHex).toBe(bytesToHex(expected));
    // And matches the PSBT output[0] verbatim
    const tx = (r.psbt as any).__CACHE.__TX;
    expect(bytesToHex(new Uint8Array(tx.outs[0].script))).toBe(bytesToHex(expected));
  });

  it("OMITS pointer when leftover rune is zero", async () => {
    // Exactly the full balance is sent -- no leftover -> no pointer.
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      makeUtxo("b", 0, 50000)
    ];
    const r = await buildUnsignedRunePsbt({
      indexer: mockIndexer(utxos),
      fromAddress: FROM,
      toAddress: TO,
      runeId: RUNE_A,
      amount: 100n, // exact balance
      feeRate: 5
    });
    expect(r.leftoverRune).toBe(0n);
    const expected = buildRunestoneOpReturn(
      [{ runeId: RUNE_A, amount: 100n, output: 1 }]
    );
    expect(r.runestoneScriptHex).toBe(bytesToHex(expected));
  });
});

describe("buildUnsignedRunePsbt — fee + change accounting", () => {
  it("change = totalInput - recipientDust - fee", async () => {
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      makeUtxo("b", 0, 50000)
    ];
    const r = await buildUnsignedRunePsbt({
      indexer: mockIndexer(utxos),
      fromAddress: FROM,
      toAddress: TO,
      runeId: RUNE_A,
      amount: 50n,
      feeRate: 5
    });
    // totalInput = 546 + 50000 = 50546
    // recipient = 546
    // change should be 50546 - 546 - fee = 50000 - fee
    expect(r.changeSats).toBe(50546 - 546 - r.feeSats);
    // Sanity: fee is positive and small
    expect(r.feeSats).toBeGreaterThan(0);
    expect(r.feeSats).toBeLessThan(10000);
  });

  it("inputCount + counts metadata are consistent with the PSBT", async () => {
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "40" }] }),
      makeUtxo("b", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "30" }] }),
      makeUtxo("c", 0, 100000) // BTC top-up
    ];
    const r = await buildUnsignedRunePsbt({
      indexer: mockIndexer(utxos),
      fromAddress: FROM,
      toAddress: TO,
      runeId: RUNE_A,
      amount: 60n,
      feeRate: 5
    });
    expect(r.runedInputCount).toBe(2);
    expect(r.btcInputCount).toBe(1);
    expect(r.inputCount).toBe(3);
    const tx = (r.psbt as any).__CACHE.__TX;
    expect(tx.ins).toHaveLength(3);
  });
});

describe("buildUnsignedRunePsbt — error paths", () => {
  it("propagates INSUFFICIENT_RUNE_BALANCE from coin-select", async () => {
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "10" }] }),
      makeUtxo("b", 0, 50000)
    ];
    await expect(
      buildUnsignedRunePsbt({
        indexer: mockIndexer(utxos),
        fromAddress: FROM,
        toAddress: TO,
        runeId: RUNE_A,
        amount: 100n,
        feeRate: 5
      })
    ).rejects.toThrow(/Insufficient rune balance/);
  });

  it("propagates INSUFFICIENT_BTC_FOR_RUNE_SEND when fees can't be covered", async () => {
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] })
    ];
    await expect(
      buildUnsignedRunePsbt({
        indexer: mockIndexer(utxos),
        fromAddress: FROM,
        toAddress: TO,
        runeId: RUNE_A,
        amount: 50n,
        feeRate: 100 // high fee -> no top-up available
      })
    ).rejects.toThrow(/Insufficient BTC/);
  });

  it("rejects amount = 0n explicitly (would emit a no-op edict)", async () => {
    const utxos = [
      makeUtxo("a", 0, 546, { runes: [{ rune_id: RUNE_A, amount: "100" }] }),
      makeUtxo("b", 0, 50000)
    ];
    await expect(
      buildUnsignedRunePsbt({
        indexer: mockIndexer(utxos),
        fromAddress: FROM,
        toAddress: TO,
        runeId: RUNE_A,
        amount: 0n,
        feeRate: 5
      })
    ).rejects.toThrow(/> 0/);
  });

  it("rejects when the address has no UTXOs at all", async () => {
    await expect(
      buildUnsignedRunePsbt({
        indexer: mockIndexer([]),
        fromAddress: FROM,
        toAddress: TO,
        runeId: RUNE_A,
        amount: 50n,
        feeRate: 5
      })
    ).rejects.toThrow(/No UTXOs/);
  });
});

describe("estimateRuneTxSize", () => {
  it("grows monotonically with input count", () => {
    expect(estimateRuneTxSize(2)).toBeGreaterThan(estimateRuneTxSize(1));
    expect(estimateRuneTxSize(5)).toBeGreaterThan(estimateRuneTxSize(2));
  });

  it("returns a sensible vbyte value for a typical 2-input rune transfer", () => {
    // Expect ~210 vbytes ballpark; pin a range rather than exact
    // so adding ~10 vbytes for a richer runestone payload doesn't
    // break tests.
    const s = estimateRuneTxSize(2);
    expect(s).toBeGreaterThan(180);
    expect(s).toBeLessThan(260);
  });
});
