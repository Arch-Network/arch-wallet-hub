/**
 * Detect runestone-bearing Bitcoin transactions from indexer
 * response shapes.
 *
 * A runestone is an OP_RETURN output whose script bytes start
 * with `OP_RETURN OP_13` (`0x6a 0x5d`). Output value MUST be 0
 * (rendering it non-standard otherwise). Per the Runes spec, the
 * first such output in a transaction is the binding runestone;
 * any later OP_RETURNs are ignored.
 *
 * The indexer wraps Esplora-like responses (`vout: [{ scriptpubkey,
 * scriptpubkey_type, ... }]`) AND its own Titan-native shape
 * (`output: [{ script_pubkey, script_pubkey_type, ... }]`). We
 * sniff both so a single tx-history pipeline doesn't have to
 * branch on shape upstream.
 *
 * Why detect locally rather than always hitting
 * `/bitcoin/address/:a/rune-transactions`: that endpoint is the
 * right answer when we WANT rune detail (which rune, amount in
 * minor units, sender vs receiver), but the History view just
 * needs to label the row as "Rune transfer" instead of the
 * unhelpful "BTC Transaction" fallback. Local detection costs
 * zero round-trips and works for any rune-shaped tx, including
 * unconfirmed mempool transfers the indexer's address-level rune
 * cache may not have indexed yet.
 */

const OP_RETURN = 0x6a;
const OP_13 = 0x5d; // runestone magic, BIP for Runes

type ScriptLike = {
  scriptpubkey?: string;
  scriptpubkey_type?: string;
  script_pubkey?: string;
  script_pubkey_type?: string;
  script?: string;
  type?: string;
  value?: number | string;
};

function hexStartsWithBytes(hex: string | undefined | null, bytes: number[]): boolean {
  if (!hex || typeof hex !== "string") return false;
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length < bytes.length * 2) return false;
  for (let i = 0; i < bytes.length; i++) {
    const want = bytes[i]!.toString(16).padStart(2, "0").toLowerCase();
    const got = clean.slice(i * 2, i * 2 + 2).toLowerCase();
    if (got !== want) return false;
  }
  return true;
}

function outputScriptHex(out: ScriptLike): string | null {
  return out.scriptpubkey ?? out.script_pubkey ?? out.script ?? null;
}

function isOpReturnOutput(out: ScriptLike): boolean {
  const typeStr = (out.scriptpubkey_type ?? out.script_pubkey_type ?? out.type ?? "").toLowerCase();
  if (typeStr === "op_return" || typeStr === "opreturn" || typeStr === "nulldata") return true;
  // Fall back to the script byte. Indexer responses occasionally
  // omit the type tag (especially on Titan-native shapes) but the
  // raw script is always there.
  return hexStartsWithBytes(outputScriptHex(out), [OP_RETURN]);
}

/**
 * True if the transaction carries a runestone (OP_RETURN OP_13 ...)
 * as one of its outputs. Detects both Esplora-shape (`vout`) and
 * Titan-native (`output`) response variants.
 */
export function txHasRunestone(tx: unknown): boolean {
  if (!tx || typeof tx !== "object") return false;
  const t = tx as Record<string, unknown>;
  const lists: Array<ScriptLike[]> = [];
  if (Array.isArray(t.vout)) lists.push(t.vout as ScriptLike[]);
  if (Array.isArray(t.output)) lists.push(t.output as ScriptLike[]);
  for (const outs of lists) {
    for (const out of outs) {
      if (!isOpReturnOutput(out)) continue;
      const hex = outputScriptHex(out);
      if (hexStartsWithBytes(hex, [OP_RETURN, OP_13])) return true;
    }
  }
  return false;
}
