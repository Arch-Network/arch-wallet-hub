/**
 * Runestone OP_RETURN encoder for rune transfers.
 *
 * Scope of this module is INTENTIONALLY narrow: encode a transfer-
 * style runestone (one or more edicts, optionally with a pointer).
 * Etchings, mints, and cenotaphs are NOT supported here -- they're
 * out of scope for the wallet's rune-send feature and adding them
 * would significantly widen the attack surface without need.
 *
 * Format summary (verified against ord and live testnet vectors):
 *
 *   OP_RETURN OP_13 <push-of-payload>
 *
 *   payload = varint sequence:
 *     (pre-body fields, alternating tag/value, terminated by tag 0)
 *     <body edicts, in 4-varint groups>
 *
 *   pre-body tags supported here:
 *     Tag::Pointer = 22 (varint)   -- output index to receive
 *                                     leftover runes from non-edicted
 *                                     inputs. Optional.
 *
 *   body edict groups (after the body separator, tag 0):
 *     (block_delta, tx, amount, output) -- 4 varints
 *
 *   block_delta is the RuneId block minus the previous edict's
 *   RuneId block. The list MUST be sorted by RuneId (block, tx)
 *   before encoding so block_delta is non-negative. The first
 *   edict's block_delta is just its block (delta from zero).
 *
 *   amount is u128, encoded as a single LEB128 unsigned varint.
 *
 * Reference vectors (live testnet):
 *   txid f71154f0... vout=0: 6a5d0714b1bd0414bf01  (mint, OUT OF SCOPE)
 *   txid aecdee36... vout=0: 6a5d0800b1bd04bf011302
 *     -> body 0; edict (block=73393, tx=191, amount=19, output=2)
 *   txid 24f8d967... vout=0: 6a5d0800b1bd04bf010502
 *     -> body 0; edict (block=73393, tx=191, amount=5,  output=2)
 *
 * Memory / overflow safety:
 *   - All arithmetic on amounts uses BigInt; u128 amounts cannot
 *     round-trip through Number safely (above 2^53 you lose digits)
 *   - Encoder rejects negative values explicitly -- ord treats a
 *     malformed runestone as a cenotaph (burns the inputs), so a
 *     silent encoding bug here means a user loses runes irrecoverably
 *   - Final OP_RETURN script length is checked against the 520-byte
 *     standardness limit so the broadcast doesn't silently fail
 */

export type RuneId = { block: bigint; tx: number };

export interface RuneEdict {
  /** RuneId in "block:tx" decimal form, e.g. "73393:191" */
  runeId: string;
  /** Amount in minor units (u128). MUST be >= 0. */
  amount: bigint;
  /** 0-based output index that receives this amount. MUST be >= 0. */
  output: number;
}

export interface EncodeRunestoneOptions {
  /**
   * Output index that should collect any leftover-rune balance from
   * the inputs after edicts are applied. Required for sends where
   * the sum of input rune balances exceeds what the edicts assign,
   * otherwise that leftover is burned. Recommended to point at the
   * sender's change output.
   */
  pointer?: number;
}

// ─── LEB128 unsigned varint ────────────────────────────────────

const HIGH_BIT = 0x80;
const LOW_7_BITS = 0x7f;

/**
 * Encode a non-negative bigint as a LEB128 unsigned varint.
 * 7-bit groups, MSB set on every byte except the last.
 *
 *   0 -> [0x00]
 *   127 -> [0x7f]
 *   128 -> [0x80, 0x01]
 *   16383 -> [0xff, 0x7f]
 *   16384 -> [0x80, 0x80, 0x01]
 *   max u128 (2^128 - 1) -> 19 bytes
 *
 * Throws on negative input. The Bitcoin Runestone spec uses
 * unsigned varints exclusively; a negative value indicates a
 * caller bug, and silently dropping the sign would burn runes.
 */
