/**
 * Dismiss the standalone wallet window.
 *
 * Brave reports `chrome.windows.create({ type: "popup" })` windows as
 * normal browser windows. `window.close()` is then a silent no-op
 * ("Scripts may close only the windows that were opened by it"), so
 * an approve prompt that called `window.close()` stayed on screen.
 * `chrome.windows.remove`, run from the service worker, is not subject
 * to that check — the same call already closes stacked copies.
 *
 * The toolbar window also has to go away when the user clicks back to
 * the page, the way the old anchored bubble did. It must stay up while
 * a passkey sheet or the external-wallet connector has focus, or those
 * ceremonies lose the page that started them.
 */

export const CLOSE_THIS_WINDOW_MESSAGE = "CLOSE_THIS_WINDOW";
export const SHOULD_CLOSE_WALLET_WINDOW_MESSAGE = "SHOULD_CLOSE_WALLET_WINDOW";

const SUPPRESS_KEY = "arch_wallet_autoclose_suppress_until";
const HOLD_KEY = "arch_wallet_autoclose_hold";

/** Ignore a focus flicker while a window is being created or refocused. */
export const AUTOCLOSE_SUPPRESS_MS = 2_000;

/** After a passkey or connector prompt, give the page time to finish. */
const HOLD_RELEASE_GRACE_MS = 2_000;

const HOLD_TTL_MS = 180_000;

const BLUR_SETTLE_MS = 700;
const STARTUP_GRACE_MS = 800;

/**
 * In-memory so a toolbar click suppresses dismiss before the session
 * write resolves. This is per JavaScript realm: the service worker's
 * copy is the one `walletDismissAllowed` reads.
 */
let suppressUntil = 0;

export interface WalletHoldState {
  count: number;
  until: number;
}

type AutoCloseAction = "close" | "wait" | "stay";

let holdChain: Promise<void> = Promise.resolve();
let blurTimer: ReturnType<typeof setTimeout> | undefined;

function sessionArea(): chrome.storage.StorageArea | undefined {
  try {
    if (typeof chrome === "undefined") return undefined;
    return chrome.storage?.session;
  } catch {
    return undefined;
  }
}

export function isApprovalHash(hash: string): boolean {
  return hash.startsWith("#/approve");
}

/** Recovery asks the user to read email and copy a password in another app. */
export function isRecoveryHash(hash: string): boolean {
  return hash.startsWith("#/recover");
}

/**
 * `stay` — focused, an approve prompt (those close only after a decision),
 * or recovery (the user is in Mail or a password manager on purpose).
 * `wait` — unfocused, but a passkey, connector, or toolbar click still needs it.
 * `close` — the user has moved on.
 */
export function walletAutoCloseAction(input: {
  hasFocus: boolean;
  hash: string;
  blocked: boolean;
}): AutoCloseAction {
  if (input.hasFocus || isApprovalHash(input.hash) || isRecoveryHash(input.hash)) return "stay";
  if (input.blocked) return "wait";
  return "close";
}

/**
 * Whether the service worker should let the wallet window dismiss.
 * False during a toolbar click (including before the storage write
 * lands), a passkey prompt, or the external-wallet connector.
 */
export async function walletDismissAllowed(now = Date.now()): Promise<boolean> {
  if (suppressUntil > now) return false;
  return !(await autoCloseBlocked(now));
}

