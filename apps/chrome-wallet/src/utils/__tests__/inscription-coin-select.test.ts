/**
 * Inscription coin selection tests.
 *
 * Pin every error path and the protection invariants: a bug here can
 * either spend the wrong output (orphaning / burning the inscription)
 * or pull a protected output in as fee fodder. The pure-logic shape
 * lets us hammer adversarial UTXO configurations without bitcoinjs.
 */
import { describe, it, expect } from "vitest";
import type { BtcUtxo } from "../indexer";
import {
  InscriptionNotFoundError,
  InsufficientBtcForInscriptionSendError,
  selectUtxosForInscriptionSend
} from "../inscription-coin-select";

const INSC_ID = "aaaa0000i0";

function utxo(
  txid: string,
  vout: number,
  value: number,
  extras: {
    runes?: Array<{ rune_id: string; amount: string }>;
    risky_runes?: Array<{ rune_id: string; amount: string }>;
    inscriptions?: Array<{ id: string }>;
  } = {}
): BtcUtxo {
  return {
    txid,
    vout,
    value,
    status: { confirmed: true },
    ...extras
  } as BtcUtxo;
}

describe("selectUtxosForInscriptionSend — locating the inscribed UTXO", () => {
  it("finds the inscribed UTXO by satpoint outpoint", () => {
    const utxos = [
      utxo("insc", 1, 10000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("btc", 0, 50000)
    ];
    const r = selectUtxosForInscriptionSend({
      utxos,
      inscriptionId: INSC_ID,
      satpoint: "insc:1:0",
      feeSats: 500
    });
    expect(r.inscribedUtxo.txid).toBe("insc");
    expect(r.inscribedUtxo.vout).toBe(1);
    expect(r.inscribedValueSats).toBe(10000);
  });

  it("finds the inscribed UTXO by inscription id when satpoint is absent", () => {
    const utxos = [
      utxo("insc", 2, 7000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("btc", 0, 50000)
    ];
    const r = selectUtxosForInscriptionSend({
      utxos,
      inscriptionId: INSC_ID,
      feeSats: 500
    });
    expect(r.inscribedUtxo.txid).toBe("insc");
    expect(r.inscribedUtxo.vout).toBe(2);
  });

  it("prefers the satpoint outpoint over an id match", () => {
    // Same id reported on two outputs (shouldn't happen, but be exact):
    // the satpoint outpoint wins.
    const utxos = [
      utxo("wrong", 0, 1000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("right", 5, 9000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("btc", 0, 50000)
    ];
    const r = selectUtxosForInscriptionSend({
      utxos,
      inscriptionId: INSC_ID,
      satpoint: "right:5:0",
      feeSats: 500
    });
    expect(r.inscribedUtxo.txid).toBe("right");
    expect(r.inscribedUtxo.vout).toBe(5);
  });

  it("throws InscriptionNotFoundError when neither satpoint nor id matches", () => {
    const utxos = [utxo("btc", 0, 50000)];
    try {
      selectUtxosForInscriptionSend({
        utxos,
        inscriptionId: INSC_ID,
        satpoint: "missing:0:0",
        feeSats: 500
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InscriptionNotFoundError);
      expect((err as InscriptionNotFoundError).code).toBe("INSCRIPTION_NOT_FOUND");
    }
  });
});

describe("selectUtxosForInscriptionSend — fee funding", () => {
  it("pulls a plain BTC UTXO to cover the fee", () => {
    const utxos = [
      utxo("insc", 0, 10000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("btc", 0, 50000)
    ];
    const r = selectUtxosForInscriptionSend({
      utxos,
      inscriptionId: INSC_ID,
      satpoint: "insc:0:0",
      feeSats: 500
    });
    expect(r.btcInputs.map((u) => u.txid)).toEqual(["btc"]);
    expect(r.totalInputSats).toBe(60000);
  });

  it("picks largest plain BTC first to minimize input count", () => {
    const utxos = [
      utxo("insc", 0, 10000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("small", 0, 800),
      utxo("big", 0, 40000),
      utxo("mid", 0, 5000)
    ];
    const r = selectUtxosForInscriptionSend({
      utxos,
      inscriptionId: INSC_ID,
      satpoint: "insc:0:0",
      feeSats: 1000
    });
    expect(r.btcInputs).toHaveLength(1);
    expect(r.btcInputs[0]!.txid).toBe("big");
  });

  it("aggregates plain BTC UTXOs when one is not enough", () => {
    const utxos = [
      utxo("insc", 0, 10000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("a", 0, 600),
      utxo("b", 0, 600)
    ];
    const r = selectUtxosForInscriptionSend({
      utxos,
      inscriptionId: INSC_ID,
      satpoint: "insc:0:0",
      feeSats: 1000
    });
    expect(r.btcInputs).toHaveLength(2);
    expect(r.totalInputSats).toBe(10000 + 1200);
  });
});

describe("selectUtxosForInscriptionSend — protection invariants", () => {
  it("never uses another inscribed UTXO as fee fodder", () => {
    const utxos = [
      utxo("insc", 0, 10000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("other-insc", 0, 50000, { inscriptions: [{ id: "bbbb1111i0" }] })
    ];
    try {
      selectUtxosForInscriptionSend({
        utxos,
        inscriptionId: INSC_ID,
        satpoint: "insc:0:0",
        feeSats: 500
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientBtcForInscriptionSendError);
    }
  });

  it("never uses a runed UTXO as fee fodder", () => {
    const utxos = [
      utxo("insc", 0, 10000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("runed", 0, 50000, { runes: [{ rune_id: "1:1", amount: "100" }] })
    ];
    expect(() =>
      selectUtxosForInscriptionSend({
        utxos,
        inscriptionId: INSC_ID,
        satpoint: "insc:0:0",
        feeSats: 500
      })
    ).toThrow(InsufficientBtcForInscriptionSendError);
  });
});

describe("selectUtxosForInscriptionSend — error paths", () => {
  it("throws InsufficientBtcForInscriptionSendError with the spendable ceiling", () => {
    const utxos = [
      utxo("insc", 0, 10000, { inscriptions: [{ id: INSC_ID }] }),
      utxo("btc", 0, 300)
    ];
    try {
      selectUtxosForInscriptionSend({
        utxos,
        inscriptionId: INSC_ID,
        satpoint: "insc:0:0",
        feeSats: 5000
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientBtcForInscriptionSendError);
      expect((err as InsufficientBtcForInscriptionSendError).code).toBe(
        "INSUFFICIENT_BTC_FOR_INSCRIPTION_SEND"
      );
      expect((err as InsufficientBtcForInscriptionSendError).haveSats).toBe(300);
      expect((err as InsufficientBtcForInscriptionSendError).needSats).toBe(5000);
    }
  });
});
