import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetClickMapForTests,
  buildExplorerUrl,
  installNotificationClickHandler,
  notifyTxBroadcast,
  notifyTxFailed,
} from "../notifications";

interface FakeStorageArea {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
}

interface FakeChrome {
  notifications: {
    create: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    onClicked: {
      addListener: ReturnType<typeof vi.fn>;
      listeners: Array<(id: string) => void>;
    };
  };
  storage: { local: FakeStorageArea };
  tabs: { create: ReturnType<typeof vi.fn> };
  runtime: { getURL: ReturnType<typeof vi.fn> };
}

function makeFakeChrome(): FakeChrome {
  const data: Record<string, unknown> = {};
  const local: FakeStorageArea = {
    data,
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
  };

  const listeners: Array<(id: string) => void> = [];

  return {
    notifications: {
      create: vi.fn(),
      clear: vi.fn(),
      onClicked: {
        addListener: vi.fn((cb: (id: string) => void) => listeners.push(cb)),
        listeners,
      },
    },
    storage: { local },
    tabs: { create: vi.fn(async () => ({})) },
    runtime: { getURL: vi.fn((p: string) => `chrome-extension://aaa/${p}`) },
  };
}

describe("notifications", () => {
  let fakeChrome: FakeChrome;

  beforeEach(async () => {
    fakeChrome = makeFakeChrome();
    (globalThis as any).chrome = fakeChrome;
    await __resetClickMapForTests();
    // Reset spy call history after the test-setup write so assertions
    // count only the calls the test body triggers.
    fakeChrome.storage.local.set.mockClear();
    fakeChrome.storage.local.get.mockClear();
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  describe("buildExplorerUrl", () => {
    it("maps mainnet BTC to mempool.space root", () => {
      expect(buildExplorerUrl({ kind: "btc", txid: "abcd", network: "mainnet" })).toBe(
        "https://mempool.space/tx/abcd",
      );
    });
    it("maps testnet4 BTC to mempool.space/testnet4", () => {
      expect(buildExplorerUrl({ kind: "btc", txid: "abcd", network: "testnet4" })).toBe(
        "https://mempool.space/testnet4/tx/abcd",
      );
    });
    it("maps mainnet Arch to explorer.arch.network/mainnet", () => {
      expect(buildExplorerUrl({ kind: "arch", txid: "x", network: "mainnet" })).toBe(
        "https://explorer.arch.network/mainnet/tx/x",
      );
    });
    it("maps testnet4 Arch to explorer.arch.network/testnet", () => {
      expect(buildExplorerUrl({ kind: "arch", txid: "x", network: "testnet4" })).toBe(
        "https://explorer.arch.network/testnet/tx/x",
      );
    });
  });

  describe("notifyTxBroadcast", () => {
    it("calls chrome.notifications.create with the supplied title + message", async () => {
      await notifyTxBroadcast({
        title: "Bitcoin transfer broadcast",
        message: "0.001 BTC sent",
        explorerUrl: "https://mempool.space/tx/deadbeef",
      });
      expect(fakeChrome.notifications.create).toHaveBeenCalledTimes(1);
      const call = fakeChrome.notifications.create.mock.calls[0]!;
      const [, options] = call as [string, { title: string; message: string; type: string }];
      expect(options.title).toBe("Bitcoin transfer broadcast");
      expect(options.message).toBe("0.001 BTC sent");
      expect(options.type).toBe("basic");
    });

    it("stores the explorer URL in the click map for the SW to read", async () => {
      await notifyTxBroadcast({
        title: "Bitcoin transfer broadcast",
        message: "0.001 BTC sent",
        explorerUrl: "https://mempool.space/tx/deadbeef",
      });
      const map = fakeChrome.storage.local.data["arch_wallet_notif_clickmap"] as Record<
        string,
        { url: string }
      >;
      expect(map).toBeDefined();
      const urls = Object.values(map).map((e) => e.url);
      expect(urls).toContain("https://mempool.space/tx/deadbeef");
    });

    it("does not store anything when no explorerUrl is provided", async () => {
      await notifyTxBroadcast({
        title: "Tx broadcast",
        message: "Sent",
      });
      const map = fakeChrome.storage.local.data["arch_wallet_notif_clickmap"];
      expect(map === undefined || Object.keys(map as object).length === 0).toBe(true);
    });

    it("returns null when chrome.notifications is unavailable", async () => {
      delete (fakeChrome as any).notifications;
      const id = await notifyTxBroadcast({
        title: "x",
        message: "y",
        explorerUrl: "https://example.test",
      });
      expect(id).toBeNull();
    });
  });

  describe("notifyTxFailed", () => {
    it("fires a basic notification with priority 2", async () => {
      await notifyTxFailed({ title: "Bitcoin transfer failed", message: "Network error" });
      expect(fakeChrome.notifications.create).toHaveBeenCalledTimes(1);
      const [, options] = fakeChrome.notifications.create.mock.calls[0]! as [
        string,
        { priority?: number },
      ];
      expect(options.priority).toBe(2);
    });

    it("does NOT write to the click map (failures have no explorer URL)", async () => {
      await notifyTxFailed({ title: "Failed", message: "Reason" });
      expect(fakeChrome.storage.local.set).not.toHaveBeenCalled();
    });
  });

  describe("installNotificationClickHandler", () => {
    it("opens the stored explorer URL when the notification is clicked", async () => {
      installNotificationClickHandler();
      await notifyTxBroadcast({
        title: "Bitcoin transfer broadcast",
        message: "0.001 BTC sent",
        explorerUrl: "https://mempool.space/tx/zzz",
      });
      const map = fakeChrome.storage.local.data["arch_wallet_notif_clickmap"] as Record<
        string,
        { url: string }
      >;
      const [id] = Object.keys(map);
      expect(id).toBeDefined();

      // Invoke the registered listener as chrome would.
      const listener = fakeChrome.notifications.onClicked.listeners[0]!;
      await listener(id!);

      expect(fakeChrome.tabs.create).toHaveBeenCalledWith({ url: "https://mempool.space/tx/zzz" });
      expect(fakeChrome.notifications.clear).toHaveBeenCalledWith(id);
    });

    it("ignores clicks on notifications with no click-map entry (e.g. failure notifs)", async () => {
      installNotificationClickHandler();
      const listener = fakeChrome.notifications.onClicked.listeners[0]!;
      await listener("arch-fail-1234-abcd");
      expect(fakeChrome.tabs.create).not.toHaveBeenCalled();
      // Still clears the notification so it doesn't linger on screen.
      expect(fakeChrome.notifications.clear).toHaveBeenCalledWith("arch-fail-1234-abcd");
    });
  });
});