export async function autoCloseBlocked(now = Date.now()): Promise<boolean> {
  const area = sessionArea();
  if (!area?.get) return false;
  try {
    const stored = await area.get([SUPPRESS_KEY, HOLD_KEY]);
    const storedSuppressUntil = stored[SUPPRESS_KEY];
    if (typeof storedSuppressUntil === "number" && storedSuppressUntil > now) return true;
    const hold = stored[HOLD_KEY] as WalletHoldState | undefined;
    if (
      hold &&
      typeof hold.count === "number" &&
      hold.count > 0 &&
      typeof hold.until === "number" &&
      hold.until > now
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Toolbar click / fresh popup: don't treat the opening focus change as "user left". */
export async function suppressWalletAutoClose(ms = AUTOCLOSE_SUPPRESS_MS): Promise<void> {
  const until = Date.now() + ms;
  // Synchronous: a toolbar click must win against the blur it just caused,
  // even when the storage write is still in flight.
  if (until > suppressUntil) suppressUntil = until;
  const area = sessionArea();
  if (!area?.set) return;
  try {
    await area.set({ [SUPPRESS_KEY]: until });
  } catch {
    /* session storage is missing in tests */
  }
}

export async function holdWalletWindow(ms = HOLD_TTL_MS): Promise<void> {
  await writeHold((prev, now) => ({
    count: (prev?.count ?? 0) + 1,
    until: now + ms,
  }));
}

export async function releaseWalletWindowHold(): Promise<void> {
  // Suppress first so a blur check cannot land in the gap between
  // "hold is gone" and "grace period has started".
  await suppressWalletAutoClose(HOLD_RELEASE_GRACE_MS);
  await writeHold((prev) => {
    const count = (prev?.count ?? 0) - 1;
    if (count <= 0 || !prev) return null;
    return { count, until: prev.until };
  });
}

/** Keep the wallet window up for the duration of `task` (passkey prompt, connector). */
export async function withWalletWindowHeld<T>(task: () => Promise<T>): Promise<T> {
  await holdWalletWindow();
  try {
    return await task();
  } finally {
    await releaseWalletWindowHold();
  }
}

async function writeHold(
  update: (prev: WalletHoldState | undefined, now: number) => WalletHoldState | null,
): Promise<void> {
  const run = holdChain.then(async () => {
    const area = sessionArea();
    if (!area?.get || !area.set) return;
    const now = Date.now();
    const stored = await area.get(HOLD_KEY);
    const prev = stored[HOLD_KEY] as WalletHoldState | undefined;
    const live =
      prev && typeof prev.count === "number" && typeof prev.until === "number" && prev.until > now
        ? prev
        : undefined;
    const next = update(live, now);
    if (!next || next.count <= 0) {
      if (area.remove) await area.remove(HOLD_KEY);
      return;
    }
    await area.set({ [HOLD_KEY]: next });
  });
  holdChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Close the window this page is running in. Asks the service worker
 * first — that path works on Brave — then tries the windows API locally,
 * then `window.close()` for the toolbar bubble.
 */
export async function closeThisExtensionWindow(): Promise<boolean> {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const res = await chrome.runtime.sendMessage({ type: CLOSE_THIS_WINDOW_MESSAGE });
      if (res?.ok) return true;
    }
  } catch {
    /* the window may already be going away */
  }
  try {
    if (typeof chrome !== "undefined" && chrome.windows?.getCurrent && chrome.windows.remove) {
      const win = await chrome.windows.getCurrent();
      if (typeof win?.id === "number") {
        await chrome.windows.remove(win.id);
        return true;
      }
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof window !== "undefined") window.close();
    return typeof window !== "undefined";
  } catch {
    return false;
  }
}

/**
 * Ask the service worker. It knows about a toolbar click before the
 * session write is visible, which is the race that would close the
 * window and immediately open a replacement.
 */
async function dismissBlocked(): Promise<boolean> {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const res = await chrome.runtime.sendMessage({ type: SHOULD_CLOSE_WALLET_WINDOW_MESSAGE });
      if (typeof res?.close === "boolean") return !res.close;
    }
  } catch {
    /* service worker asleep or torn down; use the stored flags */
  }
  return autoCloseBlocked();
}

function inSidePanel(): boolean {
  try {
    return document.documentElement.dataset.mode === "sidepanel";
  } catch {
    return false;
  }
}

/**
 * Close this wallet window once it loses focus, unless an approve
 * prompt, a passkey ceremony, or the external-wallet connector needs it.
 * No-op in the side panel, which is not a popup.
 */
export function installWalletWindowAutoClose(): void {
  if (typeof window === "undefined" || inSidePanel()) return;
  const openedAt = Date.now();
  let failedCloses = 0;

  const arm = () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = undefined;
      void check();
    }, BLUR_SETTLE_MS);
  };

  const check = async () => {
    const startup = Date.now() - openedAt < STARTUP_GRACE_MS;
    let blocked = startup;
    if (!blocked) blocked = await dismissBlocked();
    const action = walletAutoCloseAction({
      hasFocus: document.hasFocus(),
      hash: window.location.hash,
      blocked,
    });
    if (action === "close") {
      const closed = await closeThisExtensionWindow();
      if (!closed && failedCloses < 3) {
        failedCloses += 1;
        arm();
      }
      return;
    }
    failedCloses = 0;
    if (action === "wait") arm();
  };

  window.addEventListener("focus", () => {
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = undefined;
    }
  });
  window.addEventListener("blur", () => {
    if (isApprovalHash(window.location.hash) || isRecoveryHash(window.location.hash)) return;
    arm();
  });
}

/** Drop module state between unit tests. */
export function __resetWalletAutoCloseForTests(): void {
  holdChain = Promise.resolve();
  suppressUntil = 0;
  if (blurTimer) clearTimeout(blurTimer);
  blurTimer = undefined;
}
