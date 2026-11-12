// @vitest-environment happy-dom
/**
 * The Activity page must only ever show the selected account's history.
 *
 * Renders the real History page with the real `useWallet` hook. The
 * decrypting wallet store and the indexer are faked so each test decides
 * which account is active and when each indexer response arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

type ArchFeed = { transactions: Array<{ txid: string; status: string; created_at: string }> };

const h = vi.hoisted(() => {
  const listeners = new Set<(changes: Record<string, unknown>) => void>();
  const area = {
    async get() {
      return {};
    },
    async set() {},
    async remove() {},
    onChanged: {
      addListener: (l: (changes: Record<string, unknown>) => void) => listeners.add(l),
      removeListener: (l: (changes: Record<string, unknown>) => void) => listeners.delete(l),
    },
  };
  (globalThis as any).chrome = { storage: { session: area, local: area } };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  return {
    account: "a",
    /** Tell `useWallet` the keystore changed, as an account switch does. */
    keystoreChanged: () => listeners.forEach((l) => l({ arch_wallet_keystore: {} })),
    archFeed: (_address: string, _page: number): Promise<ArchFeed> =>
      Promise.resolve({ transactions: [] }),
    btcTxs: (_address: string): Promise<unknown[]> => Promise.resolve([]),
  };
});

vi.mock("../../../state/wallet-store", async () => {
  const { DEFAULT_STATE } = await import("../../../state/types");
  return {
    walletStore: {
      getState: async () => ({
        ...DEFAULT_STATE,
        initialized: true,
        locked: false,
        network: "testnet4",
        activeAccountId: `acct-${h.account}`,
        accounts: [
          {
            id: `acct-${h.account}`,
            kind: "turnkey",
            authMethod: "passkey",
            label: `Wallet ${h.account}`,
            btcAddress: `tb1phistory${h.account}`,
            archAddress: `Arch-${h.account}`,
            publicKeyHex: "",
          },
        ],
      }),
    },
  };
});

// log.ts lazily imports the optional `@sentry/browser`, which the DOM
// environment's import analysis refuses to resolve.
vi.mock("../../../utils/log", () => ({
  log: { debug() {}, info() {}, warn() {}, error() {} },
  applyDiagnosticsRuntime() {},
}));

vi.mock("../../../crypto/keystore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../crypto/keystore")>()),
  keystore: { getMigrationStatus: async () => ({ kind: "fresh" }) },
}));

vi.mock("../../../utils/indexer", async (importOriginal) => {
  const fakeIndexer = {
    network: "testnet",
    getAccountTokens: async () => ({ tokens: [] }),
    getAccountTransactionsV2: (address: string, _limit: number, page = 1) =>
      h.archFeed(address, page),
    getAccountTransactions: (address: string, _limit: number, page = 1) =>
      h.archFeed(address, page),
    getTransactionDetail: async () => ({}),
    getTransactionTree: async () => null,
    getBtcAddressRuneTransactions: async () => ({ transactions: [] }),
    getBtcAddressRunes: async () => ({ balances: [] }),
    getBtcAddressInscriptions: async () => ({ inscriptions: [] }),
    getBtcAddressTxs: (address: string) => h.btcTxs(address),
    getBtcTransaction: async (txid: string) => ({ txid }),
  };
  return {
    ...(await importOriginal<typeof import("../../../utils/indexer")>()),
    getIndexer: async () => fakeIndexer,
  };
});

const { default: History } = await import("../History");

let root: Root | null = null;
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const feedOf = (...txids: string[]): ArchFeed => ({
  transactions: txids.map((txid) => ({
    txid,
    status: "processed",
    created_at: "2026-11-01T00:00:00Z",
  })),
});

/** A full page of the Arch feed: the page size is what offers "Load more". */
const fullPage = (prefix: string) =>
  feedOf(...Array.from({ length: 20 }, (_, i) => `${prefix}-${i}`));

async function renderHistory() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(createElement(History));
  await settle();
  return el;
}

const shownTxids = (el: HTMLElement) =>
  [...el.querySelectorAll(".tx-activity-ref")].map((n) => n.textContent);

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

