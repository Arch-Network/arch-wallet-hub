import { defineConfig } from "wxt";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

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
    permissions: ["storage", "alarms", "idle", "activeTab", "sidePanel"],
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
    },
  }),
});
