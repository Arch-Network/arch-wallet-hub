/**
 * Lightweight phishing & lookalike detection for the Approve popup.
 *
 * Three checks, in increasing complexity:
 *
 *   1. Static blocklist hit. Any origin whose hostname matches a
 *      curated list of known-bad domains gets a `danger` verdict.
 *      The list ships in-repo and grows via PR; no runtime fetch.
 *
 *   2. Punycode (IDN) detection. Any hostname containing `xn--`
 *      labels gets at least a `warn`. Combined with the lookalike
 *      check below, a Punycode hostname that decodes to something
 *      visually similar to a trusted host is escalated to `danger`.
 *
 *   3. Visual lookalike scoring. We compute a normalized form of
 *      the hostname (Punycode decoded, common confusables folded to
 *      their ASCII counterparts -- "0" -> "o", Cyrillic "а" -> "a",
 *      etc.) and compare to a small allowlist of trusted hosts. A
 *      one- or two-character edit distance from a trusted host
 *      raises `warn`/`danger`.
 *
 * Design choices:
 *
 *   - We never block sign on a phishing verdict here. Blocking is
 *     the caller's policy (Approve.tsx may require explicit ack on
 *     `danger`); this module is pure assessment.
 *
 *   - We never fetch lists at runtime. A live blocklist would
 *     introduce a third-party MITM target between the user and the
 *     dapp; the blocklist is shipped with the extension and updated
 *     via release.
 *
 *   - The trusted-host list is small and curated. Spreading the
 *     check across the entire Internet would produce false positives
 *     -- the goal is to detect specifically a phishing-of-our-own-
 *     ecosystem attack ("arсh.network" vs "arch.network").
 */

export type RiskLevel = "info" | "warn" | "danger";

export interface RiskAssessment {
  level: RiskLevel;
  label: string;
  /** Discriminator the caller can branch on without re-parsing the label. */
  reason:
    | "ok"
    | "blocklist"
    | "punycode"
    | "lookalike"
    | "punycode-lookalike";
}

/**
 * Curated blocklist of hostnames known to phish Bitcoin / Arch /
 * crypto wallets. Lowercase, no protocol, no port. Subdomains of an
 * entry are NOT automatically matched -- list each variant
 * explicitly to avoid sweeping false positives (e.g. blocking
 * "wallet.example.com" should not block "example.com").
 *
 * Seed is intentionally small. Add new entries via PR with a short
 * provenance note in the commit message so we can audit drift.
 */
export const PHISHING_HOST_BLOCKLIST: ReadonlySet<string> = new Set<string>([
  // Add entries as they are reported; keep the list curated.
]);

/**
 * Hostnames we treat as canonical / trusted for lookalike scoring.
 * The list is intentionally minimal -- if a host shows up here, a
 * close-but-not-exact match against it becomes a phishing signal.
 * DO NOT add general Bitcoin infrastructure (block explorers,
 * Lightning nodes, etc.) -- only direct user-facing dapp surfaces
 * where confusion with the canonical brand is a real risk.
 */
export const TRUSTED_HOST_LIST: readonly string[] = [
  "arch.network",
  "hub.arch.network",
  "explorer.arch.network",
];

/**
 * Map of common visual confusables to their ASCII counterparts. The
 * list is deliberately conservative -- aggressive folding (e.g.
 * treating every Latin letter as case-insensitive) produces false
 * positives. Covers the most common cyrillic / greek substitutions
 * seen in real phishing campaigns plus digit-as-letter swaps.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y",
  "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "հ": "h",
  // Greek
  "α": "a", "β": "b", "ο": "o", "ρ": "p", "ι": "i", "κ": "k", "ν": "v",
  // Digits ↔ letters
  "0": "o", "1": "l", "3": "e", "5": "s",
};

/**
 * Decode a single Punycode-encoded label per RFC 3492. Returns the
 * input unchanged if the label doesn't start with `xn--` or if
 * decoding fails. Implemented inline so we don't add a dependency
 * for what is essentially a 40-line algorithm; behaviour is locked
 * by unit tests below.
 */
function decodePunycodeLabel(label: string): string {
  if (!label.toLowerCase().startsWith("xn--")) return label;
  const encoded = label.slice(4);

  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;

  const lastHyphen = encoded.lastIndexOf("-");
  const output: number[] = [];
  if (lastHyphen > 0) {
    for (let i = 0; i < lastHyphen; i++) {
      const c = encoded.charCodeAt(i);
      if (c >= 0x80) return label; // invalid basic codepoint
      output.push(c);
    }
  }

  const decodeDigit = (cp: number): number => {
    if (cp >= 48 && cp <= 57) return cp - 22; // 0..9 -> 26..35
    if (cp >= 65 && cp <= 90) return cp - 65; // A..Z -> 0..25
    if (cp >= 97 && cp <= 122) return cp - 97; // a..z -> 0..25
    return base; // sentinel: invalid digit
  };

  const adapt = (delta: number, numPoints: number, firstTime: boolean): number => {
    let d = firstTime ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / numPoints);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };

  let n = initialN;
  let i = 0;
  let bias = initialBias;
  let pos = lastHyphen > 0 ? lastHyphen + 1 : 0;

  while (pos < encoded.length) {
    const oldI = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (pos >= encoded.length) return label;
      const digit = decodeDigit(encoded.charCodeAt(pos++));
      if (digit >= base) return label;
      if (digit > Math.floor((0x7fffffff - i) / w)) return label;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      if (w > Math.floor(0x7fffffff / (base - t))) return label;
      w *= base - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldI, out, oldI === 0);
    if (Math.floor(i / out) > 0x7fffffff - n) return label;
    n += Math.floor(i / out);
    i %= out;
    output.splice(i, 0, n);
    i++;
  }

  return String.fromCodePoint(...output);
}

