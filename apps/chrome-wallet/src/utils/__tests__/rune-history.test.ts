import { describe, it, expect } from "vitest";
import { indexRuneTxsByTxid, runeRowLabel, formatRuneDelta } from "../rune-history";
import type { BtcRuneTransaction } from "../indexer";

function rt(overrides: Partial<BtcRuneTransaction> = {}): BtcRuneTransaction {
  return {
    txid: "abc",
    kind: "transfer",
    rune_id: "840000:1",
    spaced_name: "UNCOMMON\u2022GOODS",
    delta: "50",
    ...overrides,
  };
}

describe("indexRuneTxsByTxid", () => {
  it("maps by txid and keeps the first entry per txid", () => {
    const a = rt({ txid: "t1", delta: "10" });
    const b = rt({ txid: "t1", delta: "20" });
    const c = rt({ txid: "t2", delta: "-5" });
    const map = indexRuneTxsByTxid([a, b, c]);
    expect(map.size).toBe(2);
    expect(map.get("t1")!.delta).toBe("10");
    expect(map.get("t2")!.delta).toBe("-5");
  });

  it("skips entries without a usable txid", () => {
    const map = indexRuneTxsByTxid([rt({ txid: "" }), rt({ txid: "ok" })]);
    expect(map.size).toBe(1);
    expect(map.has("ok")).toBe(true);
  });
});

describe("runeRowLabel", () => {
  it("labels inbound vs outbound transfers from delta sign", () => {
    expect(runeRowLabel(rt({ delta: "50" }))).toBe("Received UNCOMMON\u2022GOODS");
    expect(runeRowLabel(rt({ delta: "-50" }))).toBe("Sent UNCOMMON\u2022GOODS");
  });

  it("labels mint / etch / burn by kind", () => {
    expect(runeRowLabel(rt({ kind: "mint" }))).toBe("Minted UNCOMMON\u2022GOODS");
    expect(runeRowLabel(rt({ kind: "etch" }))).toBe("Etched UNCOMMON\u2022GOODS");
    expect(runeRowLabel(rt({ kind: "burn" }))).toBe("Burned UNCOMMON\u2022GOODS");
  });

  it("falls back to a generic transfer label on a zero/unparseable delta", () => {
    expect(runeRowLabel(rt({ delta: "0" }))).toBe("UNCOMMON\u2022GOODS Transfer");
  });

  it("uses 'Rune' when spaced_name is missing", () => {
    expect(runeRowLabel(rt({ spaced_name: "", delta: "1" }))).toBe("Received Rune");
  });
});

describe("formatRuneDelta", () => {
  it("formats with divisibility when known", () => {
    expect(formatRuneDelta("1500000000000000000", 18)).toEqual({
      direction: "in",
      amountLabel: "+1.5",
    });
    expect(formatRuneDelta("-150", 2)).toEqual({
      direction: "out",
      amountLabel: "-1.5",
    });
  });

  it("falls back to raw minor units when divisibility is unknown", () => {
    expect(formatRuneDelta("-1000000")).toEqual({
      direction: "out",
      amountLabel: "-1000000",
    });
  });

  it("treats zero as neutral with no sign", () => {
    expect(formatRuneDelta("0", 0)).toEqual({ direction: "neutral", amountLabel: "0" });
  });

  it("returns null for an unparseable delta without divisibility", () => {
    expect(formatRuneDelta("not-a-number")).toBeNull();
  });
});
