/**
 * Chrome notifications wrapper for transaction outcomes.
 *
 * The wallet fires a system notification when a tx is broadcast (so
 * the user sees the outcome even after closing the popup) and when
 * a broadcast attempt fails. Click-to-explorer is handled by the SW
 * via `installNotificationClickHandler` which reads a small click
 * map from `chrome.storage.local`.
 *
 * Privacy:
 *   - Notification text deliberately omits recipient addresses and
 *     payloads. OS-level notification history may persist to disk.
 *   - Only the amount + asset are surfaced. Users tap through to the
 *     explorer to see destination / status.
 *   - Failure notifications never include error stack traces or
 *     raw responses; only the short caller-supplied summary.
 *
 * Errors:
 *   - All chrome.notifications calls are wrapped in try/catch and
 *     swallow failures. If the user declined the install-time
 *     permission, or the API is unavailable in some realm, the
 *     wallet keeps working silently. The on-screen success view in
 *     Send.tsx still renders.
 */

const CLICKMAP_KEY = "arch_wallet_notif_clickmap";
const MAX_CLICKMAP_ENTRIES = 50;

interface ClickMapEntry {
  /** Destination URL when the user clicks the notification. */
  url: string;
  /** Unix-ms timestamp; used to prune old entries. */
  ts: number;
}

type ClickMap = Record<string, ClickMapEntry>;

interface ChromeNotificationsLike {
  create: (
    id: string,
    options: {
      type: "basic";
      iconUrl: string;
      title: string;
      message: string;
      priority?: number;
    },
    callback?: (id: string) => void,
  ) => void;
  clear: (id: string, callback?: (wasCleared: boolean) => void) => void;
  onClicked: {
    addListener: (cb: (id: string) => void) => void;
  };
}

interface ChromeStorageAreaLike {
  get: (
    keys: string | string[] | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ) => Promise<Record<string, unknown>> | void;
  set: (
    items: Record<string, unknown>,
    callback?: () => void,
  ) => Promise<void> | void;
}

function getChrome(): {
  notifications?: ChromeNotificationsLike;
  storageLocal?: ChromeStorageAreaLike;
  tabs?: { create: (opts: { url: string }) => Promise<unknown> | unknown };
  runtime?: { getURL: (path: string) => string };
} {
  const c = (globalThis as any).chrome;
  return {
    notifications: c?.notifications,
    storageLocal: c?.storage?.local,
    tabs: c?.tabs,
    runtime: c?.runtime,
  };
}

async function readClickMap(): Promise<ClickMap> {
  const { storageLocal } = getChrome();
  if (!storageLocal) return {};
  try {
    const res = (await storageLocal.get(CLICKMAP_KEY)) as Record<string, unknown>;
    const raw = res?.[CLICKMAP_KEY];
    if (raw && typeof raw === "object") return raw as ClickMap;
    return {};
  } catch {
    return {};
  }
}

async function writeClickMap(map: ClickMap): Promise<void> {
  const { storageLocal } = getChrome();
  if (!storageLocal) return;
  try {
    await storageLocal.set({ [CLICKMAP_KEY]: map });
  } catch {
    /* storage write failed -- not worth surfacing */
  }
}

/**
 * Prune the click map to the most recent N entries. Cheap O(N log N)
 * since the cap is small and the map is bounded by user activity.
 */
function prune(map: ClickMap, cap = MAX_CLICKMAP_ENTRIES): ClickMap {
  const entries = Object.entries(map);
  if (entries.length <= cap) return map;
  const sorted = entries.sort((a, b) => b[1].ts - a[1].ts).slice(0, cap);
  return Object.fromEntries(sorted);
}

function defaultIconUrl(): string {
  const { runtime } = getChrome();
  try {
    return runtime?.getURL("icon/128.png") ?? "";
  } catch {
    return "";
  }
}

/**
 * Fire a success notification for a broadcast transaction. Returns
 * the notification id (or `null` if the API was unavailable). Caller
 * doesn't need to await; the surface is fire-and-forget.
 *
 * `explorerUrl` is stored in chrome.storage.local under the
 * generated notification id so the SW's click handler can open it.
 */
export async function notifyTxBroadcast(opts: {
  title: string;
  message: string;
  explorerUrl?: string;
  iconUrl?: string;
}): Promise<string | null> {
  const { notifications } = getChrome();
  if (!notifications) return null;

  const id = `arch-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    notifications.create(id, {
      type: "basic",
      iconUrl: opts.iconUrl || defaultIconUrl(),
      title: opts.title,
      message: opts.message,
      priority: 1,
    });
  } catch {
    return null;
  }

  if (opts.explorerUrl) {
    const map = await readClickMap();
    map[id] = { url: opts.explorerUrl, ts: Date.now() };
    await writeClickMap(prune(map));
  }

  return id;
}

/**
 * Fire a failure notification. No click action — failures don't
 * have an explorer URL to deep-link to, and tapping a "broadcast
 * failed" notification to do nothing is worse than tapping it to
 * just dismiss.
 */
export async function notifyTxFailed(opts: {
  title: string;
  message: string;
  iconUrl?: string;
}): Promise<string | null> {
  const { notifications } = getChrome();
  if (!notifications) return null;
  const id = `arch-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    notifications.create(id, {
      type: "basic",
      iconUrl: opts.iconUrl || defaultIconUrl(),
      title: opts.title,
      message: opts.message,
      priority: 2,
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * Wire `chrome.notifications.onClicked` in the SW realm so that
 * clicking a broadcast notification opens its associated explorer
 * URL in a new tab. Idempotent across invocations -- chrome dedupes
 * identical listener registrations within the same SW lifetime, and
 * the SW realm only boots once per session in practice.
 *
 * Failure-mode notifications have no click map entry and are
 * therefore just dismissed on click.
 */
export function installNotificationClickHandler(): void {
  const { notifications, tabs } = getChrome();
  if (!notifications?.onClicked?.addListener) return;

  notifications.onClicked.addListener(async (id: string) => {
    const map = await readClickMap();
    const entry = map[id];
    try {
      if (entry?.url && tabs?.create) {
        await tabs.create({ url: entry.url });
      }
    } catch {
      /* tab open failed -- swallow */
    }
    try {
      notifications.clear(id);
    } catch {
      /* clear failed -- harmless */
    }
    if (entry) {
      delete map[id];
      await writeClickMap(map);
    }
  });
}

/**
 * Build the explorer URL for a freshly-broadcast transaction.
 * Centralized here so the Send / Approve callers don't reimplement
 * the same string concatenation that already lives in Send.tsx.
 */
export function buildExplorerUrl(opts: {
  kind: "btc" | "arch";
  txid: string;
  network: "mainnet" | "testnet4";
}): string {
  if (opts.kind === "btc") {
    return opts.network === "testnet4"
      ? `https://mempool.space/testnet4/tx/${opts.txid}`
      : `https://mempool.space/tx/${opts.txid}`;
  }
  return opts.network === "testnet4"
    ? `https://explorer.arch.network/testnet/tx/${opts.txid}`
    : `https://explorer.arch.network/mainnet/tx/${opts.txid}`;
}

/** Test-only reset of the click map. */
export async function __resetClickMapForTests(): Promise<void> {
  await writeClickMap({});
}
