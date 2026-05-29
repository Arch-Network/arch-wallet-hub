/**
 * Runestone encoder tests.
 *
 * Two test tiers:
 *   1. LEB128 varint pinning -- every other test depends on this
 *      being byte-perfect. Includes u128 max to verify BigInt math.
 *   2. Golden-file vectors from LIVE TESTNET rune transfer
 *      transactions. If the encoder ever drifts from real-network
 *      behavior, these break and tell us before a user does.
 *
 * Reference vectors (verified at block height 136,818, network=testnet):
 *
 *   tx aecdee36... vout=0  6a5d0800b1bd04bf011302
 *     = transfer 19 of UNCOMMON\u2022GOODS (73393:191) to output index 2
 *
 *   tx 24f8d967... vout=0  6a5d0800b1bd04bf010502
 *     = transfer 5 of UNCOMMON\u2022GOODS to output index 2
 *
 * Adversarial cases pinned because a silent encoding bug here
 * loses the user's runes irrecoverably (ord treats a malformed
 * runestone as a cenotaph; inputs are burned, not refunded).
 */
import { describe, it, expect } from "vitest";
import {
  bytesToHex,
  buildRunestoneOpReturn,
  encodeRunestonePayload,
  encodeVarint,
  formatRuneId,
  parseRuneId
} from "../runestone";

describe("encodeVarint (LEB128 unsigned)", () => {
  it("encodes 0 as a single zero byte", () => {
    expect(bytesToHex(encodeVarint(0n))).toBe("00");
  });

  it("encodes 127 as a single 0x7f (top of one-byte range)", () => {
    expect(bytesToHex(encodeVarint(127n))).toBe("7f");
  });

  it("encodes 128 as two bytes (overflows into a second 7-bit group)", () => {
    expect(bytesToHex(encodeVarint(128n))).toBe("8001");
  });

  it("encodes 16383 as the largest two-byte value", () => {
    expect(bytesToHex(encodeVarint(16383n))).toBe("ff7f");
  });

  it("encodes 16384 as three bytes", () => {
    expect(bytesToHex(encodeVarint(16384n))).toBe("808001");
  });

  it("matches the on-chain encoding of block 73393 (UNCOMMON\u2022GOODS etching height)", () => {
    expect(bytesToHex(encodeVarint(73393n))).toBe("b1bd04");
  });

  it("matches the on-chain encoding of tx 191 within that block", () => {
    expect(bytesToHex(encodeVarint(191n))).toBe("bf01");
  });

  it("encodes u128 max (2^128 - 1) as 19 bytes", () => {
    const u128Max = (1n << 128n) - 1n;
    const bytes = encodeVarint(u128Max);
    expect(bytes.length).toBe(19);
    // Every byte except the last has the high bit set
    for (let i = 0; i < 18; i++) {
      expect(bytes[i]! & 0x80).toBe(0x80);
    }
    expect(bytes[18]! & 0x80).toBe(0);
  });

  it("rejects negative values explicitly (silent drop would burn runes)", () => {
    expect(() => encodeVarint(-1n)).toThrow(/non-negative/);
  });
});

describe("parseRuneId / formatRuneId", () => {
  it("round-trips a canonical id", () => {
    const id = parseRuneId("73393:191");
    expect(id.block).toBe(73393n);
    expect(id.tx).toBe(191);
    expect(formatRuneId(id)).toBe("73393:191");
  });

  it("rejects garbage shapes", () => {
    expect(() => parseRuneId("not-an-id")).toThrow();
    expect(() => parseRuneId("123")).toThrow();
    expect(() => parseRuneId("123:")).toThrow();
    expect(() => parseRuneId(":456")).toThrow();
  });

  it("supports a 0-block id (genesis-block runes -- defensive)", () => {
    expect(parseRuneId("0:0")).toEqual({ block: 0n, tx: 0 });
  });

  it("supports a u64-block id (deep-future mainnet)", () => {
    // ~2.4 billion -- comfortable headroom even at 2026 + decades of blocks.
    const id = parseRuneId("2400000000:0");
    expect(id.block).toBe(2400000000n);
  });
});

describe("encodeRunestonePayload — golden vectors from live testnet", () => {
  // After the OP_RETURN OP_13 push-prefix bytes, the payload alone is:
  //   00 b1bd04 bf01 13 02
  // for the `aecdee36...` transfer.
  it("matches aecdee36... (transfer 19 of 73393:191 to output 2)", () => {
    const payload = encodeRunestonePayload([
      { runeId: "73393:191", amount: 19n, output: 2 }
    ]);
    expect(bytesToHex(payload)).toBe("00b1bd04bf011302");
  });

  it("matches 24f8d967... (transfer 5 of 73393:191 to output 2)", () => {
    const payload = encodeRunestonePayload([
      { runeId: "73393:191", amount: 5n, output: 2 }
    ]);
    expect(bytesToHex(payload)).toBe("00b1bd04bf010502");
  });

  it("matches aecdee36... full OP_RETURN script bytes", () => {
    const script = buildRunestoneOpReturn([
      { runeId: "73393:191", amount: 19n, output: 2 }
    ]);
    expect(bytesToHex(script)).toBe("6a5d0800b1bd04bf011302");
  });

  it("matches 24f8d967... full OP_RETURN script bytes", () => {
    const script = buildRunestoneOpReturn([
      { runeId: "73393:191", amount: 5n, output: 2 }
    ]);
    expect(bytesToHex(script)).toBe("6a5d0800b1bd04bf010502");
  });
});

