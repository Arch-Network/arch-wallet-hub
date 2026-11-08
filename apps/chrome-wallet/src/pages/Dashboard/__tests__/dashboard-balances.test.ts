// @vitest-environment happy-dom
/**
 * A failed overview read is an unknown balance, not a zero one: the
 * Dashboard keeps the last good balance or shows its loading skeleton,
 * and a rate limit shows a busy countdown instead of an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

type Mode = "ok" | "rate-limited" | "error";

const h = vi.hoisted(() => {
  const noopArea = {
    async get() {
      return {};
    },
    async set() {},
    async remove() {},
    onChanged: { addListener() {}, removeListener() {} },
  };
  (globalThis as any).chrome = { storage: { session: noopArea, local: noopArea } };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  return { mode: "ok" as Mode, n: 0 };
});

const BTC_SATS = 150_000;

vi.mock("../../../state/wallet-store", async () => {
  const { DEFAULT_STATE } = await import("../../../state/types");
  return {
    walletStore: {
      getState: async () => ({
        ...DEFAULT_STATE,
        initialized: true,
        locked: false,
        network: "testnet4",
        activeAccountId: `acct-${h.n}`,
        accounts: [
          {
            id: `acct-${h.n}`,
            kind: "turnkey",
            authMethod: "passkey",
            label: "Wallet",
            btcAddress: `tb1pdashboard${h.n}`,
            archAddress: `ArchDashboard${h.n}`,
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

vi.mock("../../../utils/swap-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/swap-engine")>()),
  configureSwapEngineFromAppState() {},
}));

vi.mock("../../../utils/indexer", async (importOriginal) => {
  const { HubRateLimitError } = await import("../../../utils/hub-rate-limit");
  const read = async <T>(value: T): Promise<T> => {
    if (h.mode === "rate-limited") throw new HubRateLimitError(20_000);
    if (h.mode === "error") throw new Error("Hub indexer error 503");
    return value;
  };
  const fakeIndexer = {
    network: "testnet",
    getAccountSummary: () => read({ address: "arch", lamports_balance: 2_000_000_000 }),
    getBtcAddressSummary: () =>
      read({ chain_stats: { funded_txo_sum: BTC_SATS, spent_txo_sum: 0 } }),
    getAccountTransactionsV2: () => read({ transactions: [] }),
    getAccountTransactions: () => read({ transactions: [] }),
    getAccountTokens: () => read({ tokens: [] }),
    getBtcAddressRunes: () => read({ balances: [] }),
    getBtcAddressInscriptions: () => read({ inscriptions: [] }),
    getBtcAddressTxs: () => read([]),
  };
  return {
    ...(await importOriginal<typeof import("../../../utils/indexer")>()),
    getIndexer: async () => fakeIndexer,
  };
});

const { default: Dashboard } = await import("../Dashboard");
const { formatBtcAmount } = await import("../../../utils/format");

let root: Root | null = null;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function renderDashboard() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(createElement(MemoryRouter, null, createElement(Dashboard)));
  await settle();
  return el;
}

const assetBalances = (el: HTMLElement) =>
  [...el.querySelectorAll(".asset-balance")].map((n) => n.textContent);

describe("Dashboard balances on a failed overview", () => {
  beforeEach(() => {
    h.n += 1;
    // Price lookups (CoinGecko) are not under test and must not hit the network.
    vi.stubGlobal("fetch", async () => {
      throw new Error("network disabled in tests");
    });
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("rate limited with nothing loaded yet: skeleton and a busy countdown, never 0", async () => {
    h.mode = "rate-limited";
    const el = await renderDashboard();

    expect(el.querySelector(".skeleton-balance")).not.toBeNull();
    expect(assetBalances(el)).toEqual([]);
    expect(el.textContent).not.toContain(formatBtcAmount(0));
    expect(el.querySelector(".warning-banner")?.textContent).toMatch(/Busy right now\. Retrying in 2\ds/);
    expect(el.querySelector(".error-banner")).toBeNull();
  });

  it("a failed refresh keeps the last good balance", async () => {
    h.mode = "ok";
    const el = await renderDashboard();
    expect(assetBalances(el)).toContain(formatBtcAmount(BTC_SATS));

    h.mode = "error";
    el.querySelector<HTMLButtonElement>('[aria-label="Refresh balances"]')!.click();
    await settle();

    expect(assetBalances(el)).toContain(formatBtcAmount(BTC_SATS));
    expect(assetBalances(el)).not.toContain(formatBtcAmount(0));
    expect(el.querySelector(".error-banner")?.textContent).toContain("Couldn't load your balances");
  });
});
