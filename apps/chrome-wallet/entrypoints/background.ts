// Buffer shim MUST be first -- some signing utilities (BIP-322 / PSBT)
// pulled in via the wallet store transitively reference `Buffer` at
// module init when used from the service worker context.
import "../src/utils/buffer-polyfill";
import { walletStore } from "../src/state/wallet-store";
import { pendingRequestsStore } from "../src/messaging/pending-requests";
import { keystore } from "../src/crypto/keystore";
import type { PendingRequest } from "../src/messaging/types";
import type { OpenAsMode } from "../src/state/types";
import { DEFAULT_HUB_BASE_URL, DEFAULT_SITE_PERMISSIONS } from "../src/state/types";
import {
  applyDiagnosticsRuntime,
  installGlobalErrorHandlers,
} from "../src/utils/log";

const AUTO_LOCK_ALARM = "arch-wallet-auto-lock";
const PENDING_GC_ALARM = "arch-wallet-pending-gc";
const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * Cryptographically random request id (122 bits of entropy).
 * Previous implementation combined `Date.now()` + 31 bits of
 * `Math.random()`, which was guessable from a co-resident dapp tab
 * and let an attacker forge APPROVE_/REJECT_REQUEST messages.
 */
function genId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? (require("node:crypto") as Crypto)).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SECURITY: every chrome.runtime.onMessage handler must verify the
 * sender, otherwise:
 *   - A co-installed malicious extension can call
 *     `chrome.runtime.sendMessage(OUR_EXTENSION_ID, ...)` and drive
 *     our provider APIs (CONNECT/SIGN_MESSAGE/SIGN_PSBT/SEND_TRANSFER)
 *     while spoofing `sender.tab.url` to make us record a wrong origin.
 *   - The same extension can call APPROVE_REQUEST/REJECT_REQUEST to
 *     consent on the user's behalf without a popup ever opening.
 *
 * We only ever accept messages from our own extension. Anything else
 * is rejected and audited.
 */
function isOwnSender(sender: chrome.runtime.MessageSender): boolean {
  // sender.id is set for both content-script and extension-page
  // senders. Cross-extension messages also carry sender.id but it'll
  // be the *other* extension's id.
  return sender?.id === chrome.runtime.id;
}

/**
 * Approve-popup messages additionally must come from an extension
 * page (popup.html / sidepanel.html), not a content script. Content
 * scripts have `sender.tab` populated; extension pages don't (unless
 * the page is loaded inside a tab, which we treat the same way as a
 * popup since it's still our extension origin).
 */
function isInternalUiSender(sender: chrome.runtime.MessageSender): boolean {
  if (!isOwnSender(sender)) return false;
  const url = sender.url ?? "";
  if (!url) return true; // direct service-worker -> service-worker (rare)
  // chrome-extension://<id>/popup.html ... or sidepanel.html
  if (url.startsWith(chrome.runtime.getURL("/popup.html"))) return true;
  if (url.startsWith(chrome.runtime.getURL("/sidepanel.html"))) return true;
  // chrome-extension://<id>/ for anything else our extension serves.
  return url.startsWith(chrome.runtime.getURL("/"));
}

/**
 * Configure the toolbar action so clicking the icon opens either the popup
 * window or the Chrome side panel, per the user's preference.
 */
async function applyOpenAsPreference(mode: OpenAsMode): Promise<void> {
  try {
    if (mode === "sidepanel" && chrome.sidePanel?.setPanelBehavior) {
      await chrome.action.setPopup({ popup: "" });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } else {
      if (chrome.sidePanel?.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      }
      await chrome.action.setPopup({ popup: "popup.html" });
    }
  } catch (err) {
    console.warn("[arch-wallet] applyOpenAsPreference failed", err);
  }
}

async function syncOpenAsFromStorage(): Promise<void> {
  try {
    const state = await walletStore.getState();
    await applyOpenAsPreference(state.openAs ?? "popup");
  } catch {
    await applyOpenAsPreference("popup");
  }
}