export function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error(`encodeVarint: value must be non-negative, got ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    out.push(Number(v & BigInt(LOW_7_BITS)) | HIGH_BIT);
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

// ─── RuneId helpers ────────────────────────────────────────────

/**
 * Parse a RuneId string like "73393:191" into structured form.
 * Throws on malformed input -- callers must always pass an id from
 * the indexer (which itself emits canonical decimal form). A bad
 * id here is a programming error, not user input.
 */
export function parseRuneId(id: string): RuneId {
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) throw new Error(`parseRuneId: invalid id "${id}", expected "block:tx"`);
  const block = BigInt(m[1]!);
  const tx = Number(m[2]!);
  if (tx < 0 || !Number.isSafeInteger(tx)) {
    throw new Error(`parseRuneId: tx index out of range in "${id}"`);
  }
  return { block, tx };
}

export function formatRuneId(id: RuneId): string {
  return `${id.block.toString()}:${id.tx}`;
}

function compareRuneId(a: RuneId, b: RuneId): number {
  if (a.block < b.block) return -1;
  if (a.block > b.block) return 1;
  return a.tx - b.tx;
}

// ─── Pre-body tag identifiers (matches ord canonical numbering) ─

const TAG_BODY = 0n;
const TAG_POINTER = 22n;

// ─── Script encoding ───────────────────────────────────────────

// Bitcoin OP_RETURN policy max push size. Larger payloads can be
// split across multiple pushes, but transfers never come close to
// this -- the encoder errs out instead of silently mis-encoding.
const MAX_OP_RETURN_PUSH_BYTES = 520;
const OP_RETURN = 0x6a;
const OP_13 = 0x5d;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;

function pushDataPrefix(len: number): Uint8Array {
  // For pushes 1..75 bytes the single-byte length IS the opcode.
  // 76..255 needs OP_PUSHDATA1; 256..65535 needs OP_PUSHDATA2.
  // Standard runestones never push more than ~80 bytes so we
  // really only exercise the first two branches in practice.
  if (len < 0x4c) return new Uint8Array([len]);
  if (len <= 0xff) return new Uint8Array([OP_PUSHDATA1, len]);
  return new Uint8Array([OP_PUSHDATA2, len & 0xff, (len >> 8) & 0xff]);
}

// ─── Main encoder ──────────────────────────────────────────────

/**
 * Encode the runestone payload (the bytes inside the push-data,
 * not including OP_RETURN OP_13 or the push prefix). Exported
 * separately from `buildRunestoneOpReturn` so tests can pin the
 * canonical payload bytes without depending on script encoding.
 */
export function encodeRunestonePayload(
  edicts: RuneEdict[],
  opts: EncodeRunestoneOptions = {}
): Uint8Array {
  // Sort the edict list by (block, tx). This is both required by
  // the format (block_delta must be non-negative) and a defense
  // against an unsorted caller -- if we trusted the caller's order
  // and the second edict had a smaller block, the delta would
  // underflow into a huge u128 and ord would interpret it as a
  // different rune entirely (silent fund loss).
  type Decoded = RuneEdict & { id: RuneId };
  const decoded: Decoded[] = edicts.map((e) => {
    if (e.amount < 0n) {
      throw new Error(`encodeRunestonePayload: edict amount must be non-negative`);
    }
    if (!Number.isInteger(e.output) || e.output < 0) {
      throw new Error(`encodeRunestonePayload: edict output must be a non-negative integer`);
    }
    return { ...e, id: parseRuneId(e.runeId) };
  });
  decoded.sort((a, b) => compareRuneId(a.id, b.id));

  const chunks: Uint8Array[] = [];

  // Pre-body fields. Today we only emit Pointer; adding more
  // means adding another (tag, value) pair before the body tag.
  if (opts.pointer !== undefined) {
    if (!Number.isInteger(opts.pointer) || opts.pointer < 0) {
      throw new Error(`encodeRunestonePayload: pointer must be a non-negative integer`);
    }
    chunks.push(encodeVarint(TAG_POINTER));
    chunks.push(encodeVarint(BigInt(opts.pointer)));
  }

  // Body separator: tag 0. After this, everything is edicts in
  // 4-varint groups.
  chunks.push(encodeVarint(TAG_BODY));

  let prevBlock = 0n;
  for (const e of decoded) {
    const blockDelta = e.id.block - prevBlock;
    chunks.push(encodeVarint(blockDelta));
    chunks.push(encodeVarint(BigInt(e.id.tx)));
    chunks.push(encodeVarint(e.amount));
    chunks.push(encodeVarint(BigInt(e.output)));
    prevBlock = e.id.block;
  }

  return concat(chunks);
}

/**
 * Build the full OP_RETURN script bytes for a runestone:
 *
 *   OP_RETURN OP_13 <push-data of payload>
 *
 * The result is ready to embed as a Bitcoin tx output script with
 * value=0.
 */
export function buildRunestoneOpReturn(
  edicts: RuneEdict[],
  opts: EncodeRunestoneOptions = {}
): Uint8Array {
  const payload = encodeRunestonePayload(edicts, opts);
  if (payload.length > MAX_OP_RETURN_PUSH_BYTES) {
    throw new Error(
      `buildRunestoneOpReturn: payload ${payload.length} bytes exceeds ` +
        `single-push limit (${MAX_OP_RETURN_PUSH_BYTES}); multi-push encoding ` +
        `is not implemented`
    );
  }
  return concat([
    new Uint8Array([OP_RETURN, OP_13]),
    pushDataPrefix(payload.length),
    payload
  ]);
}

// ─── Helpers ───────────────────────────────────────────────────

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Render a Uint8Array as a lowercase hex string. Exported for
 * use in tests and for the eventual rune-send PSBT-build log.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}
