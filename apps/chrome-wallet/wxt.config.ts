import { defineConfig } from "wxt";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// In monorepos with nested `node_modules` (this repo: arch-sdk lives at
// `packages/arch-swap-engine/node_modules/@saturnbtcio/arch-sdk/`) Rolldown
// can't walk up to find the bare specifier `vite-plugin-node-polyfills/
// shims/*` from those nested importers because the plugin is only installed
// in the chrome-wallet package. The plugin's `globals: { Buffer | global |
// process }` aliases default to those bare specifiers (other node-built-in
// aliases come from `node-stdlib-browser` and are already absolute paths,
// so they don't hit this issue). Pre-resolve the three shim paths from
// chrome-wallet's own `node_modules` and feed Vite absolute paths so the
// alias is portable across every importer.
// (https://github.com/davidmyersdev/vite-plugin-node-polyfills/issues/81)
const require = createRequire(import.meta.url);
const shimAliases = {
  buffer: require.resolve("vite-plugin-node-polyfills/shims/buffer"),
  global: require.resolve("vite-plugin-node-polyfills/shims/global"),
  process: require.resolve("vite-plugin-node-polyfills/shims/process"),
};

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  manifest: {
    name: "Arch Wallet",
    description: "A Bitcoin, ARCH & APL wallet for Arch Network",
    version: packageJson.version,
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    // Permissions are deliberately narrow:
    //   storage     -> wallet state (encrypted keystore)
    //   alarms      -> auto-lock + pending-request GC
    //   idle        -> auto-lock when user steps away
    //   activeTab   -> read the active tab title/favicon during dapp connect
    //   sidePanel   -> optional side panel UI
    // Note: `tabs` is intentionally NOT requested. The background uses
    // tabs.query + tabs.sendMessage which are gated by host_permissions
    // <all_urls> below (required to talk to the content script).
    permissions: ["storage", "alarms", "idle", "activeTab", "sidePanel", "scripting"],
    host_permissions: ["<all_urls>"],
    // Defense-in-depth on top of MV3 defaults. MV3 already forbids
    // `unsafe-eval` and remote scripts; we restate the intent and
    // explicitly forbid `object-src` so plugins/Flash can't be
    // injected if any future bundler/plugin tries.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none';",
    },
    side_panel: {
      default_path: "sidepanel.html",
    },
    web_accessible_resources: [
      {
        resources: ["injected.js"],
        matches: ["<all_urls>"],
        // use_dynamic_url rotates the URL per session so the resource
        // isn't a stable fingerprint surface. Pages that try
        // `fetch(chrome.runtime.getURL("/injected.js"))` see a
        // different token each session.
        use_dynamic_url: true,
      },
    ],
  },
  runner: {
    startUrls: ["https://explorer.arch.network"],
  },
  vite: () => ({
    define: {
      "import.meta.env.WXT_APP_VERSION": JSON.stringify(packageJson.version),
      // WXT/Vite only auto-loads `WXT_*` env vars from `.env*` files, not
      // from `process.env`. CI builds (GitHub Actions) ship secrets via
      // process env (no `.env.local` checked in), so without an explicit
      // `define` the production bundle inlines `""` for these keys and the
      // popup throws "Missing Wallet Hub API key" at onboarding.
      //
      // We only inject when the value is actually present in process env so
      // local dev keeps using `.env.local` (WXT's auto-load) untouched.
      ...(process.env.WXT_HUB_API_KEY
        ? {
            "import.meta.env.WXT_HUB_API_KEY": JSON.stringify(
              process.env.WXT_HUB_API_KEY,
            ),
          }
        : {}),
      ...(process.env.WXT_INDEXER_API_KEY
        ? {
            "import.meta.env.WXT_INDEXER_API_KEY": JSON.stringify(
              process.env.WXT_INDEXER_API_KEY,
            ),
          }
        : {}),
    },
    plugins: [
      // bitcoinjs-lib (and its CJS deps) call `require('buffer'|'events'|'stream')`
      // at module-init time -- e.g. `var t = require('buffer'); var n = t.Buffer.alloc(32, 0);`
      // in `bitcoinjs-lib/src/types.js`. Vite's default browser build resolves
      // bare node-builtin specifiers to the `__vite-browser-external` stub,
      // which is literally `module.exports = {}`. That made `t.Buffer`
      // undefined and threw "Cannot read properties of undefined (reading
      // 'alloc')" inside the popup, leaving it blank (root cause of the
      // v0.2.0-v0.2.4 empty-popup regression).
      //
      // `vite-plugin-node-polyfills` swaps those bare specifiers (and their
      // `node:` protocol equivalents) for `node-stdlib-browser`'s browser
      // implementations during build, so the CJS wrappers see real exports.
      // We also let it inject `globalThis.{Buffer,global,process}` for any
      // caller that reaches for the global directly (e.g. `safe-buffer`'s
      // `typeof window.Buffer !== 'undefined' ? ...` feature check).
      //
      // `public/node-globals-shim.js` and `src/utils/buffer-polyfill.ts` are
      // kept as parser-blocking defense-in-depth: they shim the globals
      // *before* the module graph evaluates, which guards against any future
      // dep that touches `process`/`Buffer` from an even earlier dep chunk
      // than the polyfill injection point.
      nodePolyfills({
        protocolImports: true,
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
      }),
      // Re-rewrite the plugin's bare `vite-plugin-node-polyfills/shims/*`
      // specifiers to absolute paths. The plugin's `config()` hook installs
      // them as plain `resolve.alias` strings, which Rolldown can't resolve
      // when the importer lives in a nested `node_modules/` that has no copy
      // of `vite-plugin-node-polyfills` (e.g. `packages/arch-swap-engine/
      // node_modules/@saturnbtcio/arch-sdk/`). `enforce: 'pre'` ensures we
      // intercept before Rolldown's own resolver tries (and fails).
      // (https://github.com/davidmyersdev/vite-plugin-node-polyfills/issues/81)
      {
        name: "vite-plugin-node-polyfills:absolute-shim-paths",
        enforce: "pre",
        resolveId(source) {
          if (source === "vite-plugin-node-polyfills/shims/buffer") return shimAliases.buffer;
          if (source === "vite-plugin-node-polyfills/shims/global") return shimAliases.global;
          if (source === "vite-plugin-node-polyfills/shims/process") return shimAliases.process;
          return null;
        },
      },
    ],
  }),
});
