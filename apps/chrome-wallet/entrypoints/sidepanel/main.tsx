// Buffer shim MUST be first -- swap-engine deps reference Buffer at module init.
import "../../src/utils/buffer-polyfill";
import "reflect-metadata";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../popup/App";
import "../../src/styles/global.css";

console.debug("[arch-wallet] sidepanel boot");

const rootEl = document.getElementById("root");
if (!rootEl) {
  document.body.innerHTML =
    '<div style="color:#fff;padding:16px;font-family:sans-serif">Missing #root element.</div>';
} else {
  try {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
    console.debug("[arch-wallet] sidepanel rendered");
  } catch (err) {
    console.error("[arch-wallet] sidepanel render failed", err);
    rootEl.innerHTML = `<div style="color:#f55;padding:16px;font-family:sans-serif;font-size:12px;white-space:pre-wrap">Side panel failed to render:\n${String(
      (err as Error)?.stack || err,
    )}</div>`;
  }
}

window.addEventListener("error", (e) => {
  console.error("[arch-wallet] sidepanel window error", e.message, e.error);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[arch-wallet] sidepanel unhandled rejection", e.reason);
});
