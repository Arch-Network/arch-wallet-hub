import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: ".",
  manifest: {
    name: "Arch Wallet",
    description: "A Bitcoin, ARCH & APL wallet for Arch Network",
    version: "0.2.0",
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
    side_panel: {
      default_path: "sidepanel.html",
    },
    web_accessible_resources: [
      {
        resources: ["injected.js"],
        matches: ["<all_urls>"],
        use_dynamic_url: true,
      },
    ],
  },
  runner: {
    startUrls: ["https://explorer.arch.network"],
  },
});
