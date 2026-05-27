import crypto from "node:crypto";

/**
 * Canonical sha256-hex digest of a `display` payload.
 *
 * MUST stay byte-for-byte compatible with the SDK's
 * `computeDisplayHash` in `packages/wallet-hub-sdk/src/client.ts`.
 * The hash is what the wallet UI uses to detect display tampering;
 * a divergence between server and client implementations would
 * silently break the security check we're adding it for.
 *
 * Canonicalization rules (mirroring the SDK):
 *   1. Recursively sort object keys lexicographically so equivalent
 *      JSON shapes hash to the same digest regardless of how
 *      Postgres' jsonb roundtrip ordered them.
 *   2. Cycles are broken by emitting `null` once a node is seen
 *      again. (No legitimate `display` payload has cycles; this
 *      guard exists so a malformed value can't OOM the hash path.)
 *   3. JSON.stringify handles primitives, arrays, and null with its
 *      default semantics. Functions / undefined values are dropped,
 *      which is fine: `display` is JSON-shaped by construction.
 */
export function computeDisplayHash(display: unknown): string {
  const canonical = JSON.stringify(display, sortedReplacer(new WeakSet()));
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sortedReplacer(seen: WeakSet<object>) {
  return function replacer(_key: string, value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (seen.has(value as object)) return null;
      seen.add(value as object);
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = obj[k];
      return out;
    }
    return value;
  };
}