describe("encodeRunestonePayload — multi-edict block_delta encoding", () => {
  it("uses delta=0 for the second edict on the same rune", () => {
    // Two edicts of the same rune: block_delta is the block on
    // the first, 0 on the second. ord interprets a 0 block_delta
    // as "same rune as previous edict".
    const payload = encodeRunestonePayload([
      { runeId: "73393:191", amount: 10n, output: 1 },
      { runeId: "73393:191", amount: 20n, output: 2 }
    ]);
    // body=00, block_delta=73393, tx=191, amt=10, out=1,
    //         block_delta=0,     tx=191, amt=20, out=2
    expect(bytesToHex(payload)).toBe("00b1bd04bf010a0100bf011402");
  });

  it("uses absolute block for an edict in a later block", () => {
    // First edict block 100; second block 105 -> delta 5.
    const payload = encodeRunestonePayload([
      { runeId: "100:1", amount: 7n, output: 0 },
      { runeId: "105:2", amount: 9n, output: 1 }
    ]);
    // 00, 100, 1, 7, 0, 5, 2, 9, 1
    expect(bytesToHex(payload)).toBe("0064010700050209 01".replace(/\s+/g, ""));
  });

  it("sorts unsorted input before encoding (delta must be non-negative)", () => {
    // Caller passes second-block edict FIRST. The encoder must
    // reorder, otherwise the delta on the now-leading edict would
    // underflow into a 19-byte varint and ord would burn the inputs.
    const payload = encodeRunestonePayload([
      { runeId: "200:3", amount: 11n, output: 0 },
      { runeId: "100:1", amount: 7n, output: 1 }
    ]);
    // Sorted: (100:1) then (200:3) -> block_delta 100 then 100
    expect(bytesToHex(payload)).toBe("006401070164030b00");
  });
});

describe("encodeRunestonePayload — pointer field", () => {
  it("emits Tag::Pointer (22) and value before the body separator", () => {
    const payload = encodeRunestonePayload(
      [{ runeId: "73393:191", amount: 1n, output: 1 }],
      { pointer: 2 }
    );
    // pointer-tag=22 (0x16), pointer-value=2, body-tag=0,
    // edict: block_delta=73393, tx=191, amount=1, output=1
    expect(bytesToHex(payload)).toBe("160200b1bd04bf010101");
  });

  it("rejects negative pointer", () => {
    expect(() =>
      encodeRunestonePayload(
        [{ runeId: "73393:191", amount: 1n, output: 1 }],
        { pointer: -1 }
      )
    ).toThrow(/pointer/);
  });

  it("rejects fractional pointer", () => {
    expect(() =>
      encodeRunestonePayload(
        [{ runeId: "73393:191", amount: 1n, output: 1 }],
        { pointer: 1.5 }
      )
    ).toThrow(/pointer/);
  });
});

describe("encodeRunestonePayload — u128 amounts", () => {
  it("encodes the runtime u128 max without precision loss", () => {
    const u128Max = (1n << 128n) - 1n;
    const payload = encodeRunestonePayload([
      { runeId: "73393:191", amount: u128Max, output: 0 }
    ]);
    // body=00, block=73393, tx=191, amount=u128_max (19-byte varint), out=0
    // Just check the prefix and the trailing output byte; the
    // u128 max bytes are spot-checked in encodeVarint tests.
    expect(payload[0]).toBe(0); // body tag
    expect(payload[payload.length - 1]).toBe(0); // output 0
    // Total length: 1 (body) + 3 (block) + 2 (tx) + 19 (amount u128 max) + 1 (out) = 26
    expect(payload.length).toBe(26);
  });
});

describe("encodeRunestonePayload — defensive rejections", () => {
  it("rejects negative amount", () => {
    expect(() =>
      encodeRunestonePayload([
        { runeId: "73393:191", amount: -1n, output: 0 }
      ])
    ).toThrow(/non-negative/);
  });

  it("rejects negative output", () => {
    expect(() =>
      encodeRunestonePayload([
        { runeId: "73393:191", amount: 1n, output: -1 }
      ])
    ).toThrow(/output/);
  });

  it("rejects fractional output", () => {
    expect(() =>
      encodeRunestonePayload([
        { runeId: "73393:191", amount: 1n, output: 1.5 }
      ])
    ).toThrow(/output/);
  });

  it("rejects malformed runeId", () => {
    expect(() =>
      encodeRunestonePayload([
        { runeId: "garbage", amount: 1n, output: 0 }
      ])
    ).toThrow(/invalid id/);
  });
});

describe("buildRunestoneOpReturn — script-level wrapping", () => {
  it("emits the OP_RETURN OP_13 prefix", () => {
    const script = buildRunestoneOpReturn([
      { runeId: "73393:191", amount: 1n, output: 0 }
    ]);
    expect(script[0]).toBe(0x6a); // OP_RETURN
    expect(script[1]).toBe(0x5d); // OP_13 (runestone marker)
  });

  it("uses single-byte push prefix for short payloads", () => {
    const script = buildRunestoneOpReturn([
      { runeId: "73393:191", amount: 1n, output: 0 }
    ]);
    // payload length should land in 0..75 range -> single-byte
    // prefix that IS the length.
    const pushPrefix = script[2]!;
    expect(pushPrefix).toBeLessThan(0x4c);
    expect(script.length).toBe(2 + 1 + pushPrefix);
  });

  it("rejects payloads that exceed the single-push policy limit", () => {
    // Build a payload with enough edicts to overflow 520 bytes.
    // Using u128-max amounts (~19 bytes each) so each edict
    // contributes ~21 bytes -- 30 edicts comfortably blow past.
    const u128Max = (1n << 128n) - 1n;
    const edicts = Array.from({ length: 30 }, (_, i) => ({
      runeId: `${1_000_000 + i}:1`,
      amount: u128Max,
      output: i % 8
    }));
    expect(() => buildRunestoneOpReturn(edicts)).toThrow(/exceeds.*limit/);
  });
});
