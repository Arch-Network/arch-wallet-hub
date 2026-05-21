/**
 * Runtime-context helpers.
 *
 * The extension can render in three surfaces today (popup window, side
 * panel, full-page tab). A few flows need to behave differently per
 * surface — most notably anything that triggers a WebAuthn / passkey
 * prompt. Chrome's side panel context cannot reliably present the
 * platform credential picker (the prompt is anchored to the top-most
 * window and silently no-ops when the calling context is the side
 * panel iframe), so swap signing has to be deferred to the popup.
 *
 * This module centralises the side-panel sniffing + the popup-opening
 * shim so the call sites stay one-liners.
 */

const SIDE_PANEL_DATA_ATTR = "sidepanel";

/**
 * True when the current document was loaded as the extension's side
 * panel (entrypoints/sidepanel/index.html sets `data-mode="sidepanel"`
 * on the root element). Returns false in SSR or pre-bootstrap contexts.
 */
export function isInSidePanel(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.mode === SIDE_PANEL_DATA_ATTR;
}

/**
 * True when the wallet UI is rendered inside a standalone Chrome popup
 * window spawned via `chrome.windows.create({ type: "popup" })`. Used
 * by flows that open additional `focused: true` popups (external wallet
 * connector, passkey ceremonies) to decide whether they're safe to run
 * inline or need to be rehosted into a fresh popup window first.
 *
 * Why this matters: the toolbar popup (the small panel attached to the
 * browser-action icon) is auto-dismissed by Chrome the instant another
 * window steals focus. If we kick off an external-wallet connect from
 * the toolbar popup, the connector window grabs focus, the toolbar
 * popup dies mid-flight, and the rest of the onboarding orchestration
 * never runs (or completes but has no UI to land on). Standalone popup
 * windows are not dismissed on focus loss — they survive the trip
 * through the external wallet's UI and can re-render at /dashboard.
 *
 * Detection: `chrome.windows.getCurrent()` reports `type: "popup"` for
 * windows we opened via `chrome.windows.create({ type: "popup" })`, and
 * `type: "normal"` for the regular browser windows that host both the
 * toolbar popup view and the side panel. Side-panel callers should
 * gate on `isInSidePanel()` instead.
 */
export async function isInStandalonePopupWindow(): Promise<boolean> {
  try {
    if (typeof chrome === "undefined" || !chrome.windows?.getCurrent) return false;
    const win = await chrome.windows.getCurrent();
    return win?.type === "popup";
  } catch {
    return false;
  }
}

/**
 * Default size for the popup window we spawn from the side panel. Kept
 * in sync with the standalone approve window dimensions used by
 * `background.ts::openApprovalPopup` so the user gets a familiar
 * popup shape regardless of which flow opened it.
 */
const DEFAULT_POPUP_WIDTH = 400;
const DEFAULT_POPUP_HEIGHT = 640;

export type OpenWalletPopupOpts = {
  /** Path within the popup, e.g. `/swap` or `/dashboard`. */
  path: string;
  /** Optional query params appended after the hash path. */
  query?: Record<string, string | number | undefined | null>;
  /** Override the default popup window size. */
  width?: number;
  height?: number;
};

/**
 * Build the `popup.html` URL HashRouter expects for a given path +
 * query. Exposed for tests; production callers use `openWalletPopup`.
 */
export function buildPopupUrl(opts: OpenWalletPopupOpts): string {
  const params = new URLSearchParams();
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
  }
  const queryString = params.toString();
  const suffix = queryString ? `?${queryString}` : "";
  const normalisedPath = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  return chrome.runtime.getURL(`/popup.html#${normalisedPath}${suffix}`);
}

/**
 * Spawn a standalone popup window pointed at the given hash path.
 * Throws if the `chrome.windows` API is unavailable (e.g. when running
 * inside a regular tab during a unit test).
 */
export async function openWalletPopup(opts: OpenWalletPopupOpts): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.windows?.create) {
    throw new Error(
      "Popup window unavailable: chrome.windows API is missing from this context.",
    );
  }
  await chrome.windows.create({
    url: buildPopupUrl(opts),
    type: "popup",
    width: opts.width ?? DEFAULT_POPUP_WIDTH,
    height: opts.height ?? DEFAULT_POPUP_HEIGHT,
    focused: true,
  });
}
