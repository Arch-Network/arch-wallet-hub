// Buffer shim MUST be first -- swap-engine deps reference Buffer at module init.
import "../../src/utils/buffer-polyfill";
import "reflect-metadata";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../popup/App";
import "../../src/styles/global.css";
import { applySystemThemeImmediately, bootstrapTheme } from "../../src/utils/theme";

// Paint the OS theme before first render (no flash for "system" users),
// then refine from the stored Light/Dark/System preference.
applySystemThemeImmediately();
void bootstrapTheme();

console.debug("[arch-wallet] sidepanel boot");

function renderFallback(message: string): HTMLDivElement {
  // SECURITY: build the DOM with createElement + textContent so an
  // error message containing HTML/script (e.g. an attacker-influenced
  // crafted Error.stack) can't escape into the extension origin via
  // innerHTML.
  const wrap = document.createElement("div");
  wrap.style.color = "#f55";
  wrap.style.padding = "16px";
  wrap.style.fontFamily = "sans-serif";
  wrap.style.fontSize = "12px";
  wrap.style.whiteSpace = "pre-wrap";
  wrap.textContent = message;
  return wrap;
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  document.body.replaceChildren(renderFallback("Missing #root element."));
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
    const detail = String((err as Error)?.stack || err);
    rootEl.replaceChildren(
      renderFallback(`Side panel failed to render:\n${detail}`),
    );
  }
}

window.addEventListener("error", (e) => {
  console.error("[arch-wallet] sidepanel window error", e.message, e.error);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[arch-wallet] sidepanel unhandled rejection", e.reason);
});
