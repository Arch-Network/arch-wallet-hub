// Buffer shim MUST be first -- swap-engine deps reference Buffer at module init.
import "../../src/utils/buffer-polyfill";
import "reflect-metadata";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "../../src/styles/global.css";
import { applySystemThemeImmediately, bootstrapTheme } from "../../src/utils/theme";
import { rememberPopupBoundsOnResize } from "../../src/utils/popup-bounds";
import { installWalletWindowAutoClose } from "../../src/utils/wallet-autoclose";

// Paint the OS theme before first render (no flash for "system" users),
// then refine from the stored Light/Dark/System preference.
applySystemThemeImmediately();
void bootstrapTheme();

// popup.html is only opened in a real window (toolbar click, approve,
// signing). The page is marked data-layout="fluid" in the HTML so the
// layout fills that window before first paint. Remember the size the
// user drags it to.
rememberPopupBoundsOnResize();
// Clicking back to the page dismisses this window. Approve prompts opt
// out (they close after the decision) and so does the side panel.
installWalletWindowAutoClose();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
