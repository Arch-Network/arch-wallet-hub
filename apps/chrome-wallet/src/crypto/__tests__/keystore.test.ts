/**
 * Cross-realm lock: each extension realm (service worker, popup, side
 * panel, approve window) loads its own copy of the keystore module. Two
 * `vi.resetModules()` imports model two realms sharing one
 * `chrome.storage`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Change = { oldValue?: unknown; newValue?: unknown };
type Listener = (changes: Record<string, Change>, areaName: string) => void;

function installChromeStorage() {
  const listeners: Listener[] = [];
  const fire = (changes: Record<string, Change>, areaName: string) => {
    if (Object.keys(changes).length > 0) listeners.forEach((l) => l(changes, areaName));
  };
  const makeArea = (areaName: string) => {
    const store = new Map<string, unknown>();
    return {
      async get(key: string) {
        return store.has(key) ? { [key]: store.get(key) } : {};
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, Change> = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: store.get(k), newValue: v };
          store.set(k, v);
        }
        fire(changes, areaName);
      },
      async remove(keys: string | string[]) {
        const changes: Record<string, Change> = {};
        for (const k of ([] as string[]).concat(keys)) {
          if (!store.has(k)) continue;
          changes[k] = { oldValue: store.get(k) };
          store.delete(k);
        }
        fire(changes, areaName);
      },
    };
  };
  (globalThis as any).chrome = {
    storage: {
      local: makeArea("local"),
      session: makeArea("session"),
      onChanged: { addListener: (l: Listener) => listeners.push(l) },
    },
  };
}

async function loadRealm() {
  vi.resetModules();
  return (await import("../keystore")).keystore;
}

describe("keystore cross-realm lock", () => {
  beforeEach(() => {
    installChromeStorage();
  });

  it("drops a realm's cached key when another realm locks", async () => {
    const serviceWorker = await loadRealm();
    const popup = await loadRealm();
    await serviceWorker.seal("correct horse battery", { accounts: ["a"] });
    expect(await popup.read()).toEqual({ accounts: ["a"] });

    await serviceWorker.lock();

    expect(await popup.isUnlocked()).toBe(false);
    expect(await popup.read()).toBeNull();
    await expect(popup.write({ accounts: ["b"] })).rejects.toThrow(/locked/);
  });

  it("keeps working in the realm that unlocked", async () => {
    const popup = await loadRealm();
    await popup.seal("correct horse battery", { n: 1 });
    await popup.write({ n: 2 });
    expect(await popup.read()).toEqual({ n: 2 });
  });
});
