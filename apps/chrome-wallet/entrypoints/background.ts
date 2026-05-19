// Buffer shim MUST be first -- some signing utilities (BIP-322 / PSBT)
// pulled in via the wallet store transitively reference `Buffer` at
// module init when used from the service worker context.
import "../src/utils/buffer-polyfill";
import { walletStore } from "../src/state/wallet-store";
import { pendingRequestsStore } from "../src/messaging/pending-requests";
import { keystore } from "../src/crypto/keystore";
import type { PendingRequest } from "../src/messaging/types";
import type { OpenAsMode } from "../src/state/types";
import { DEFAULT_SITE_PERMISSIONS } from "../src/state/types";

const AUTO_LOCK_ALARM = "arch-wallet-auto-lock";
const PENDING_GC_ALARM = "arch-wallet-pending-gc";
const PENDING_TTL_MS = 5 * 60 * 1000;

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
 * Reject every still-pending dapp request that originated from a window
 * we're about to close. Called both on chrome.windows.onRemoved and on
 * the alarms-based GC sweep.
 */
async function rejectAndCleanup(requestId: string, reason: string): Promise<void> {
  await pendingRequestsStore.remove(requestId);
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs
          .sendMessage(tab.id, {
            channel: "arch-wallet-provider",
            direction: "to-page",
            requestId,
            response: { success: false, error: reason },
          })
          .catch(() => {});
      }
    }
  });
}

export default defineBackground(() => {
  walletStore.initialize();
  syncOpenAsFromStorage();
  pendingRequestsStore.clearAll(); // SW boot: drop any stale entries.

  chrome.alarms.create(PENDING_GC_ALARM, { periodInMinutes: 1 });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.arch_wallet_keystore) return;
    // Re-sync open-as in case the user toggled it from the UI.
    syncOpenAsFromStorage();
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

      // --- Internal messages from the Approve popup ---

      if (message?.type === "GET_PENDING_REQUEST") {
        pendingRequestsStore.get(message.requestId).then((req) => sendResponse(req ?? null));
        return true;
      }

      if (message?.type === "USER_ACTIVE") {
        rescheduleAutoLock();
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "APPROVE_CONNECT") {
        (async () => {
          const accountId = message.account?.address ?? "";
          await walletStore.connectSite(message.origin, {
            origin: message.origin,
            name: message.dappName,
            iconUrl: message.iconUrl,
            connectedAt: Date.now(),
            accountId,
            permissions: message.permissions ?? { ...DEFAULT_SITE_PERMISSIONS },
          });
          await pendingRequestsStore.remove(message.requestId);
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id) {
                chrome.tabs
                  .sendMessage(tab.id, {
                    channel: "arch-wallet-provider",
                    direction: "to-page",
                    requestId: message.requestId,
                    response: { success: true, data: message.account },
                  })
                  .catch(() => {});
              }
            }
          });
          sendResponse({ ok: true });
        })();
        return true;
      }

      if (message?.type === "APPROVE_REQUEST") {
        (async () => {
          await pendingRequestsStore.remove(message.requestId);
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id) {
                chrome.tabs
                  .sendMessage(tab.id, {
                    channel: "arch-wallet-provider",
                    direction: "to-page",
                    requestId: message.requestId,
                    response: { success: true, data: message.result },
                  })
                  .catch(() => {});
              }
            }
          });
          sendResponse({ ok: true });
        })();
        return true;
      }

      if (message?.type === "REJECT_REQUEST") {
        rejectAndCleanup(message.requestId, "User rejected the request").then(() =>
          sendResponse({ ok: true }),
        );
        return true;
      }

      // --- Provider messages from content scripts ---
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
    const origin = sender.tab?.url
      ? new URL(sender.tab.url).origin
      : sender.url
        ? new URL(sender.url).origin
        : "unknown";
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
      case "SIGN_PSBT": {
        if (!unlocked) return { id: msg.id, success: false, error: "Wallet locked" };
        const connected = await walletStore.isSiteConnected(origin);
        if (!connected) return { id: msg.id, success: false, error: "Site not connected" };

        // Per-origin permissions: if the user has granted blanket
        // auto-approval for this method, the request is fulfilled
        // without spawning a popup. Today we still require a popup for
        // every signing request; this scaffold makes Phase 3.2 trivial.
        const permissions = await walletStore.getSitePermissions(origin);
        const allowsAuto =
          permissions &&
          ((msg.type === "SIGN_MESSAGE" && permissions.signMessage) ||
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
