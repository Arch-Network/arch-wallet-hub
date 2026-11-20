/**
 * Content script bridge between the dapp's MAIN world (where the
 * injected provider lives) and the extension's service worker.
 *
 * Hardenings (Phase 1.4 + 3.3 + 3.4):
 *   - `postMessage` is scoped to `window.location.origin` instead of "*".
 *   - Outgoing dapp messages and incoming SW broadcasts are tagged
 *     with a `nonce` so we don't accept messages from unrelated
 *     extensions or other content scripts that might inject the same
 *     channel name.
 *   - A heartbeat (`PING`) is sent every 15 seconds when the page has
 *     a pending request. If the SW restarted and forgot the request,
 *     the heartbeat surfaces the failure within one cycle instead of
 *     after the 120s blanket timeout.
 *
 * An update, a reload or a disable of the extension leaves this script
 * running in every open tab with no extension behind it: `chrome.runtime`
 * loses its `id`, then its methods. The service worker injects a new
 * bridge into open tabs when it installs (background.ts); that bridge
 * announces itself and the orphan stops listening, since the page takes
 * the first answer to a request and the orphan's would be a failure. An
 * orphan with no successor names what happened instead of relaying a
 * TypeError.
 */

import { BRIDGE_ORPHANED_ERROR, BRIDGE_REPLACED_ERROR } from "../src/provider/bridge-errors";
import { BRIDGE_CHANNEL, BRIDGE_TIMEOUT_MS, type BridgeResponse } from "../src/wallets/bridge/protocol";

const CHANNEL = "arch-wallet-provider";
const HEARTBEAT_MS = 15_000;
/** Crosses isolated worlds: a bridge left by the extension's previous context hears its successor's. */
const BRIDGE_REPLACED_EVENT = "arch-wallet#bridge-replaced";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",

  main() {
    if ((globalThis as any).__ARCH_WALLET_CONTENT_BRIDGE_INSTALLED) return;
    (globalThis as any).__ARCH_WALLET_CONTENT_BRIDGE_INSTALLED = true;

    const pageOrigin = window.location.origin;

    window.dispatchEvent(new CustomEvent(BRIDGE_REPLACED_EVENT));

    const injectedReady = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("/injected.js");
      script.type = "module";
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Failed to load Arch Wallet page bridge"));
      };
      (document.head || document.documentElement).appendChild(script);
    });

    const pendingByRequestId = new Map<string, string>();
    const externalRequests = new Map<string, (response: unknown) => void>();

    function postToPage(payload: Record<string, unknown>) {
      window.postMessage({ channel: CHANNEL, direction: "to-page", ...payload }, pageOrigin);
    }

    function contextAlive(): boolean {
      try {
        return Boolean(chrome.runtime?.id);
      } catch {
        return false;
      }
    }

    // The approval a pending request was waiting on went with the old service worker.
    function failPending(error: string) {
      for (const msgId of pendingByRequestId.values()) {
        postToPage({ id: msgId, response: { success: false, error } });
      }
      pendingByRequestId.clear();
    }

    function sendToBackground(payload: any, msgId: string) {
      if (!contextAlive()) {
        postToPage({ id: msgId, response: { success: false, error: BRIDGE_ORPHANED_ERROR } });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            postToPage({ id: msgId, response: { success: false, error: chrome.runtime.lastError.message } });
            return;
          }
          if (response?.error === "__PENDING__" && response?.requestId) {
            pendingByRequestId.set(response.requestId, msgId);
            return;
          }
          postToPage({ id: msgId, response });
        });
      } catch (err: any) {
        postToPage({ id: msgId, response: { success: false, error: err?.message || "Bridge failure" } });
      }
    }

    window.addEventListener("message", onPageMessage);
    window.addEventListener(BRIDGE_REPLACED_EVENT, onBridgeReplaced);

    // A page can dispatch this event too, so a bridge whose extension is still there ignores it.
    function onBridgeReplaced() {
      if (contextAlive()) return;
      window.removeEventListener("message", onPageMessage);
      window.removeEventListener(BRIDGE_REPLACED_EVENT, onBridgeReplaced);
      clearInterval(heartbeat);
      failPending(BRIDGE_REPLACED_ERROR);
    }

    function onPageMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== pageOrigin) return;
      if (event.data?.channel === BRIDGE_CHANNEL) {
        if (event.data?.direction !== "to-content") return;
        const resolve = externalRequests.get(event.data.id);
        if (!resolve) return;
        externalRequests.delete(event.data.id);
        resolve(event.data.response);
        return;
      }
      if (event.data?.channel !== CHANNEL) return;
      if (event.data?.direction !== "to-extension") return;

      const payload = event.data.payload;
      const msgId = payload?.id;
      if (!msgId) return;

      sendToBackground(payload, msgId);
    }

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "EXTERNAL_WALLET_PAGE_REQUEST") {
        return;
      }
      if (message?.channel !== CHANNEL) return;
      if (message?.direction !== "to-page") return;
      if (!message?.requestId) return;

      const msgId = pendingByRequestId.get(message.requestId);
      if (!msgId) return;
      pendingByRequestId.delete(message.requestId);
      postToPage({ id: msgId, response: message.response });
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "EXTERNAL_WALLET_PAGE_REQUEST") return false;
      (async () => {
        try {
          await injectedReady;
          const id =
            typeof message.requestId === "string" && message.requestId
              ? message.requestId
              : self.crypto?.randomUUID?.() ??
                `external-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          externalRequests.set(id, sendResponse);
          window.postMessage(
            {
              channel: BRIDGE_CHANNEL,
              direction: "to-page",
              id,
              request: message.request,
            },
            pageOrigin,
          );
          const timeoutMs =
            BRIDGE_TIMEOUT_MS[message.request?.method as keyof typeof BRIDGE_TIMEOUT_MS] ?? 60_000;
          window.setTimeout(() => {
            const resolve = externalRequests.get(id);
            if (!resolve) return;
            externalRequests.delete(id);
            resolve({
              success: false,
              code: "TIMEOUT",
              error: "The wallet didn't respond in time. If its window is still open, finish there and try again.",
            } satisfies BridgeResponse);
          }, timeoutMs);
        } catch (err: any) {
          sendResponse({
            success: false,
            code: "PROVIDER_ERROR",
            error: err?.message || "External wallet bridge failed",
          } satisfies BridgeResponse);
        }
      })();
      return true;
    });

    // Heartbeat: ping the SW while we have outstanding requests so a
    // restart-induced drop is surfaced quickly.
    const heartbeat = setInterval(() => {
      if (!contextAlive()) {
        failPending(BRIDGE_ORPHANED_ERROR);
        return;
      }
      if (pendingByRequestId.size === 0) return;
      try {
        chrome.runtime.sendMessage({ type: "PING", id: `heartbeat-${Date.now()}` });
      } catch {
        /* SW gone */
      }
    }, HEARTBEAT_MS);
  },
});
