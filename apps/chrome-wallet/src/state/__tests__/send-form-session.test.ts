/**
 * Unit tests for the send-form checkpoint storage.
 *
 * We mock `chrome.storage.session` with an in-memory fake so the
 * test exercises the real save / load / clear paths -- TTL,
 * account/network filtering, rune-id matching -- without relying
 * on the extension runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSendForm,
  loadSendForm,
  saveSendForm,
} from "../send-form-session";

interface FakeStorage {
  data: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function makeFakeChrome(): { storage: { session: FakeStorage } } {
  const data: Record<string, unknown> = {};
  const session: FakeStorage = {
    data,
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete data[k];
    }),
  };
  return { storage: { session } };
}

const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";
const NET_TEST = "testnet4";
const NET_MAIN = "mainnet";

describe("send-form-session", () => {
  beforeEach(() => {
    (globalThis as any).chrome = makeFakeChrome();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  describe("BTC/ARCH/APL form", () => {
    it("round-trips a saved form for the same account + network", async () => {
      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "btc",
          selectedTokenMint: null,
          recipient: "tb1pxyz",
          amount: "0.001",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const ck = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      expect(ck).not.toBeNull();
      expect(ck!.form).toEqual({
        kind: "btc-arch-apl",
        asset: "btc",
        selectedTokenMint: null,
        recipient: "tb1pxyz",
        amount: "0.001",
      });
      expect(ck!.accountId).toBe(ACCOUNT_A);
      expect(ck!.network).toBe(NET_TEST);
      expect(typeof ck!.savedAt).toBe("number");
    });

    it("does NOT return a checkpoint from a different account", async () => {
      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "arch",
          selectedTokenMint: null,
          recipient: "arch1abc",
          amount: "5",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const ck = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_B,
        network: NET_TEST,
      });

      expect(ck).toBeNull();
    });

    it("does NOT return a checkpoint from a different network", async () => {
      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "btc",
          selectedTokenMint: null,
          recipient: "tb1qabc",
          amount: "0.0005",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const ck = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_MAIN,
      });

      expect(ck).toBeNull();
    });

    it("preserves a parked checkpoint across context-mismatch loads", async () => {
      // A wrong-account / wrong-network load must NOT wipe the
      // parked form -- the user may bounce back to the original
      // context (switching accounts, switching networks) and we
      // want their typed fields still there.
      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "btc",
          selectedTokenMint: null,
          recipient: "tb1qabc",
          amount: "0.0005",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const wrongAccount = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_B,
        network: NET_TEST,
      });
      expect(wrongAccount).toBeNull();

      const wrongNetwork = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_MAIN,
      });
      expect(wrongNetwork).toBeNull();

      // Loading with the original context still finds the parked
      // form -- the wrong-context loads above didn't disturb it.
      const original = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      expect(original).not.toBeNull();
      expect(original!.form.kind).toBe("btc-arch-apl");
    });
  });

  describe("rune form", () => {
    it("round-trips a saved rune form for the same rune id", async () => {
      await saveSendForm({
        form: {
          kind: "rune",
          runeId: "840000:1",
          recipient: "tb1pdeadbeef",
          amount: "1.5",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const ck = await loadSendForm({
        kind: "rune",
        accountId: ACCOUNT_A,
        network: NET_TEST,
        runeId: "840000:1",
      });

      expect(ck).not.toBeNull();
      expect(ck!.form).toEqual({
        kind: "rune",
        runeId: "840000:1",
        recipient: "tb1pdeadbeef",
        amount: "1.5",
      });
    });

    it("does NOT return a checkpoint for a different rune id", async () => {
      await saveSendForm({
        form: {
          kind: "rune",
          runeId: "840000:1",
          recipient: "tb1pdeadbeef",
          amount: "1.5",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const ck = await loadSendForm({
        kind: "rune",
        accountId: ACCOUNT_A,
        network: NET_TEST,
        runeId: "840001:5", // different rune
      });

      expect(ck).toBeNull();
    });
  });

  describe("cross-kind isolation", () => {
    it("does NOT return a rune checkpoint when loading the BTC form", async () => {
      await saveSendForm({
        form: {
          kind: "rune",
          runeId: "840000:1",
          recipient: "tb1pdeadbeef",
          amount: "1.5",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const ck = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      expect(ck).toBeNull();
    });

    it("the BTC and rune forms coexist in independent slots", async () => {
      // The user might park a half-filled BTC send, open
      // /send-rune/X to send some runes too, and come back. Both
      // forms should survive in their own slots until they
      // individually expire / submit / get explicitly cleared.
      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "btc",
          selectedTokenMint: null,
          recipient: "tb1qfirst",
          amount: "0.0001",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      await saveSendForm({
        form: {
          kind: "rune",
          runeId: "840000:1",
          recipient: "tb1psecond",
          amount: "2",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      const btcCk = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      expect(btcCk).not.toBeNull();
      expect(btcCk!.form.kind).toBe("btc-arch-apl");

      const runeCk = await loadSendForm({
        kind: "rune",
        accountId: ACCOUNT_A,
        network: NET_TEST,
        runeId: "840000:1",
      });
      expect(runeCk).not.toBeNull();
      expect(runeCk!.form.kind).toBe("rune");
    });

    it("clearSendForm wipes BOTH slots in one call", async () => {
      // A successful broadcast (or explicit cancel) should leave
      // no parked forms behind across either kind.
      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "btc",
          selectedTokenMint: null,
          recipient: "tb1qfirst",
          amount: "0.0001",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      await saveSendForm({
        form: {
          kind: "rune",
          runeId: "840000:1",
          recipient: "tb1psecond",
          amount: "2",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      await clearSendForm();

      const btcCk = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      const runeCk = await loadSendForm({
        kind: "rune",
        accountId: ACCOUNT_A,
        network: NET_TEST,
        runeId: "840000:1",
      });
      expect(btcCk).toBeNull();
      expect(runeCk).toBeNull();
    });
  });

  describe("TTL", () => {
    it("returns null and clears once the 30-minute TTL elapses", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "btc",
          selectedTokenMint: null,
          recipient: "tb1qabc",
          amount: "0.001",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      // 29 minutes later -- still fresh.
      vi.setSystemTime(new Date("2026-01-01T00:29:00Z"));
      const fresh = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      expect(fresh).not.toBeNull();

      // 31 minutes after save -- expired.
      vi.setSystemTime(new Date("2026-01-01T00:31:00Z"));
      const stale = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      expect(stale).toBeNull();
    });
  });

  describe("clearSendForm", () => {
    it("removes a saved form so subsequent loads see nothing", async () => {
      await saveSendForm({
        form: {
          kind: "btc-arch-apl",
          asset: "btc",
          selectedTokenMint: null,
          recipient: "tb1qabc",
          amount: "0.001",
        },
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });

      await clearSendForm();

      const ck = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: ACCOUNT_A,
        network: NET_TEST,
      });
      expect(ck).toBeNull();
    });
  });

  describe("missing chrome.storage.session", () => {
    it("save / load / clear all no-op gracefully", async () => {
      delete (globalThis as any).chrome;
      await expect(
        saveSendForm({
          form: {
            kind: "btc-arch-apl",
            asset: "btc",
            selectedTokenMint: null,
            recipient: "tb1qabc",
            amount: "0.001",
          },
          accountId: ACCOUNT_A,
          network: NET_TEST,
        })
      ).resolves.toBeUndefined();
      await expect(
        loadSendForm({
          kind: "btc-arch-apl",
          accountId: ACCOUNT_A,
          network: NET_TEST,
        })
      ).resolves.toBeNull();
      await expect(clearSendForm()).resolves.toBeUndefined();
    });
  });
});