/**
 * Mirror the persisted Diagnostics toggles (debug mode, Sentry
 * opt-in) into the SW realm's `log` module. Swallows errors so a
 * malformed state blob can't take the SW down at boot.
 */
async function syncDiagnosticsFromStorage(): Promise<void> {
  try {
    const state = await walletStore.getState();
    applyDiagnosticsRuntime({
      debugMode: !!state.debugMode,
      sentryOptIn: !!state.sentryOptIn,
    });
  } catch {
    /* boot-time read failure shouldn't block SW startup */
  }
}

/**
 * Reschedule the rolling auto-lock alarm. Called on every user-driven
 * unlock event and every chrome.idle transition back to "active".
 */
async function rescheduleAutoLock(): Promise<void> {
  try {
    const state = await walletStore.getState();
    const minutes = state.autoLockMinutes ?? 15;
    chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
    if (chrome.idle?.setDetectionInterval) {
      // Convert minutes -> seconds, clamp to chrome's 15s..240min window.
      const sec = Math.max(15, Math.min(minutes * 60, 4 * 60 * 60));
      chrome.idle.setDetectionInterval(sec);
    }
  } catch {
    /* ignore */
  }
}

async function lockNow(): Promise<void> {
  await walletStore.lock();
  await pendingRequestsStore.clearAll();
}

/**
 * Deliver an RPC response back to the originating dapp tab only. We
 * used to broadcast to every tab via `chrome.tabs.query({})` which
 * widened leakage of signatures / PSBT bytes: any page with the
 * content script injected could observe other dapps' responses if it
 * could correlate request ids. Per-tab routing closes that hole.
 */
function deliverResponseToTab(
  sourceTabId: number | undefined,
  requestId: string,
  response: { success: boolean; data?: unknown; error?: string },
): void {
  if (typeof sourceTabId !== "number") return;
  chrome.tabs
    .sendMessage(sourceTabId, {
      channel: "arch-wallet-provider",
      direction: "to-page",
      requestId,
      response,
    })
    .catch(() => {});
}

// ── External-wallet connector window ─────────────────────────────────
//
// Rather than depending on whatever tab the user happens to have
// active, we open a small popup window on a URL we control
// (/v1/extension/connect on the configured Hub). External wallets
// (Xverse / UniSat) inject their providers into that page
// because it's a normal http(s) origin, our content script attaches
// automatically (host_permissions: <all_urls>), and we get a stable,
// scriptable target for every bridge call until the flow completes.
//
// Lifecycle:
//   - opened lazily on first bridge call
//   - reused across subsequent calls in the same flow
//   - closed when the popup signals CLOSE_EXTERNAL_CONNECTOR
//   - closed on idle (no bridge call for CONNECTOR_IDLE_MS)
//   - cleared if the user closes the window manually

type ConnectorTab = { windowId: number; tabId: number };
let connectorTab: ConnectorTab | null = null;
let connectorIdleAlarmName = "arch-wallet-external-connector-idle";
const CONNECTOR_IDLE_MS = 90_000;

async function getConnectorUrl(): Promise<string> {
  let base = DEFAULT_HUB_BASE_URL;
  try {
    const state = await walletStore.getState();
    if (state?.hubBaseUrl) base = state.hubBaseUrl;
  } catch {
    /* keystore may be locked or uninitialized; default is fine */
  }
  return `${base.replace(/\/+$/, "")}/v1/extension/connect`;
}

function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      err ? reject(err) : resolve();
    };
    const listener = (changedId: number, info: chrome.tabs.TabChangeInfo) => {
      if (changedId === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(
      () => finish(new Error("Connector window did not finish loading in time")),
      timeoutMs,
    );
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab?.status === "complete") finish();
      },
      () => finish(new Error("Connector tab disappeared")),
    );
  });
}

