// Buffer shim MUST be first -- swap-engine deps reference Buffer at module init.
import "../../src/utils/buffer-polyfill";
import "reflect-metadata";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "../../src/styles/global.css";
import { applySystemThemeImmediately, bootstrapTheme } from "../../src/utils/theme";

// Paint the OS theme before first render (no flash for "system" users),
// then refine from the stored Light/Dark/System preference.
applySystemThemeImmediately();
void bootstrapTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
