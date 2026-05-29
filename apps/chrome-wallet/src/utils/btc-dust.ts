/**
 * Per-output-script dust threshold.
 *
 * Bitcoin Core enforces a relay-policy "dust" limit on outputs:
 * outputs below it are non-standard and won't propagate, so most
 * wallets refuse to build a transaction containing them. The number
 * depends on the output script TYPE (and the assumed cost to spend
 * that output later), NOT a flat 546 sats:
 *
 *   P2PKH    (1.../m.../n...)                       546 sats
 *   P2SH     (3.../2...)                            540 sats
 *   P2WPKH   (bc1q... / tb1q... 42-char bech32)     294 sats
 *   P2WSH    (bc1q... / tb1q... 62-char bech32)     330 sats
 *   P2TR     (bc1p... / tb1p... 62-char bech32m)    330 sats
 *
 * Numbers derive from Bitcoin Core's GetDustThreshold() with the
 * default `-dustrelayfee=3000` (3 sat/vB). They're the canonical
 * post-segwit values every modern node enforces -- mempool.space,
 * Unisat, Xverse, Sparrow all use the same set.
 *
 * Historically our wallet hardcoded 546 for every output type,
 * which (a) blocks small but legitimately-relayable sends to
 * SegWit/Taproot recipients and (b) causes us to throw away change
 * that's actually above the policy floor. This util fixes both.
 *
 * Fallback to 546 (the strictest) on any address we can't classify,
 * matching the prior behavior -- this is the conservative default
 * and won't suddenly emit a tx that fails to relay.
 */

/** Strictest dust limit, used as the safe fallback. */
export const DUST_FALLBACK_SATS = 546;

const DUST_P2PKH = 546;
const DUST_P2SH = 540;
const DUST_P2WPKH = 294;
const DUST_P2WSH_OR_P2TR = 330;

export type AddressKind =
  | "p2pkh"
  | "p2sh"
  | "p2wpkh"
  | "p2wsh"
  | "p2tr"
  | "unknown";

/**
 * Classify a Bitcoin address by script type using its prefix and
 * length. We deliberately don't decode bech32 checksums here --
 * bitcoinjs-lib's `address.toOutputScript` already does that in the
 * caller's hot path; if the address survives THAT, the prefix-based
 * classification is correct.
 *
 * The single ambiguous case is bech32(m) addresses where P2WSH and
 * P2TR both use 62-char bodies. We return "p2tr" for `*1p...` and
 * "p2wsh" for `*1q...` (62-char). Both happen to use the same dust
 * threshold (330) so the classification doesn't affect the result;
 * exposing the distinction is for callers who care later.
 */
export function classifyBtcAddress(addr: string): AddressKind {
  if (!addr || typeof addr !== "string") return "unknown";
  const a = addr.trim();
  const len = a.length;

  // P2PKH: mainnet `1...`, testnet `m.../n...`
  if (/^(1|m|n)[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return "p2pkh";

  // P2SH: mainnet `3...`, testnet `2...`
  if (/^(3|2)[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return "p2sh";

  // bech32 / bech32m: identify by hrp + first char of data + length.
  // Mainnet hrp = "bc", testnet = "tb", regtest = "bcrt".
  const lower = a.toLowerCase();
  const m = lower.match(/^(bc|tb|bcrt)1([qpzry9x8gf2tvdw0s3jn54khce6mua7l])/);
  if (m) {
    const dataPrefix = m[2]!;
    if (dataPrefix === "q") {
      // P2WPKH bodies are 42 chars total; P2WSH are 62.
      if (len <= 44) return "p2wpkh";
      return "p2wsh";
    }
    if (dataPrefix === "p") {
      // P2TR is bech32m with 62-char body.
      return "p2tr";
    }
  }

  return "unknown";
}

/**
 * Dust threshold (in sats) for an output paying to `addr`. Outputs
 * below this value are non-standard and won't relay; callers should
 * either bump the value above the threshold or drop the output
 * (e.g. fold change into the fee).
 */
export function dustThresholdForAddress(addr: string): number {
  switch (classifyBtcAddress(addr)) {
    case "p2pkh":
      return DUST_P2PKH;
    case "p2sh":
      return DUST_P2SH;
    case "p2wpkh":
      return DUST_P2WPKH;
    case "p2wsh":
    case "p2tr":
      return DUST_P2WSH_OR_P2TR;
    case "unknown":
    default:
      return DUST_FALLBACK_SATS;
  }
}
