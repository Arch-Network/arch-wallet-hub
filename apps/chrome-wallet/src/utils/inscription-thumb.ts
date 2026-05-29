/**
 * Inscription thumbnail helpers.
 *
 * Renders binary inscription content (PNG/JPEG/WEBP/GIF) as
 * fixed-size thumbnails on the Dashboard gallery card. Architecture:
 *
 *   1. Fetch the binary via the wallet's auth pipeline
 *      (`indexer.getBtcInscriptionContent`)
 *   2. Wrap in a Blob, mint a per-id object URL
 *   3. Render via standard `<img src=blob:...>`
 *   4. Cache the object URL by id with LRU eviction
 *
 * Why not point `<img src>` at the indexer URL directly: the indexer
 * requires API-key auth on `/content` (verified 401 anonymous), and
 * `<img>` requests don't carry headers from the page context. Using
 * blob URLs means we keep our auth pipeline and let the upstream
 * `immutable` cache header still cover repeat loads inside the same
 * tab session.
 *
 * Security choices:
 *   - SVG is NOT renderable: it can contain `<script>` and `onload`
 *     handlers that execute in the same origin as the wallet UI.
 *     Always treated as a placeholder.
 *   - HTML / text inscriptions are also NOT renderable as thumbs;
 *     the future detail page will sandbox them in an iframe.
 *   - The Hub forwards `X-Content-Type-Options: nosniff`, but blob
 *     URLs in `<img>` still trigger the browser's image decoder
 *     only when the content-type is a recognized image MIME --
 *     we double-check on the wallet side via the allowlist.
 */
import type { BtcInscriptionContent, IndexerClient } from "./indexer";

const RENDERABLE_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/apng"
]);

/**
 * Returns true if the content type is safe to render as an `<img>`
 * thumbnail in the wallet UI. SVG is deliberately excluded -- it
 * can contain executable script tags and we don't sandbox here.
 */
export function isRenderableImage(contentType: string | undefined): boolean {
  if (!contentType) return false;
  // Trim parameters (e.g. `image/png; charset=binary`) before the
  // allowlist check. ord's responses don't include parameters today
  // but defending the comparison is cheap.
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  return RENDERABLE_IMAGE_MIME.has(mime);
}

/**
 * Short, two-letter label for a non-renderable content type. Used
 * on placeholder tiles in the gallery card so the user can still
 * see what kind of inscription they own.
 */
export function shortLabelForType(contentType: string | undefined): string {
  if (!contentType) return "?";
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (mime === "image/svg+xml") return "SVG";
  if (mime.startsWith("image/")) return mime.split("/")[1]!.toUpperCase().slice(0, 4);
  if (mime.startsWith("video/")) return "VID";
  if (mime.startsWith("audio/")) return "AUD";
  if (mime === "text/html") return "HTML";
  if (mime.startsWith("text/")) return "TXT";
  if (mime === "application/json") return "JSON";
  return mime.split("/")[1]!.toUpperCase().slice(0, 4);
}

// ─── Blob URL cache (LRU-by-insertion) ─────────────────────────

interface CacheEntry {
  blobUrl: string;
  // Used to evict largest entries first if we ever blow the size
  // budget. Today's cap is by count; size tracking is forward-
  // compatible with adding a byte budget later.
  size: number;
}

const MAX_CACHED_THUMBS = 24;
// Cap per-thumb body size at 2 MB. Anything larger is likely
// a non-thumbnail inscription (video, large image) and we'd
// rather show a placeholder than spend bandwidth + memory.
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

const cache = new Map<string, CacheEntry>();

function noteHit(id: string, entry: CacheEntry): void {
  // Map.set() on an existing key moves it to insertion-order tail,
  // giving us cheap LRU without a separate list.
  cache.delete(id);
  cache.set(id, entry);
}

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHED_THUMBS) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    const entry = cache.get(oldest);
    if (entry) URL.revokeObjectURL(entry.blobUrl);
    cache.delete(oldest);
  }
}

/**
 * Get a cached object URL for an inscription thumbnail, or fetch
 * and cache it. Returns null for non-renderable content types and
 * for inscriptions whose body exceeds the thumbnail size cap.
 *
 * Rejects (does not return null) on indexer failures so callers
 * can render an error state distinct from "not an image".
 */
export async function fetchInscriptionThumbUrl(
  indexer: IndexerClient,
  id: string,
  contentType: string | undefined,
  contentLength?: number
): Promise<string | null> {
  if (!isRenderableImage(contentType)) return null;
  if (typeof contentLength === "number" && contentLength > MAX_THUMB_BYTES) {
    return null;
  }

  const hit = cache.get(id);
  if (hit) {
    noteHit(id, hit);
    return hit.blobUrl;
  }

  const content: BtcInscriptionContent = await indexer.getBtcInscriptionContent(id);
  if (content.body.byteLength > MAX_THUMB_BYTES) {
    return null;
  }
  // The indexer's content-type wins over the per-address summary's
  // type if they disagree -- the binary stream is authoritative.
  if (!isRenderableImage(content.contentType)) {
    return null;
  }

  const blob = new Blob([content.body], { type: content.contentType });
  const blobUrl = URL.createObjectURL(blob);
  const entry: CacheEntry = { blobUrl, size: content.body.byteLength };
  cache.set(id, entry);
  evictIfNeeded();
  return blobUrl;
}

/**
 * Test-only escape hatch to flush the cache between assertions.
 * Production code never calls this; React component unmount does
 * NOT call it because the same blob URL is likely needed on
 * remount within the LRU window.
 */
export function _clearInscriptionThumbCache(): void {
  for (const entry of cache.values()) {
    URL.revokeObjectURL(entry.blobUrl);
  }
  cache.clear();
}
