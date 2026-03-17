export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",

  main() {
    const CHANNEL = "arch-wallet-provider";

    // Inject the MAIN-world provider script into the page
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("/injected.js");
    script.type = "module";
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();

    // Track pending requests that are awaiting popup approval
    const pendingByRequestId = new Map<string, string>();

    // Bridge: page -> content script -> service worker
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data?.channel !== CHANNEL) return;
      if (event.data?.direction !== "to-extension") return;

      const payload = event.data.payload;
      const msgId = payload?.id;

      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          window.postMessage(
            { channel: CHANNEL, direction: "to-page", id: msgId, response: { success: false, error: chrome.runtime.lastError.message } },
            "*"
          );
          return;
        }

        // If the response is "__PENDING__", the approval popup was opened.
        // Don't respond to the page yet -- wait for the broadcast.
        if (response?.error === "__PENDING__" && response?.requestId) {
          pendingByRequestId.set(response.requestId, msgId);
          return;
        }

        window.postMessage(
          { channel: CHANNEL, direction: "to-page", id: msgId, response },
          "*"
        );
      });
    });

    // Bridge: service worker broadcasts approval/rejection -> content script -> page
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.channel === CHANNEL && message?.direction === "to-page" && message?.requestId) {
        const msgId = pendingByRequestId.get(message.requestId);
        if (msgId) {
          pendingByRequestId.delete(message.requestId);
          window.postMessage(
            { channel: CHANNEL, direction: "to-page", id: msgId, response: message.response },
            "*"
          );
        }
      }
    });
  },
});
