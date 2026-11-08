// @vitest-environment happy-dom
/**
 * Regression test for the Send-screen fetch loop that hammered the Hub
 * (`GET /v1/indexer/arch/accounts/:addr/tokens`) in 0.8.0.
 *
 * Renders the real Send page with the real `useWallet` hook and the real
 * send-form checkpoint storage. Only the decrypting wallet store, the
 * keystore and the indexer network calls are faked. Once the page sits on
 * step 2 with an asset selected, nothing else should happen: the balance
 * and token fetch runs once, and the form is checkpointed once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const h = vi.hoisted(() => {
  // chrome.storage with Chromium semantics: onChanged fires asynchronously,
  // and only for keys whose value actually changed.
  function makeArea() {
    const data: Record<string, unknown> = {};
    const listeners = new Set<(changes: Changes) => void>();
    const area = {
      data,
      sets: 0,
      async get(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      },
      async set(items: Record<string, unknown>) {
        area.sets++;
        const changes: Changes = {};
        for (const [k, v] of Object.entries(items)) {
          if (JSON.stringify(data[k]) !== JSON.stringify(v)) {
            changes[k] = { oldValue: data[k], newValue: v };
            data[k] = structuredClone(v);
          }
        }
        if (Object.keys(changes).length) setTimeout(() => listeners.forEach((l) => l(changes)), 0);
      },
      async remove(key: string | string[]) {
        const keys = Array.isArray(key) ? key : [key];
        const changes: Changes = {};
        for (const k of keys) {
          if (k in data) {
            changes[k] = { oldValue: data[k] };
            delete data[k];
          }
        }
        if (Object.keys(changes).length) setTimeout(() => listeners.forEach((l) => l(changes)), 0);
      },
      onChanged: {
        addListener: (l: (changes: Changes) => void) => listeners.add(l),
        removeListener: (l: (changes: Changes) => void) => listeners.delete(l),
      },
    };
    return area;
  }
  const session = makeArea();
  const local = makeArea();
  (globalThis as any).chrome = { storage: { session, local } };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  return { session, local, tokenFetches: 0, summaryFetches: 0 };
});

const ACCOUNT = {
  id: "acct-1",
  kind: "turnkey",
  authMethod: "passkey",
  label: "Wallet 1",
  btcAddress: "tb1pexampleaddress",
  archAddress: "ArchAddrExample",
  publicKeyHex: "",
};

// Mirrors walletStore.getState(): decrypts the keystore and returns a NEW
// object on every call.
vi.mock("../../../state/wallet-store", async () => {
  const { DEFAULT_STATE } = await import("../../../state/types");
  return {
    walletStore: {
      getState: async () => {
        await new Promise((r) => setTimeout(r, 2));
        return {
          ...DEFAULT_STATE,
          initialized: true,
          locked: false,
          network: "testnet4",
          activeAccountId: ACCOUNT.id,
          accounts: [{ ...ACCOUNT }],
        };
      },
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
    getAccountSummary: async () => {
      h.summaryFetches++;
      return { address: ACCOUNT.archAddress, lamports_balance: 5_000 };
    },
    getBtcAddressSummary: async () => {
      h.summaryFetches++;
      return { chain_stats: { funded_txo_sum: 100_000, spent_txo_sum: 0 } };
    },
    getAccountTransactionsV2: async () => ({ transactions: [] }),
    getAccountTransactions: async () => ({ transactions: [] }),
    getAccountTokens: async () => {
      h.tokenFetches++;
      return { tokens: [] };
    },
  };
  return {
    ...(await importOriginal<typeof import("../../../utils/indexer")>()),
    getIndexer: async () => fakeIndexer,
  };
});

const { default: Send } = await import("../Send");
const { saveSendForm } = await import("../../../state/send-form-session");

const SEND_FORM_KEY = "arch_wallet_send_form_session_btc";
const OBSERVE_MS = 1_500;

let root: Root | null = null;

async function renderSendFor(ms: number, initialEntry: string) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  root.render(
    createElement(MemoryRouter, { initialEntries: [initialEntry] }, createElement(Send)),
  );
  await new Promise((r) => setTimeout(r, ms));
  return el;
}

describe("Send step 2 with an asset selected", () => {
  beforeEach(() => {
    for (const k of Object.keys(h.session.data)) delete h.session.data[k];
    h.tokenFetches = 0;
    h.summaryFetches = 0;
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    document.body.innerHTML = "";
  });

  it("restored from a parked form: fetches balances once and stops", async () => {
    await saveSendForm({
      form: {
        kind: "btc-arch-apl",
        asset: "btc",
        selectedTokenMint: null,
        recipient: "tb1qrecipient",
        amount: "0.001",
      },
      accountId: ACCOUNT.id,
      network: "testnet4",
    });
    const setsBefore = h.session.sets;

    const el = await renderSendFor(OBSERVE_MS, "/send");

    const fields = [...el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")];
    expect(fields.some((f) => f.value === "tb1qrecipient")).toBe(true);
    expect(h.tokenFetches).toBeGreaterThanOrEqual(1);
    expect(h.tokenFetches).toBeLessThanOrEqual(2);
    expect(h.summaryFetches).toBeLessThanOrEqual(4);
    expect(h.session.sets - setsBefore).toBeLessThanOrEqual(1);
  });

  it("deep-linked to an asset: fetches balances once and stops", async () => {
    const setsBefore = h.session.sets;

    await renderSendFor(OBSERVE_MS, "/send?asset=btc");

    expect(h.session.data[SEND_FORM_KEY]).toBeDefined();
    expect(h.tokenFetches).toBeGreaterThanOrEqual(1);
    expect(h.tokenFetches).toBeLessThanOrEqual(2);
    expect(h.session.sets - setsBefore).toBeLessThanOrEqual(1);
  });
});
