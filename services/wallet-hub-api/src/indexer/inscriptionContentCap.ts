/**
 * Bound how much inscription / ordinal content the Hub will buffer
 * from upstream and return through the proxy (issue #45).
 *
 * Without a cap, a single large inscription (or a lying Content-Length)
 * forces the Hub to `arrayBuffer()` unbounded bytes into memory —
 * DoS amplification behind the privileged Indexer key.
 *
 * 2 MiB matches the chrome-wallet thumbnail budget
 * (`apps/chrome-wallet/src/utils/inscription-thumb.ts` MAX_THUMB_BYTES).
 * Larger media still exists on-chain; the Hub simply refuses to proxy
 * it. Clients already treat oversize as "no thumb / placeholder".
 */
export const MAX_INSCRIPTION_CONTENT_BYTES = 2 * 1024 * 1024;

export class InscriptionContentTooLargeError extends Error {
  readonly byteLength: number;
  readonly maxBytes: number;

  constructor(byteLength: number, maxBytes: number = MAX_INSCRIPTION_CONTENT_BYTES) {
    super(
      `Inscription content exceeds Hub size cap (${byteLength} > ${maxBytes} bytes)`,
    );
    this.name = "InscriptionContentTooLargeError";
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

/**
 * Read a fetch Response body with a hard byte ceiling.
 *
 * Prefers Content-Length when present (fail closed before buffering).
 * Otherwise streams via the body reader and aborts once over the cap,
 * so a missing/wrong Content-Length cannot still OOM the process.
 */
export async function readResponseBodyCapped(
  res: Response,
  maxBytes: number = MAX_INSCRIPTION_CONTENT_BYTES,
): Promise<ArrayBuffer> {
  const lengthHeader = res.headers.get("content-length");
  if (lengthHeader != null && lengthHeader !== "") {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Drain/cancel so the upstream connection isn't left hanging.
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      throw new InscriptionContentTooLargeError(declared, maxBytes);
    }
  }

  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new InscriptionContentTooLargeError(buf.byteLength, maxBytes);
    }
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new InscriptionContentTooLargeError(total, maxBytes);
      }
      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    throw err;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
