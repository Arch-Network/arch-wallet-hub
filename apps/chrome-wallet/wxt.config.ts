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
    //   storage       -> wallet state (encrypted keystore)
    //   alarms        -> auto-lock + pending-request GC
    //   idle          -> auto-lock when user steps away
    //   activeTab     -> read the active tab title/favicon during dapp connect
    //   sidePanel     -> optional side panel UI
    //   notifications -> tx-broadcast / tx-failure popups so the user
    //                    sees the outcome even after closing the popup
    // Note: `tabs` is intentionally NOT requested. The background uses
    // tabs.query + tabs.sendMessage which are gated by host_permissions
    // <all_urls> below (required to talk to the content script).
    permissions: ["storage", "alarms", "idle", "activeTab", "sidePanel", "scripting", "notifications"],
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
      // Inject build-time hub/indexer keys through private define tokens.
      // This avoids Vite's `import.meta.env.WXT_*` substitution table,
      // which is unreliable for these keys on Vite 8 + Rolldown + Node 20.
      __ARCH_BUILD_HUB_API_KEY__: JSON.stringify(
        process.env.WXT_HUB_API_KEY ?? "",
      ),
      __ARCH_BUILD_INDEXER_API_KEY__: JSON.stringify(
        process.env.WXT_INDEXER_API_KEY ?? "",
      ),
      // Direct-vs-Hub indexer routing toggle. Default `false` =>
      // route every indexer read/write through the Wallet Hub
      // proxy (no key ships in the wallet bundle). Build-time
      // override only -- no runtime UI -- so we can flip the
      // boolean and re-release without app-state migrations.
      // Escape hatch for emergency rollback if the Hub proxy
      // regresses: set `WXT_USE_DIRECT_INDEXER=true` and rebuild;
      // the wallet falls back to its legacy ArchIndexerClient
      // path which still works against `state.indexerApiKey`.
      __ARCH_USE_DIRECT_INDEXER__: JSON.stringify(
        process.env.WXT_USE_DIRECT_INDEXER === "true",
      ),
    },
    // Keep `buffer`/`process` out of Vite's dependency optimizer (dev only).
    //
    // `vite-plugin-node-polyfills` aliases the `buffer`/`process` bare
    // specifiers to its own shims (`shims/{buffer,process}`) AND lists the
    // resolved shim paths in `optimizeDeps.exclude` (so they stay external).
    // On Vite 8 + Rolldown the dep scanner discovers `buffer` (imported by
    // `src/utils/buffer-polyfill.ts`) and `process` as bare entry points, so
    // the optimizer tries to make the shim an *entry* while the plugin's
    // exclude marks the same module *external* -- Rolldown rejects that with
    // `[UNRESOLVED_ENTRY] ... shims/buffer/dist/index.cjs cannot be external`,
    // crashing `wxt dev` during dependency optimization. Excluding the two
    // packages here stops them from becoming optimizer entries; their bare
    // imports still resolve through the plugin's alias -> shim at load time.
    // `global` is not a resolvable bare package, so it never hits this path.
    // (https://github.com/davidmyersdev/vite-plugin-node-polyfills/issues/81)
    optimizeDeps: {
      exclude: ["buffer", "process"],
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
      // Rewrite the plugin's auto-injected `Buffer` import from default
      // to named form, so the polyfill's `Buffer` class survives Rolldown's
      // CJS-interop wrap.
      //
      // The plugin emits `transform.inject = { Buffer: "<shim>" }` which
      // Rolldown reads as a *default-import* directive and inlines
      // `import Buffer from "<shim>"` into every module that references
      // `Buffer`. The shim is treated as CJS (because its IIFE wrapper
      // hides static ESM markers), so Rolldown wraps the resolved module
      // through `_interopRequireDefault(mod, /*forceDefault*/ 1)`:
      //
      //   var i = e(t(), 1);
      //   // ...
      //   c.write(i.default.from(content));   // <-- throws
      //
      // The helper unconditionally clobbers the polyfill's real `default`
      // (the Buffer *class*) with the whole namespace object, leaving
      // `i.default.from === undefined`. (Confirmed by reading the bundled
      // chunk; see ./node_modules/vite-plugin-node-polyfills/dist/index.js
      // line 178 and the helper `d` in the emitted `dist-*.js` chunk.)
      //
      // Switching to tuple form `Buffer: ["<shim>", "Buffer"]` makes
      // Rolldown emit a *named* import (`import { Buffer } from "<shim>"`)
      // which goes through a straight named-export lookup, no default
      // synthesis, no interop double-wrap, no clobber. `Buffer.from(...)`
      // lands on the class directly.
      //
      // `process` and `global` go through the same default-form inject but
      // their consumers happen to use them in shapes (`process.versions.x`,
      // `typeof global`) that the interop wrap leaves intact, so we only
      // need to fix `Buffer`. Doing the same for the other two would be
      // defensible but expanding scope is not free here.
      {
        name: "arch-wallet:buffer-inject-named",
        enforce: "post",
        configResolved(config) {
          const transform = (config.build?.rollupOptions as { transform?: { inject?: Record<string, unknown> } } | undefined)?.transform;
          const inject = transform?.inject;
          if (!inject) return;
          if (typeof inject.Buffer === "string") {
            inject.Buffer = [inject.Buffer, "Buffer"];
          }
        },
      },
    ],
  }),
});
