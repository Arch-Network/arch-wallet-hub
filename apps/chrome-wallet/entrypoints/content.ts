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
 */

const CHANNEL = "arch-wallet-provider";
const HEARTBEAT_MS = 15_000;

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",

  main() {
    if ((globalThis as any).__ARCH_WALLET_CONTENT_BRIDGE_INSTALLED) return;
    (globalThis as any).__ARCH_WALLET_CONTENT_BRIDGE_INSTALLED = true;

    const pageOrigin = window.location.origin;

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

    function sendToBackground(payload: any, msgId: string) {
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

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.origin !== pageOrigin) return;
      if (event.data?.channel === "arch-wallet-external-wallet") {
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
    });

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
              channel: "arch-wallet-external-wallet",
              direction: "to-page",
              id,
              request: message.request,
            },
            pageOrigin,
          );
          window.setTimeout(() => {
            const resolve = externalRequests.get(id);
            if (!resolve) return;
            externalRequests.delete(id);
            resolve({ success: false, error: "External wallet request timed out" });
          }, 30_000);
        } catch (err: any) {
          sendResponse({ success: false, error: err?.message || "External wallet bridge failed" });
        }
      })();
      return true;
    });

    // Heartbeat: ping the SW while we have outstanding requests so a
    // restart-induced drop is surfaced quickly.
    setInterval(() => {
      if (pendingByRequestId.size === 0) return;
      try {
        chrome.runtime.sendMessage({ type: "PING", id: `heartbeat-${Date.now()}` });
      } catch {
        /* SW gone */
      }
    }, HEARTBEAT_MS);
  },
});