/**
 * Decode every Punycode label in a hostname back to its Unicode
 * form. Non-IDN labels pass through unchanged.
 */
function decodeIdnHostname(hostname: string): string {
  return hostname
    .split(".")
    .map((label) => decodePunycodeLabel(label))
    .join(".");
}

/**
 * Try to derive a normalized representation of a hostname suitable
 * for visual comparison. Steps:
 *
 *   - Lowercase
 *   - Decode any Punycode (`xn--`) labels back to Unicode
 *   - Unicode-normalize (NFC) so combining marks collapse
 *   - Fold known visual confusables to ASCII
 *
 * Returns the lowercased original on any failure so callers can
 * still log without throwing.
 */
export function normalizeHostnameForComparison(hostname: string): string {
  let normalized = hostname.toLowerCase();
  try {
    normalized = decodeIdnHostname(normalized).normalize("NFC");
  } catch {
    /* leave as-is */
  }
  const chars = Array.from(normalized);
  for (let i = 0; i < chars.length; i++) {
    const sub = CONFUSABLES[chars[i]!];
    if (sub !== undefined) chars[i] = sub;
  }
  return chars.join("");
}

function isPunycodeHostname(hostname: string): boolean {
  return hostname.toLowerCase().split(".").some((label) => label.startsWith("xn--"));
}

/**
 * Standard Levenshtein distance, capped early. Capping matters
 * because we only care about "close" matches; any distance >= cap
 * can return early without finishing the matrix. Worst-case for
 * uncapped is O(n*m); with cap k it's O(n*k).
 */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  if (a === b) return 0;

  const m = a.length;
  const n = b.length;
  let prev: number[] = new Array(n + 1);
  let curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

interface LookalikeMatch {
  trusted: string;
  distance: number;
}

/**
 * Find the closest trusted hostname (by normalized edit distance)
 * within `cap` edits, if any. The trusted host *itself* is excluded
 * by comparing original (pre-normalization) hostnames -- otherwise
 * a visual-identical impostor like "arсh.network" (Cyrillic с)
 * would normalize to "arch.network", match itself, and escape
 * detection. Distance 0 between *different* original hostnames is
 * the strongest possible lookalike signal.
 */
function findLookalike(
  originalHostname: string,
  normalized: string,
  trustedList: readonly string[],
  cap: number,
): LookalikeMatch | null {
  const origLower = originalHostname.toLowerCase();
  let best: LookalikeMatch | null = null;
  for (const trusted of trustedList) {
    if (trusted.toLowerCase() === origLower) continue; // it's the trusted host itself
    const tNorm = normalizeHostnameForComparison(trusted);
    const d = editDistance(normalized, tNorm, cap);
    if (d <= cap) {
      if (!best || d < best.distance) {
        best = { trusted, distance: d };
      }
    }
  }
  return best;
}

/**
 * Extract a hostname from an origin string. Accepts both
 * `https://example.com` and bare `example.com:1234`. Returns the
 * lowercased hostname or `""` if unparseable.
 */
export function hostnameFromOrigin(origin: string): string {
  const trimmed = (origin ?? "").trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    /* fall through */
  }
  try {
    return new URL(`https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Evaluate the phishing risk of a dapp origin. Returns the highest-
 * severity finding so the caller can drop a single banner.
 */
export function assessOriginRisk(
  origin: string,
  opts?: {
    blocklist?: ReadonlySet<string>;
    trustedList?: readonly string[];
    /** Max normalized edit distance treated as a lookalike. Default 2. */
    lookalikeMaxDistance?: number;
  },
): RiskAssessment {
  const blocklist = opts?.blocklist ?? PHISHING_HOST_BLOCKLIST;
  const trustedList = opts?.trustedList ?? TRUSTED_HOST_LIST;
  const cap = opts?.lookalikeMaxDistance ?? 2;

  const hostname = hostnameFromOrigin(origin);
  if (!hostname) {
    return { level: "info", label: "", reason: "ok" };
  }

  if (blocklist.has(hostname)) {
    return {
      level: "danger",
      label: `${hostname} is on the wallet's phishing blocklist. Do NOT sign.`,
      reason: "blocklist",
    };
  }

  const punycode = isPunycodeHostname(hostname);
  const normalized = normalizeHostnameForComparison(hostname);
  const lookalike = findLookalike(hostname, normalized, trustedList, cap);

  if (punycode && lookalike) {
    return {
      level: "danger",
      label:
        `${hostname} uses Punycode (\`xn--\` labels) and resembles ` +
        `${lookalike.trusted}. This is a classic phishing pattern -- verify the URL carefully.`,
      reason: "punycode-lookalike",
    };
  }
  if (lookalike) {
    const detail =
      lookalike.distance === 0
        ? "visually identical via confusable characters"
        : `${lookalike.distance}-character difference`;
    return {
      level: "danger",
      label:
        `${hostname} closely resembles ${lookalike.trusted} ` +
        `(${detail}). Verify the URL before signing.`,
      reason: "lookalike",
    };
  }
  if (punycode) {
    return {
      level: "warn",
      label:
        `${hostname} contains internationalized (Punycode) labels. ` +
        `Verify this is the intended site before signing.`,
      reason: "punycode",
    };
  }

  return { level: "info", label: "", reason: "ok" };
}
