/**
 * Size of the standalone popup windows opened with
 * `chrome.windows.create({ type: "popup" })`.
 *
 * The toolbar bubble cannot be resized — Chrome sizes it to the
 * document and ignores drag. These windows can. We remember the last
 * outer size the user left them at so the next approve / pop-out
 * window opens the same way.
 */

export const POPUP_BOUNDS_KEY = "arch_wallet_popup_bounds";

export const DEFAULT_POPUP_WIDTH = 400;
export const DEFAULT_POPUP_HEIGHT = 640;

const MIN_WIDTH = 360;
const MIN_HEIGHT = 480;
const MAX_WIDTH = 2400;
const MAX_HEIGHT = 1600;

export interface PopupBounds {
  width: number;
  height: number;
}

export const DEFAULT_POPUP_BOUNDS: PopupBounds = {
  width: DEFAULT_POPUP_WIDTH,
  height: DEFAULT_POPUP_HEIGHT,
};

/**
 * The wallet window to focus when the toolbar icon is clicked again.
 * Approve prompts are separate windows and must not steal that click.
 */
export function selectResizableWalletWindow(
  contexts: ReadonlyArray<{ documentUrl?: string; windowId?: number }>,
): number | undefined {
  for (const ctx of contexts) {
    const url = ctx.documentUrl ?? "";
    if (!url.includes("/popup.html")) continue;
    if (url.includes("#/approve/")) continue;
    if (ctx.windowId == null || ctx.windowId < 0) continue;
    return ctx.windowId;
  }
  return undefined;
}

/** Drop sizes that would open a window off the usable range. */
export function sanitizePopupBounds(value: unknown): PopupBounds | null {
  if (!value || typeof value !== "object") return null;
  const width = (value as { width?: unknown }).width;
  const height = (value as { height?: unknown }).height;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const rounded = { width: Math.round(width), height: Math.round(height) };
  if (
    rounded.width < MIN_WIDTH ||
    rounded.height < MIN_HEIGHT ||
    rounded.width > MAX_WIDTH ||
    rounded.height > MAX_HEIGHT
  ) {
    return null;
  }
  return rounded;
}

export async function readPopupBounds(): Promise<PopupBounds> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return DEFAULT_POPUP_BOUNDS;
    }
    const stored = (await chrome.storage.local.get(POPUP_BOUNDS_KEY))[POPUP_BOUNDS_KEY];
    return sanitizePopupBounds(stored) ?? DEFAULT_POPUP_BOUNDS;
  } catch {
    return DEFAULT_POPUP_BOUNDS;
  }
}

/**
 * Persist the outer window size while the user drags a standalone
 * popup. No-op in the toolbar bubble, which never receives a real
 * resize and is not marked `data-layout="fluid"`.
 */
export function rememberPopupBoundsOnResize(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    if (document.documentElement.dataset.layout !== "fluid") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void chrome.windows
        .getCurrent()
        .then((win) => {
          const bounds = sanitizePopupBounds({ width: win?.width, height: win?.height });
          if (!bounds) return;
          return chrome.storage.local.set({ [POPUP_BOUNDS_KEY]: bounds });
        })
        .catch(() => {});
    }, 200);
  });
}
