import { walletStore } from "../src/state/wallet-store";
import type { PendingRequest } from "../src/messaging/types";
import type { OpenAsMode } from "../src/state/types";

const pendingRequests = new Map<string, PendingRequest>();

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Configure the toolbar action so clicking the icon opens either the popup
 * window or the Chrome side panel, per the user's preference.
 *
 *  popup     -> action has popup.html attached, no side-panel hijack
 *  sidepanel -> action has no popup; chrome.sidePanel intercepts the click
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
  const state = await walletStore.getState();
  await applyOpenAsPreference(state.openAs ?? "sidepanel");
}

export default defineBackground(() => {
  walletStore.initialize();

  syncOpenAsFromStorage();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.arch_wallet_state) return;
    const next = changes.arch_wallet_state.newValue as { openAs?: OpenAsMode } | undefined;
    const prev = changes.arch_wallet_state.oldValue as { openAs?: OpenAsMode } | undefined;
    if (next?.openAs && next.openAs !== prev?.openAs) {
      applyOpenAsPreference(next.openAs);
    }
  });

  chrome.runtime.onMessage.addListener(
    (message: any, sender, sendResponse: (r: any) => void) => {

      // --- Internal messages from the Approve popup ---

      if (message?.type === "GET_PENDING_REQUEST") {
        const req = pendingRequests.get(message.requestId);
        sendResponse(req ?? null);
        return false;
      }

      if (message?.type === "APPROVE_CONNECT") {
        walletStore.connectSite(message.origin, {
          origin: message.origin,
          connectedAt: Date.now(),
          accountId: message.account?.address ?? "",
        });
        pendingRequests.delete(message.requestId);

        // Broadcast result to all content scripts
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                channel: "arch-wallet-provider",
                direction: "to-page",
                requestId: message.requestId,
                response: { success: true, data: message.account },
              }).catch(() => {});
            }
          }
        });
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "APPROVE_REQUEST") {
        pendingRequests.delete(message.requestId);
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                channel: "arch-wallet-provider",
                direction: "to-page",
                requestId: message.requestId,
                response: { success: true, data: message.result },
              }).catch(() => {});
            }
          }
        });
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "REJECT_REQUEST") {
        pendingRequests.delete(message.requestId);
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                channel: "arch-wallet-provider",
                direction: "to-page",
                requestId: message.requestId,
                response: { success: false, error: "User rejected the request" },
              }).catch(() => {});
            }
          }
        });
        sendResponse({ ok: true });
        return false;
      }

      // --- Provider messages from content scripts ---

      handleProviderRequest(message, sender).then(sendResponse).catch((err) => {
        sendResponse({ id: message?.id, success: false, error: err?.message || "Internal error" });
      });
      return true;
    }
  );

  chrome.runtime.onInstalled.addListener(() => {
    // Apply the user's stored open-as preference; first-run will default
    // to sidepanel via DEFAULT_STATE.
    syncOpenAsFromStorage();
  });

  async function handleProviderRequest(msg: any, sender: chrome.runtime.MessageSender) {
    const origin = sender.tab?.url
      ? new URL(sender.tab.url).origin
      : sender.url
        ? new URL(sender.url).origin
        : "unknown";

    switch (msg?.type) {
      case "GET_ACCOUNT": {
        const account = await walletStore.getActiveAccount();
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
        const state = await walletStore.getState();
        if (!state.initialized) return { id: msg.id, success: false, error: "Wallet not initialized" };

        if (!state.locked) {
          const connected = await walletStore.isSiteConnected(origin);
          if (connected) {
            const account = await walletStore.getActiveAccount();
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
        }

        const reqId = genId();
        pendingRequests.set(reqId, {
          id: reqId,
          type: "CONNECT",
          origin,
          createdAt: Date.now(),
        });

        const url = chrome.runtime.getURL(`/popup.html#/approve/${reqId}`);
        await chrome.windows.create({ url, type: "popup", width: 400, height: 640, focused: true });

        // Return a "pending" marker -- the content script will wait for the
        // broadcast from the approve/reject handler above.
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
        const connected = await walletStore.isSiteConnected(origin);
        if (!connected) return { id: msg.id, success: false, error: "Site not connected" };

        const reqId = genId();
        pendingRequests.set(reqId, {
          id: reqId,
          type: msg.type,
          origin,
          payload: msg.payload,
          createdAt: Date.now(),
        });

        const url = chrome.runtime.getURL(`/popup.html#/approve/${reqId}`);
        await chrome.windows.create({ url, type: "popup", width: 400, height: 640, focused: true });

        return { id: msg.id, success: false, error: "__PENDING__", requestId: reqId };
      }

      default:
        return { id: msg.id, success: false, error: `Unknown message type: ${msg?.type}` };
    }
  }
});
