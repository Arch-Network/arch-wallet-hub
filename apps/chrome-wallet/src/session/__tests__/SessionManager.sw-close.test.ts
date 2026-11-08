/**
 * `close()` from a context with no `window` (the MV3 service worker's
 * auto-lock path) against the REAL @turnkey/indexed-db-stamper module:
 * its constructor throws without `window`, so the on-disk key must be
 * cleared some other way. IndexedDB is a minimal in-memory fake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@turnkey/http", () => ({
  TurnkeyClient: vi.fn(() => ({ tag: "fake-tk-client" })),
}));

function installFakeIndexedDb(initial: Record<string, unknown> | null) {
  const state: { store: Map<string, unknown> | null; closed: number; opens: Array<[string, number | undefined]> } = {
    store: initial ? new Map(Object.entries(initial)) : null,
    closed: 0,
    opens: [],
  };
  const factory = {
    open(name: string, version?: number) {
      state.opens.push([name, version]);
      const request: any = {};
      setTimeout(() => {
        const db = {
          createObjectStore(storeName: string) {
            if (storeName === "KeyStore") state.store = new Map();
          },
          transaction(storeName: string) {
            if (storeName !== "KeyStore" || !state.store) throw new Error("NotFoundError");
            const target = state.store;
            const tx: any = {
              objectStore: () => ({
                delete: (key: string) => target.delete(key),
              }),
            };
            setTimeout(() => tx.oncomplete?.(), 0);
            return tx;
          },
          close() {
            state.closed++;
          },
        };
        request.result = db;
        if (name === "TurnkeyStamperDB" && !state.store) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = factory;
  return state;
}

describe("SessionManager.close() in the service worker", () => {
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    vi.resetModules();
  });

  it("deletes the stamper key pair without a window", async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    const idb = installFakeIndexedDb({
      "turnkeyKeyPair-pub": "02abc",
      "turnkeyKeyPair-priv": { privateKey: "opaque CryptoKey" },
      unrelated: 1,
    });
    const { SessionManager } = await import("../SessionManager");

    await new SessionManager().close();

    expect(idb.opens).toEqual([["TurnkeyStamperDB", 1]]);
    expect([...idb.store!.keys()]).toEqual(["unrelated"]);
    expect(idb.closed).toBe(1);
  });

  it("is a no-op when no stamper database exists yet", async () => {
    const idb = installFakeIndexedDb(null);
    const { SessionManager } = await import("../SessionManager");

    await expect(new SessionManager().close()).resolves.toBeUndefined();
    expect(idb.store!.size).toBe(0);
  });
});
