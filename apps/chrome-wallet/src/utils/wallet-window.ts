/**
 * Open-or-focus the standalone wallet window.
 *
 * Popup mode no longer uses the anchored toolbar bubble (it cannot be
 * resized). The service worker opens `popup.html` in a real window and
 * must reuse that window on the next toolbar click. Otherwise every
 * click stacks another copy — the failure mode we saw in Brave, and
 * the same path exists on Chrome.
 *
 * `chrome.runtime.getContexts({ documentUrls })` takes exact URLs, not
 * match patterns. A previous `popup.html*` glob therefore never found
 * HashRouter URLs (`popup.html#/dashboard`). Chrome often ignored the
 * bad filter; Brave throws, and the catch always created a new window.
 */

import {
  listResizableWalletWindowIds,
  readPopupBounds,
  isWalletPopupDocumentUrl,
} from "./popup-bounds";

export const WALLET_WINDOW_ID_KEY = "arch_wallet_window_id";

let cachedWindowId: number | undefined;
let inFlight: Promise<void> | null = null;

export async function rememberWalletWindowId(id: number): Promise<void> {
  if (id < 0) return;
  cachedWindowId = id;
  try {
    await chrome.storage?.session?.set?.({ [WALLET_WINDOW_ID_KEY]: id });
  } catch {
    /* session storage is missing in tests / older browsers */
  }
}

export async function forgetWalletWindowId(id?: number): Promise<void> {
  const stored = await readStoredWindowId();
  if (id != null && stored != null && stored !== id) return;
  cachedWindowId = undefined;
  try {
    await chrome.storage?.session?.remove?.(WALLET_WINDOW_ID_KEY);
  } catch {
    /* ignore */
  }
}

async function readStoredWindowId(): Promise<number | undefined> {
  if (typeof cachedWindowId === "number") return cachedWindowId;
  try {
    const area = chrome.storage?.session;
    if (!area?.get) return undefined;
    const stored = (await area.get(WALLET_WINDOW_ID_KEY))[WALLET_WINDOW_ID_KEY];
    if (typeof stored === "number" && stored >= 0) {
      cachedWindowId = stored;
      return stored;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function windowStillOpen(id: number): Promise<boolean> {
  try {
    const win = await chrome.windows.get(id);
    return win?.id === id;
  } catch {
    return false;
  }
}

async function windowIdsFromContexts(): Promise<number[]> {
  try {
    const getContexts = chrome.runtime?.getContexts;
    if (typeof getContexts !== "function") return [];
    // Empty filter: exact `documentUrls` cannot see HashRouter fragments,
    // and an invalid glob throws in Brave.
    const contexts = await getContexts({});
    return listResizableWalletWindowIds(contexts);
  } catch {
    return [];
  }
}

async function windowIdsFromWindows(): Promise<number[]> {
  try {
    if (!chrome.windows?.getAll) return [];
    const windows = await chrome.windows.getAll({ populate: true });
    return listResizableWalletWindowIds(
      windows.flatMap((win) =>
        (win.tabs ?? []).map((tab) => ({
          documentUrl: tab.url ?? tab.pendingUrl,
          windowId: win.id,
        })),
      ),
    );
  } catch {
    return [];
  }
}

function addUnique(ids: number[], seen: Set<number>, id: number | undefined): void {
  if (id == null || id < 0 || seen.has(id)) return;
  seen.add(id);
  ids.push(id);
}

/** Window ids that currently host the wallet UI, stored id first. */
export async function findResizableWalletWindowIds(): Promise<number[]> {
  const fromContexts = await windowIdsFromContexts();
  const fromWindows = await windowIdsFromWindows();
  const stored = await readStoredWindowId();
  const ids: number[] = [];
  const seen = new Set<number>();
  if (stored != null) {
    if (await windowStillOpen(stored)) addUnique(ids, seen, stored);
    else await forgetWalletWindowId(stored);
  }
  for (const id of fromContexts) addUnique(ids, seen, id);
  for (const id of fromWindows) addUnique(ids, seen, id);
  return ids;
}

async function focusWindow(id: number): Promise<boolean> {
  try {
    const win = await chrome.windows.get(id);
    const update: chrome.windows.UpdateInfo = { focused: true };
    if (win.state === "minimized") update.state = "normal";
    await chrome.windows.update(id, update);
    await rememberWalletWindowId(id);
    return true;
  } catch {
    await forgetWalletWindowId(id);
    return false;
  }
}

/**
 * Last-resort focus via the service worker's WindowClient list. No
 * windowId, so we cannot close extras this way — but we still avoid
 * spawning another copy when the chrome.* lookup APIs are empty.
 */
async function focusExistingWalletClient(): Promise<boolean> {
  try {
    const scope = globalThis as unknown as {
      clients?: {
        matchAll: (opts: {
          type?: string;
          includeUncontrolled?: boolean;
        }) => Promise<Array<{ url?: string; focus?: () => Promise<unknown> }>>;
      };
    };
    if (typeof scope.clients?.matchAll !== "function") return false;
    const found = await scope.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const match = found.find((client) => isWalletPopupDocumentUrl(client.url));
    if (!match?.focus) return false;
    await match.focus();
    return true;
  } catch {
    return false;
  }
}

async function closeWindow(id: number): Promise<void> {
  try {
    await chrome.windows.remove(id);
  } catch {
    /* already closed */
  }
}

async function openOrFocusWalletWindowNow(): Promise<void> {
  const ids = await findResizableWalletWindowIds();
  if (ids.length > 0) {
    const keep = ids[0]!;
    await Promise.all(ids.slice(1).map((id) => closeWindow(id)));
    if (await focusWindow(keep)) return;
  }
  if (await focusExistingWalletClient()) return;

  const bounds = await readPopupBounds();
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("/popup.html"),
    type: "popup",
    width: bounds.width,
    height: bounds.height,
    focused: true,
  });
  if (win?.id != null) await rememberWalletWindowId(win.id);
}

/**
 * Toolbar-icon entry: focus the existing wallet window, closing any
 * stacked copies, or open one if none exist. Concurrent clicks share
 * a single in-flight open so a double-click cannot race two creates.
 */
export async function openOrFocusWalletWindow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = openOrFocusWalletWindowNow().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Drop module state between unit tests. */
export function __resetWalletWindowForTests(): void {
  cachedWindowId = undefined;
  inFlight = null;
}