async function ensureConnectorTab(): Promise<ConnectorTab> {
  if (connectorTab) {
    try {
      const tab = await chrome.tabs.get(connectorTab.tabId);
      if (tab?.id) return connectorTab;
    } catch {
      /* tab gone, fall through */
    }
    connectorTab = null;
  }
  const url = await getConnectorUrl();
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 360,
    height: 440,
    focused: true,
  });
  const tab = win?.tabs?.[0];
  if (!win?.id || !tab?.id) {
    throw new Error("Failed to open Arch Wallet connector window");
  }
  await waitForTabComplete(tab.id);
  connectorTab = { windowId: win.id, tabId: tab.id };
  return connectorTab;
}

async function closeConnectorTab(): Promise<void> {
  const tab = connectorTab;
  connectorTab = null;
  if (!tab) return;
  try {
    await chrome.windows.remove(tab.windowId);
  } catch {
    /* already closed */
  }
}

function scheduleConnectorIdleClose(): void {
  // Single rolling alarm. Each bridge call resets it; we close the
  // window if no activity for CONNECTOR_IDLE_MS. Guards against the
  // popup crashing / being dismissed without the explicit close
  // signal.
  chrome.alarms.create(connectorIdleAlarmName, {
    delayInMinutes: CONNECTOR_IDLE_MS / 60_000,
  });
}