describe("History loading", () => {
  beforeEach(() => {
    h.account = "a";
    h.archFeed = async () => ({ transactions: [] });
    h.btcTxs = async () => [];
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("ignores the previous account's response when it arrives last", async () => {
    const slowA = deferred<ArchFeed>();
    h.archFeed = (address) =>
      address === "Arch-a" ? slowA.promise : Promise.resolve(feedOf("tx-b-1"));

    const el = await renderHistory();
    expect(shownTxids(el)).toEqual([]);

    // Switch to account B while A's history is still loading.
    h.account = "b";
    h.keystoreChanged();
    await settle();
    expect(shownTxids(el)).toEqual(["tx-b-1"]);

    // A's response lands after B's.
    slowA.resolve(feedOf("tx-a-1"));
    await settle();
    expect(shownTxids(el)).toEqual(["tx-b-1"]);
    expect(el.querySelector(".spinner")).toBeNull();
  });

  it("clears the previous account's rows as soon as the account changes", async () => {
    const slowB = deferred<ArchFeed>();
    h.archFeed = (address) =>
      address === "Arch-a" ? Promise.resolve(feedOf("tx-a-1")) : slowB.promise;

    const el = await renderHistory();
    expect(shownTxids(el)).toEqual(["tx-a-1"]);

    h.account = "b";
    h.keystoreChanged();
    await settle();
    // B is still loading: a spinner, never A's rows under B.
    expect(shownTxids(el)).toEqual([]);
    expect(el.querySelector(".spinner")).not.toBeNull();

    slowB.resolve(feedOf("tx-b-1"));
    await settle();
    expect(shownTxids(el)).toEqual(["tx-b-1"]);
  });

  it("does not let a failed stale request show its error under the new account", async () => {
    const slowA = deferred<ArchFeed>();
    h.archFeed = (address) =>
      address === "Arch-a"
        ? slowA.promise.then(() => {
            throw new Error("Hub indexer error 503");
          })
        : Promise.resolve(feedOf("tx-b-1"));

    const el = await renderHistory();
    h.account = "b";
    h.keystoreChanged();
    await settle();

    slowA.resolve(feedOf());
    await settle();
    expect(shownTxids(el)).toEqual(["tx-b-1"]);
    expect(el.textContent).not.toContain("Couldn't load");
  });

  it("adds the next page to the list instead of replacing it", async () => {
    h.archFeed = async (_address, page) => (page === 1 ? fullPage("p1") : feedOf("p2-0"));

    const el = await renderHistory();
    expect(shownTxids(el)).toHaveLength(20);

    button(el, "Load more")!.click();
    await settle();

    const shown = shownTxids(el);
    expect(shown).toHaveLength(21);
    expect(shown).toContain("p1-0");
    expect(shown).toContain("p2-0");
    // A short page is the last one.
    expect(button(el, "Load more")).toBeUndefined();
  });

  it("starts the new account on its first page", async () => {
    const pagesAsked: Array<[string, number]> = [];
    h.archFeed = async (address, page) => {
      pagesAsked.push([address, page]);
      return address === "Arch-a" ? fullPage(`a${page}`) : feedOf("tx-b-1");
    };

    const el = await renderHistory();
    button(el, "Load more")!.click();
    await settle();
    expect(pagesAsked).toContainEqual(["Arch-a", 2]);

    h.account = "b";
    h.keystoreChanged();
    await settle();

    expect(pagesAsked.filter(([address]) => address === "Arch-b")).toEqual([["Arch-b", 1]]);
    expect(shownTxids(el)).toEqual(["tx-b-1"]);
  });

  it("says which chain is empty when the wallet has other activity", async () => {
    h.archFeed = async () => feedOf("tx-a-1");

    const el = await renderHistory();
    button(el, "₿ Bitcoin")!.click();
    await settle(20);

    expect(el.querySelector(".empty-state")?.textContent).toContain("No Bitcoin transactions");
    expect(el.textContent).not.toContain("No transactions yet");

    button(el, "Show all activity")!.click();
    await settle(20);
    expect(shownTxids(el)).toEqual(["tx-a-1"]);
  });

  it("says the wallet is empty when nothing has happened on any chain", async () => {
    const el = await renderHistory();
    expect(el.querySelector(".empty-state")?.textContent).toContain("No transactions yet");
    expect(button(el, "Show all activity")).toBeUndefined();
  });
});
