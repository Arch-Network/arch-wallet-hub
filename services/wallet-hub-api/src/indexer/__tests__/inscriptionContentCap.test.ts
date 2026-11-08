import { describe, it, expect } from "vitest";
import {
  InscriptionContentTooLargeError,
  MAX_INSCRIPTION_CONTENT_BYTES,
  readResponseBodyCapped,
} from "../inscriptionContentCap.js";

function mockResponse(opts: {
  body?: Uint8Array | null;
  contentLength?: string | null;
  useReader?: boolean;
}): Response {
  const bytes = opts.body ?? new Uint8Array();
  const headers = new Headers();
  if (opts.contentLength != null) {
    headers.set("content-length", opts.contentLength);
  }

  if (opts.useReader === false) {
    return {
      headers,
      body: null,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  }

  let offset = 0;
  const chunkSize = Math.max(1, Math.floor(bytes.byteLength / 3) || 1);
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (offset >= bytes.byteLength) return { done: true };
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const value = bytes.subarray(offset, end);
      offset = end;
      return { done: false, value };
    },
    async cancel() {
      offset = bytes.byteLength;
    },
  };

  return {
    headers,
    body: { getReader: () => reader },
  } as unknown as Response;
}

describe("readResponseBodyCapped (issue #45)", () => {
  it("exposes the 2 MiB Hub cap (matches wallet thumb budget)", () => {
    expect(MAX_INSCRIPTION_CONTENT_BYTES).toBe(2 * 1024 * 1024);
  });

  it("returns the body when under the cap", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const buf = await readResponseBodyCapped(
      mockResponse({ body, contentLength: "4" }),
      16,
    );
    expect(new Uint8Array(buf)).toEqual(body);
  });

  it("rejects when Content-Length exceeds the cap without buffering", async () => {
    await expect(
      readResponseBodyCapped(
        mockResponse({
          body: new Uint8Array(8),
          contentLength: String(MAX_INSCRIPTION_CONTENT_BYTES + 1),
        }),
      ),
    ).rejects.toBeInstanceOf(InscriptionContentTooLargeError);
  });

  it("rejects when streamed body exceeds the cap (lying Content-Length)", async () => {
    const body = new Uint8Array(20).fill(7);
    await expect(
      readResponseBodyCapped(
        mockResponse({ body, contentLength: "4" }),
        10,
      ),
    ).rejects.toMatchObject({
      name: "InscriptionContentTooLargeError",
      maxBytes: 10,
    });
  });

  it("falls back to arrayBuffer when body reader is unavailable", async () => {
    const body = new Uint8Array([9, 8, 7]);
    const buf = await readResponseBodyCapped(
      mockResponse({ body, useReader: false }),
      16,
    );
    expect(new Uint8Array(buf)).toEqual(body);
  });
});