async function requestExternalWalletViaConnector(message: any): Promise<any> {
  const target = await ensureConnectorTab();
  const payload = {
    type: "EXTERNAL_WALLET_PAGE_REQUEST",
    requestId:
      globalThis.crypto?.randomUUID?.() ??
      `external-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    request: message.request,
  };
  scheduleConnectorIdleClose();
  // Refocus the connector window before each bridge call. The
  // external wallet's confirmation UI (Xverse / UniSat)
  // mounts inside the connector page; if the window is in the
  // background the prompt is invisible to the user, which presents
  // as a silent hang while we wait for a response.
  try {
    await chrome.windows.update(target.windowId, { focused: true, drawAttention: true });
  } catch {
    /* window may have been closed between ensureConnectorTab and now */
  }
  try {
    return await chrome.tabs.sendMessage(target.tabId, payload);
  } catch (err: any) {
    if (!String(err?.message ?? "").includes("Receiving end does not exist")) {
      throw err;
    }
    // Content script not attached yet (rare: the page loaded before
    // chrome.scripting bound our matches). Force-inject and retry.
    await chrome.scripting.executeScript({
      target: { tabId: target.tabId },
      files: ["content-scripts/content.js"],
    });
    return await chrome.tabs.sendMessage(target.tabId, payload);
  }
}

/**
 * Reject every still-pending dapp request that originated from a window
 * we're about to close. Called both on chrome.windows.onRemoved and on
 * the alarms-based GC sweep.
 */
async function rejectAndCleanup(requestId: string, reason: string): Promise<void> {
  const pending = await pendingRequestsStore.get(requestId);
  await pendingRequestsStore.remove(requestId);
  deliverResponseToTab(pending?.sourceTabId, requestId, { success: false, error: reason });
}

export default defineBackground(() => {
  walletStore.initialize();
  syncOpenAsFromStorage();
  pendingRequestsStore.clearAll(); // SW boot: drop any stale entries.

  // Install diagnostics in the SW realm. This realm is a different
  // JS context from the popup, so it needs its own boot-time apply +
  // its own global error handlers; popup state changes propagate
  // here via the storage-onChanged listener below.
  installGlobalErrorHandlers(self as unknown as EventTarget);
  syncDiagnosticsFromStorage();

  chrome.alarms.create(PENDING_GC_ALARM, { periodInMinutes: 1 });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.arch_wallet_keystore) {
      // Re-sync open-as in case the user toggled it from the UI.
      syncOpenAsFromStorage();
    }
    if (changes.arch_wallet_state) {
      // Persisted Diagnostics toggles live in the plaintext state
      // blob alongside other Settings flags. Re-apply on every write
      // so a toggle change in the popup is reflected in this realm
      // by the time the next provider request comes through.
      syncDiagnosticsFromStorage();
    }
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) {
      await lockNow();
      return;
    }
    if (alarm.name === PENDING_GC_ALARM) {
      const now = Date.now();
      const all = await pendingRequestsStore.list();
      for (const req of all) {
        if (now - req.createdAt > PENDING_TTL_MS) {
          await rejectAndCleanup(req.id, "Request expired");
        }
      }
    }
    if (alarm.name === connectorIdleAlarmName) {
      await closeConnectorTab();
    }
  });

  if (chrome.idle?.onStateChanged) {
    chrome.idle.onStateChanged.addListener(async (state) => {
      if (state === "locked") {
        await lockNow();
      } else if (state === "active") {
        rescheduleAutoLock();
      }
    });
  }

  if (chrome.windows?.onRemoved) {
    chrome.windows.onRemoved.addListener(async (windowId) => {
      if (connectorTab && connectorTab.windowId === windowId) {
        connectorTab = null;
      }
      const all = await pendingRequestsStore.list();
      for (const req of all) {
        if (req.windowId === windowId) {
          await rejectAndCleanup(req.id, "User rejected the request");
        }
      }
    });
  }

  chrome.runtime.onMessage.addListener(
    (message: any, sender, sendResponse: (r: any) => void) => {
      // SECURITY: reject any cross-extension message outright. The
      // chrome runtime allows other extensions to address us by ID; if
      // we don't filter, they can drive every code path below.
      if (!isOwnSender(sender)) {
        console.warn("[arch-wallet] dropping message from unknown sender", {
          senderId: sender?.id,
          ourId: chrome.runtime.id,
          messageType: message?.type,
        });
        sendResponse({ id: message?.id, success: false, error: "Sender not authorized" });
        return false;
      }

      // --- Internal messages from the Approve popup / side panel ---
      // These all mutate state on the user's behalf (consenting to a
      // dapp request) so they MUST originate from our own UI, never
      // from a content script. `isInternalUiSender` enforces that.

      if (message?.type === "GET_PENDING_REQUEST") {
        if (!isInternalUiSender(sender)) {
          sendResponse(null);
          return false;
        }
        pendingRequestsStore.get(message.requestId).then((req) => sendResponse(req ?? null));
        return true;
      }

      if (message?.type === "USER_ACTIVE") {
        if (!isInternalUiSender(sender)) {
          sendResponse({ ok: false });
          return false;
        }
        rescheduleAutoLock();
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "EXTERNAL_WALLET_REQUEST") {
        if (!isInternalUiSender(sender)) {
          sendResponse({ success: false, error: "Not authorized" });
          return false;
        }
        requestExternalWalletViaConnector(message)
          .then(sendResponse)
          .catch((err) => {
            sendResponse({ success: false, error: err?.message || "External wallet request failed" });
          });
        return true;
      }

      if (message?.type === "CLOSE_EXTERNAL_CONNECTOR") {
        if (!isInternalUiSender(sender)) {
          sendResponse({ ok: false, error: "Not authorized" });
          return false;
        }
        closeConnectorTab().finally(() => sendResponse({ ok: true }));
        return true;
      }

      if (message?.type === "APPROVE_CONNECT") {
        if (!isInternalUiSender(sender)) {
          sendResponse({ ok: false, error: "Not authorized" });
          return false;
        }
        (async () => {
          // Prefer the explicit internal WalletAccount id sent by the
          // approval popup. Older popup builds (pre-fix) only sent the
          // btcAddress under `account.address`, which would silently
          // mis-store as the site's accountId and break GET_ACCOUNT on
          // every subsequent page load -- so we accept the legacy field
          // as a fallback and self-heal it below.
          const explicitId: string | undefined = message.accountId;
          const legacyAddress: string | undefined = message.account?.address;
          let accountId = explicitId || "";
          if (!accountId && legacyAddress) {
            const state = await walletStore.getState();
            const match = state.accounts.find((a) => a.btcAddress === legacyAddress);
            accountId = match?.id ?? "";
          }
          await walletStore.connectSite(message.origin, {
            origin: message.origin,
            name: message.dappName,
            iconUrl: message.iconUrl,
            connectedAt: Date.now(),
            accountId,
            permissions: message.permissions ?? { ...DEFAULT_SITE_PERMISSIONS },
          });
          const pending = await pendingRequestsStore.get(message.requestId);
          await pendingRequestsStore.remove(message.requestId);
          deliverResponseToTab(pending?.sourceTabId, message.requestId, {
            success: true,
            data: message.account,
          });
          sendResponse({ ok: true });
        })();
        return true;
      }

      if (message?.type === "APPROVE_REQUEST") {
        if (!isInternalUiSender(sender)) {
          sendResponse({ ok: false, error: "Not authorized" });
          return false;
        }
        (async () => {
          const pending = await pendingRequestsStore.get(message.requestId);
          await pendingRequestsStore.remove(message.requestId);
          deliverResponseToTab(pending?.sourceTabId, message.requestId, {
            success: true,
            data: message.result,
          });
          sendResponse({ ok: true });
        })();
        return true;
      }

      if (message?.type === "REJECT_REQUEST") {
        if (!isInternalUiSender(sender)) {
          sendResponse({ ok: false, error: "Not authorized" });
          return false;
        }
        rejectAndCleanup(message.requestId, "User rejected the request").then(() =>
          sendResponse({ ok: true }),
        );
        return true;
      }

      // --- Provider messages from content scripts ---
      // These MUST come from a tab (sender.tab is set), not from
      // another extension page (extension page messages should be the
      // internal handlers above).
      if (!sender.tab?.id || !sender.tab?.url) {
        sendResponse({ id: message?.id, success: false, error: "Provider messages require a tab context" });
        return false;
      }
      handleProviderRequest(message, sender)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({ id: message?.id, success: false, error: err?.message || "Internal error" });
        });
      return true;
    },
  );

  chrome.runtime.onInstalled.addListener(() => {
    syncOpenAsFromStorage();
  });

  async function openApprovalPopup(req: PendingRequest): Promise<number | undefined> {
    const url = chrome.runtime.getURL(`/popup.html#/approve/${req.id}`);
    const win = await chrome.windows.create({
      url,
      type: "popup",
      width: 400,
      height: 640,
      focused: true,
    });
    return win?.id;
  }

  async function handleProviderRequest(msg: any, sender: chrome.runtime.MessageSender) {
    // Origin derivation: only from sender.tab.url. We already
    // rejected non-tab senders above, so `sender.tab.url` is the
    // authoritative source. Do NOT fall back to `sender.url` because
    // for cross-extension messages that field would be attacker-set
    // (and we've rejected those above, but keep this defensive).
    const tabUrl = sender.tab?.url ?? "";
    if (!tabUrl) {
      return { id: msg?.id, success: false, error: "Missing tab origin" };
    }
    const origin = new URL(tabUrl).origin;
    const sourceTabId = sender.tab?.id;
    const dappName = sender.tab?.title;
    const dappIconUrl = sender.tab?.favIconUrl;

    const unlocked = await keystore.isUnlocked();

    switch (msg?.type) {
      case "PING": {
        return { id: msg.id, success: true, data: { ok: true } };
      }
      case "GET_ACCOUNT": {
        if (!unlocked) return { id: msg.id, success: false, error: "Wallet locked" };
        // SECURITY: previously we returned address/pubkey to ANY site
        // the extension was injected into (which is `<all_urls>`).
        // Connecting requires user consent; identity reads must too,
        // otherwise every banking/healthcare/etc. site fingerprints
        // the user's wallet without opt-in.
        const connected = await walletStore.isSiteConnected(origin);
        if (!connected) {
          return { id: msg.id, success: false, error: "Site not connected" };
        }
        const account = await walletStore.getAccountForOrigin(origin);
        if (!account) return { id: msg.id, success: false, error: "No active account" };
        return {
          id: msg.id,
          success: true,
          data: {
            address: account.btcAddress,
            publicKey: account.publicKeyHex,
            archAddress: account.archAddress,
          },
        };
      }

      case "CONNECT": {
        const sealed = await keystore.isSealed();
        if (!sealed) return { id: msg.id, success: false, error: "Wallet not initialized" };
        if (!unlocked) return { id: msg.id, success: false, error: "Wallet locked" };

        const connected = await walletStore.isSiteConnected(origin);
        if (connected) {
          const account = await walletStore.getAccountForOrigin(origin);
          return {
            id: msg.id,
            success: true,
            data: {
              address: account?.btcAddress,
              publicKey: account?.publicKeyHex,
              archAddress: account?.archAddress,
            },
          };
        }

        const reqId = genId();
        const req: PendingRequest = {
          id: reqId,
          type: "CONNECT",
          origin,
          dappName,
          dappIconUrl,
          createdAt: Date.now(),
          sourceTabId,
        };
        const windowId = await openApprovalPopup(req);
        await pendingRequestsStore.set({ ...req, windowId });

        return { id: msg.id, success: false, error: "__PENDING__", requestId: reqId };
      }

      case "DISCONNECT": {
        await walletStore.disconnectSite(origin);
        return { id: msg.id, success: true };
      }

      case "SEND_TRANSFER":
      case "SEND_TOKEN_TRANSFER":
      case "SIGN_MESSAGE":
      case "SIGN_ARCH_MESSAGE_HASH":
      case "SIGN_PSBT": {
        if (!unlocked) return { id: msg.id, success: false, error: "Wallet locked" };
        const connected = await walletStore.isSiteConnected(origin);
        if (!connected) return { id: msg.id, success: false, error: "Site not connected" };

        // Sanity-check the SIGN_ARCH_MESSAGE_HASH payload BEFORE opening
        // the popup so a malformed dapp request fails fast and the user
        // never sees a useless prompt. We require exactly 64 lowercase
        // hex chars (32-byte SanitizedMessage hash). Anything else --
        // wrong length, non-hex, mixed case -- is dapp programmer error.
        if (msg.type === "SIGN_ARCH_MESSAGE_HASH") {
          const hex = (msg as any).payload?.messageHashHex;
          if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) {
            return {
              id: msg.id,
              success: false,
              error:
                "SIGN_ARCH_MESSAGE_HASH requires payload.messageHashHex = 64 lowercase hex chars (32-byte hash)",
            };
          }
        }

        // Per-origin permissions.
        //
        // SECURITY POSTURE (2026-05): the previous scaffold computed
        // `allowsAuto` and stamped it onto every PendingRequest, but
        // never actually consumed it. The popup-bypass path that would
        // have honored the flag was never wired, leaving a footgun: a
        // future change that connects the popup-skip path would
        // instantly become a silent-sign vector for any dapp that ever
        // received an auto-approve permission.
        //
        // We now compute `allowsAuto` ONLY for telemetry/UX hinting in
        // the popup ("This site has auto-approve enabled — Approve in
        // one click") and never persist it as a directive. Silent
        // signing requires a separate, deliberate code path with its
        // own re-auth gate; until that exists, no message-type can
        // bypass the approval popup.
        const permissions = await walletStore.getSitePermissions(origin);
        const allowsAuto =
          permissions &&
          ((msg.type === "SIGN_MESSAGE" && permissions.signMessage) ||
            (msg.type === "SIGN_ARCH_MESSAGE_HASH" &&
              permissions.signArchMessageHash) ||
            (msg.type === "SIGN_PSBT" && permissions.signPsbt) ||
            ((msg.type === "SEND_TRANSFER" || msg.type === "SEND_TOKEN_TRANSFER") &&
              permissions.sendTransfer));

        const reqId = genId();
        const req: PendingRequest = {
          id: reqId,
          type: msg.type,
          origin,
          payload: msg.payload,
          dappName,
          dappIconUrl,
          createdAt: Date.now(),
          sourceTabId,
          // UI-only hint; the background NEVER acts on this flag
          // (popup is always opened above via `openApprovalPopup`).
          autoApproveAllowed: !!allowsAuto,
        };
        const windowId = await openApprovalPopup(req);
        await pendingRequestsStore.set({ ...req, windowId });

        return { id: msg.id, success: false, error: "__PENDING__", requestId: reqId };
      }

      default:
        return { id: msg.id, success: false, error: `Unknown message type: ${msg?.type}` };
    }
  }
});
