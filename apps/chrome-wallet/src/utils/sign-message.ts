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
