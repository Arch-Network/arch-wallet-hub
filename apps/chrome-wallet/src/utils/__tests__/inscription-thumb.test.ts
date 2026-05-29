/**
 * Tests for the inscription thumbnail helpers.
 *
 * Two safety invariants:
 *   1. SVG must NEVER be classified as renderable. SVG can carry
 *      <script> tags executing in the page's origin.
 *   2. The byte cap MUST be enforced both pre-fetch (via
 *      contentLength hint) AND post-fetch (via body.byteLength)
 *      so a hostile / mis-reporting indexer can't trick us into
 *      keeping a 10 MB blob in memory.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchInscriptionThumbUrl,
  isRenderableImage,
  shortLabelForType,
  _clearInscriptionThumbCache
} from "../inscription-thumb";

beforeEach(() => {
  _clearInscriptionThumbCache();
});

// JSDOM lacks URL.createObjectURL / revokeObjectURL in vitest's
// node-pool default; stub to a deterministic shape for assertion.
beforeEach(() => {
  let n = 0;
  (globalThis as any).URL.createObjectURL = vi.fn(
    () => `blob:test/${++n}`
  );
  (globalThis as any).URL.revokeObjectURL = vi.fn();
});

describe("isRenderableImage", () => {
  it("accepts standard raster image MIMEs", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/apng"]) {
      expect(isRenderableImage(m)).toBe(true);
    }
  });

  it("REJECTS image/svg+xml (script-execution risk)", () => {
    expect(isRenderableImage("image/svg+xml")).toBe(false);
  });

  it("rejects text/html (script-execution risk)", () => {
    expect(isRenderableImage("text/html")).toBe(false);
  });

  it("rejects everything else (text, audio, video, json, octet-stream)", () => {
    for (const m of [
      "text/plain",
      "application/json",
      "audio/mpeg",
      "video/mp4",
      "application/octet-stream",
      "",
      undefined
    ]) {
      expect(isRenderableImage(m as string)).toBe(false);
    }
  });

  it("tolerates content-type parameters", () => {
    expect(isRenderableImage("image/png; charset=binary")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRenderableImage("IMAGE/PNG")).toBe(true);
  });
});

describe("shortLabelForType", () => {
  it("returns 'SVG' for image/svg+xml", () => {
    expect(shortLabelForType("image/svg+xml")).toBe("SVG");
  });

  it("returns the subtype uppercased for non-renderable images", () => {
    expect(shortLabelForType("image/tiff")).toBe("TIFF");
  });

  it("returns 'HTML' for text/html", () => {
    expect(shortLabelForType("text/html")).toBe("HTML");
  });

  it("returns 'VID' for video/*", () => {
    expect(shortLabelForType("video/mp4")).toBe("VID");
  });

  it("returns '?' for missing content type", () => {
    expect(shortLabelForType(undefined)).toBe("?");
  });
});

describe("fetchInscriptionThumbUrl", () => {
  function mockIndexer(body: ArrayBuffer, contentType: string) {
    return {
      getBtcInscriptionContent: vi.fn(async () => ({
        body,
        contentType,
        contentLength: body.byteLength
      }))
    } as any;
  }

  const PNG_BODY = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // 4 bytes; minimal

  it("returns null without fetching for non-renderable content_type", async () => {
    const indexer = mockIndexer(PNG_BODY, "image/png");
    const url = await fetchInscriptionThumbUrl(indexer, "abc:0i0", "image/svg+xml");
    expect(url).toBeNull();
    expect(indexer.getBtcInscriptionContent).not.toHaveBeenCalled();
  });

  it("returns null without fetching when contentLength exceeds cap", async () => {
    const indexer = mockIndexer(PNG_BODY, "image/png");
    const url = await fetchInscriptionThumbUrl(
      indexer,
      "abc:0i0",
      "image/png",
      10 * 1024 * 1024
    );
    expect(url).toBeNull();
    expect(indexer.getBtcInscriptionContent).not.toHaveBeenCalled();
  });

  it("fetches, caches, and returns a blob URL for a renderable thumb", async () => {
    const indexer = mockIndexer(PNG_BODY, "image/png");
    const url1 = await fetchInscriptionThumbUrl(indexer, "abc:0i0", "image/png", 4);
    expect(url1).toMatch(/^blob:test\//);
    expect(indexer.getBtcInscriptionContent).toHaveBeenCalledTimes(1);

    // Second call hits the cache, no new fetch.
    const url2 = await fetchInscriptionThumbUrl(indexer, "abc:0i0", "image/png", 4);
    expect(url2).toBe(url1);
    expect(indexer.getBtcInscriptionContent).toHaveBeenCalledTimes(1);
  });

  it("REJECTS post-fetch when the indexer's content-type disagrees with summary", async () => {
    // Summary claimed image/png but indexer returns image/svg+xml.
    // Indexer wins (it has the actual bytes); we must not render.
    const indexer = mockIndexer(PNG_BODY, "image/svg+xml");
    const url = await fetchInscriptionThumbUrl(indexer, "abc:0i0", "image/png", 4);
    expect(url).toBeNull();
  });

  it("REJECTS post-fetch when body exceeds cap (mis-reported contentLength)", async () => {
    // Summary said contentLength = 4 (under cap) but indexer
    // actually streams 3 MB. Defensive post-check kicks in.
    const big = new ArrayBuffer(3 * 1024 * 1024);
    const indexer = mockIndexer(big, "image/png");
    const url = await fetchInscriptionThumbUrl(indexer, "abc:0i0", "image/png", 4);
    expect(url).toBeNull();
  });

  it("propagates indexer errors so callers can show an error state", async () => {
    const indexer = {
      getBtcInscriptionContent: vi.fn(async () => {
        throw new Error("upstream 502");
      })
    } as any;
    await expect(
      fetchInscriptionThumbUrl(indexer, "abc:0i0", "image/png", 4)
    ).rejects.toThrow(/502/);
  });
});
