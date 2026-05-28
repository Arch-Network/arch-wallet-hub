/**
 * Helpers for the SIGN_MESSAGE Approve branch.
 *
 * Phase 1.6 — humanize hex payloads:
 *   - If the bytes decode cleanly as UTF-8 and consist of printable
 *     characters we show the text prominently and tuck the hex in a
 *     collapsed disclosure.
 *   - If they decode to JSON we render a pretty-printed copy.
 *   - If they look like an EIP-191 / "Sign in with ..." or contain a
 *     URL we extract that and surface a domain mismatch warning when
 *     the embedded URL's host differs from the calling origin.
 *   - Otherwise we render the hex with a clear "Binary payload"
 *     warning so the user understands they're blind-signing.
 */

export interface SiwaMessage {
  /** Domain the dapp identified itself as (must match origin). */
  domain: string;
  /** Wallet address the dapp expects to sign. */
  address: string;
  /** Free-text statement the dapp asks the user to read. May be empty. */
  statement?: string;
  /** Canonical URI the dapp resolves to. */
  uri: string;
  /** Schema version. Currently always "1". */
  version: string;
  /** Numeric chain identifier (we accept any non-empty string for forward-compat). */
  chainId: string;
  /** Random per-request nonce; the dapp uses this to bind the signature to a session. */
  nonce: string;
  /** ISO-8601 timestamp of message creation. */
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

export type MessageInterpretation =
  | {
      kind: "text";
      text: string;
      hex: string;
    }
  | {
      kind: "json";
      text: string;
      json: unknown;
      hex: string;
    }
  | {
      kind: "siwa";
      text: string;
      siwa: SiwaMessage;
      /**
       * Set when the parsed `domain` field doesn't match the caller's
       * origin host. The wallet still renders the friendly card, but
       * with a danger banner -- a domain-mismatched SIWA is the
       * canonical phishing signature.
       */
      domainMismatch?: { expected: string; got: string };
      /**
       * Set when the message is past `expirationTime` (when present)
       * or hasn't yet reached `notBefore`. Surfaced to the UI so the
       * user can refuse a stale challenge.
       */
      timingIssue?: { reason: "expired" | "not-yet-valid"; at: string };
      hex: string;
    }
  | {
      kind: "structured";
      text: string;
      url?: string;
      domainMismatch?: { expected: string; got: string };
      hex: string;
    }
  | {
      kind: "binary";
      hex: string;
      reason: string;
    };

function hexToBytes(hex: string): Uint8Array | null {
  const stripped = hex.trim().replace(/^0x/i, "");
  if (stripped.length === 0) return new Uint8Array();
  if (stripped.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) return null;
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isPrintable(text: string): boolean {
  // Reject if any control chars except common whitespace; allow most
  // Unicode (so emoji-laden Sign-in-with messages display).
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
    if (code === 0xfffd) return false; // Unicode replacement char from bad utf8
  }
  return true;
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^[\[\{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"'`<>]+/);
  return match ? match[0] : null;
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function hostFromOrigin(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Strict parser for the "Sign in with Arch" message format. The
 * format follows the same shape as EIP-4361 (SIWE) so dapp authors
 * who have already integrated SIWE on Ethereum can reuse most of
 * their tooling -- only the chain name in the header differs:
 *
 *   ${domain} wants you to sign in with your Arch account:
 *   ${address}
 *
 *   ${optional statement}
 *
 *   URI: ${uri}
 *   Version: ${version}
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   [Expiration Time: ...]
 *   [Not Before: ...]
 *   [Request ID: ...]
 *   [Resources:
 *   - ${url1}
 *   - ${url2}]
 *
 * We require ALL of domain / address / URI / Version / Chain ID /
 * Nonce / Issued At so the Approve UI can render a real card. A
 * message that *looks* SIWA-shaped but is missing required fields
 * falls through to the looser `structured` kind so the user still
 * sees raw text and a domain warning.
 *
 * Returns `null` when the input is not a valid SIWA message.
 */
export function parseSiwaMessage(text: string): SiwaMessage | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length < 5) return null;

  const headerMatch = lines[0]!.match(
    /^([A-Za-z0-9.\-:_]+)\s+wants you to sign in with your Arch account:\s*$/,
  );
  if (!headerMatch) return null;
  const domain = headerMatch[1]!;

  const address = lines[1]!.trim();
  if (!address) return null;

  // After the address line, optionally an empty line, an optional
  // statement (one or more non-empty lines), an empty line, then the
  // tagged fields. We scan forward to find the first tagged field
  // (`URI:`) and treat everything between address+1 and that point
  // as the statement block (after stripping surrounding blank lines).
  let cursor = 2;
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor++;
  let statement: string | undefined;
  const statementStart = cursor;
  while (
    cursor < lines.length &&
    !/^[A-Z][A-Za-z ]+:/.test(lines[cursor]!) &&
    lines[cursor]!.trim() !== ""
  ) {
    cursor++;
  }
  if (cursor > statementStart) {
    statement = lines.slice(statementStart, cursor).join("\n").trim() || undefined;
  }
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor++;

  const fields = new Map<string, string>();
  let i = cursor;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "Resources:") {
      const resources: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.startsWith("- ")) {
        resources.push(lines[i]!.slice(2).trim());
        i++;
      }
      fields.set("Resources", resources.join("\n"));
      continue;
    }
    const m = line.match(/^([A-Za-z][A-Za-z ]*?):\s*(.+)$/);
    if (m) fields.set(m[1]!, m[2]!.trim());
    i++;
  }

  const uri = fields.get("URI");
  const version = fields.get("Version");
  const chainId = fields.get("Chain ID");
  const nonce = fields.get("Nonce");
  const issuedAt = fields.get("Issued At");
  if (!uri || !version || !chainId || !nonce || !issuedAt) return null;

  const expirationTime = fields.get("Expiration Time") || undefined;
  const notBefore = fields.get("Not Before") || undefined;
  const requestId = fields.get("Request ID") || undefined;
  const resourcesRaw = fields.get("Resources");
  const resources = resourcesRaw ? resourcesRaw.split("\n").filter(Boolean) : undefined;

  return {
    domain,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    notBefore,
    requestId,
    resources,
  };
}

/**
 * Compare the parsed SIWA `domain` against the calling origin's
 * host. Caller wraps the result into the `domainMismatch` field
 * of the `siwa` interpretation.
 */
function checkSiwaDomain(
  siwaDomain: string,
  origin: string,
): { expected: string; got: string } | undefined {
  const originHost = hostFromOrigin(origin);
  if (!originHost) return undefined;
  if (siwaDomain.toLowerCase() === originHost.toLowerCase()) return undefined;
  return { expected: originHost, got: siwaDomain };
}

/**
 * If the SIWA message defines temporal validity, ensure the current
 * wall-clock time falls within it. Returns `undefined` when the
 * message has no temporal constraints or they are all satisfied.
 */
function checkSiwaTiming(
  siwa: SiwaMessage,
  now: Date,
): { reason: "expired" | "not-yet-valid"; at: string } | undefined {
  if (siwa.expirationTime) {
    const t = Date.parse(siwa.expirationTime);
    if (!Number.isNaN(t) && t < now.getTime()) {
      return { reason: "expired", at: siwa.expirationTime };
    }
  }
  if (siwa.notBefore) {
    const t = Date.parse(siwa.notBefore);
    if (!Number.isNaN(t) && t > now.getTime()) {
      return { reason: "not-yet-valid", at: siwa.notBefore };
    }
  }
  return undefined;
}

/**
 * Interpret a hex-encoded message payload coming from a dapp.
 * `origin` is the calling site's origin and is used for domain
 * mismatch detection on structured/SIWE-style payloads.
 */
export function interpretMessage(hex: string, origin: string): MessageInterpretation {
  const bytes = hexToBytes(hex);
  if (!bytes) {
    return { kind: "binary", hex, reason: "Not valid hex" };
  }
  if (bytes.length === 0) {
    return { kind: "binary", hex, reason: "Empty payload" };
  }

  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "binary", hex, reason: "Not valid UTF-8" };
  }

  if (!isPrintable(text)) {
    return { kind: "binary", hex, reason: "Contains non-printable bytes" };
  }

  const json = tryParseJson(text);
  if (json !== null) {
    return { kind: "json", text, json, hex };
  }

  // Try the strict Sign-in-with-Arch parser first. If it matches we
  // can render a real card; if it doesn't, fall through to the
  // looser "structured" kind for anything that *looks* SIWE-ish.
  const siwa = parseSiwaMessage(text);
  if (siwa) {
    return {
      kind: "siwa",
      text,
      siwa,
      domainMismatch: checkSiwaDomain(siwa.domain, origin),
      timingIssue: checkSiwaTiming(siwa, new Date()),
      hex,
    };
  }

  const url = extractUrl(text);
  if (
    url ||
    /sign in with/i.test(text) ||
    /URI:/i.test(text)
  ) {
    const embeddedHost = url ? hostFromUrl(url) : null;
    const originHost = hostFromOrigin(origin);
    const domainMismatch =
      embeddedHost && originHost && embeddedHost !== originHost
        ? { expected: originHost, got: embeddedHost }
        : undefined;
    return { kind: "structured", text, url: url ?? undefined, domainMismatch, hex };
  }

  return { kind: "text", text, hex };
}
