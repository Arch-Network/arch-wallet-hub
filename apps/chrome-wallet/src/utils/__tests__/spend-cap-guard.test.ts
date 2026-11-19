import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, WalletAccount } from "../../state/types";
import { DEFAULT_SITE_PERMISSIONS } from "../../state/types";
import { assertBackgroundSpendCap, type SpendCapGuardDeps } from "../spend-cap-guard";
import {
  __resetSpendLogForTests,
  getRecentSpendStrict,
  recordSpend,
  SpendLedgerUnavailableError,
} from "../spend-tracker";

interface FakeStorage {
  data: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function makeFakeChrome(): { storage: { local: FakeStorage } } {
  const data: Record<string, unknown> = {};
  const local: FakeStorage = {
    data,
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
  };
  return { storage: { local } };
}

const ORIGIN = "https://dapp.example";

function makeAccount(): WalletAccount {
  return {
    id: "acct-1",
    label: "Test",
    btcAddress: "bc1ptest000000000000000000000000000000000000000000000000000000000000",
    publicKeyHex: "11".repeat(32),
    archAddress: "Arch1111111111111111111111111111111111111111",
    kind: "turnkey",
    turnkeyResourceId: "tk",
    organizationId: "org",
    authMethod: "passkey",
    createdAt: 1,
  };
}

function makeState(opts: {
  spendingLimitSatsPerDay?: number;
  btcSpendingLimitSatsPerDay?: number;
  locked?: boolean;
}): AppState {
  const account = makeAccount();
  return {
    schemaVersion: 1,
    initialized: true,
    locked: !!opts.locked,
    network: "mainnet",
    activeAccountId: account.id,
    accounts: [account],
    connectedSites: {
      [ORIGIN]: {
        origin: ORIGIN,
        connectedAt: 1,
        accountId: account.id,
        permissions: {
          ...DEFAULT_SITE_PERMISSIONS,
          spendingLimitSatsPerDay: opts.spendingLimitSatsPerDay,
          btcSpendingLimitSatsPerDay: opts.btcSpendingLimitSatsPerDay,
        },
      },
    },
    hubBaseUrl: "https://hub.arch.network",
    hubApiKey: "",
    indexerBaseUrl: "https://explorer.arch.network/api/v1",
    indexerApiKey: "",
    openAs: "popup",
    debugMode: false,
    sentryOptIn: false,
    recentRecipients: [],
    contacts: [],
    autoLockMinutes: 60,
  };
}

function depsFor(state: AppState | null, overrides?: Partial<SpendCapGuardDeps>): SpendCapGuardDeps {
  return {
    getUnlockedState: async () => (state && !state.locked ? state : null),
    getRecentSpendStrict,
    ...overrides,
  };
}

describe("assertBackgroundSpendCap", () => {
  beforeEach(async () => {
    (globalThis as any).chrome = makeFakeChrome();
    await __resetSpendLogForTests();
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  it("allows non-spend message types", async () => {
    const decision = await assertBackgroundSpendCap(
      { type: "SIGN_MESSAGE", origin: ORIGIN, payload: { message: "aa" } },
      depsFor(makeState({})),
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("allows SEND_TRANSFER when no ARCH cap is configured", async () => {
    const decision = await assertBackgroundSpendCap(
      { type: "SEND_TRANSFER", origin: ORIGIN, payload: { to: "x", lamports: "999" } },
      depsFor(makeState({})),
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("refuses SEND_TRANSFER when recent + pending exceeds ARCH cap", async () => {
    await recordSpend({ origin: ORIGIN, asset: "arch", network: "mainnet", amount: 80n });
    const decision = await assertBackgroundSpendCap(
      { type: "SEND_TRANSFER", origin: ORIGIN, payload: { to: "x", lamports: "30" } },
      depsFor(makeState({ spendingLimitSatsPerDay: 100 })),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.error).toMatch(/ARCH spend cap exceeded/i);
    }
  });

  it("allows SEND_TRANSFER when under ARCH cap", async () => {
    await recordSpend({ origin: ORIGIN, asset: "arch", network: "mainnet", amount: 40n });
    const decision = await assertBackgroundSpendCap(
      { type: "SEND_TRANSFER", origin: ORIGIN, payload: { to: "x", lamports: "50" } },
      depsFor(makeState({ spendingLimitSatsPerDay: 100 })),
    );
    expect(decision).toEqual({ allowed: true });
  });

  it("fail-closes SEND_TRANSFER when ledger is unavailable and a cap is set", async () => {
    const decision = await assertBackgroundSpendCap(
      { type: "SEND_TRANSFER", origin: ORIGIN, payload: { to: "x", lamports: "1" } },
      depsFor(makeState({ spendingLimitSatsPerDay: 100 }), {
        getRecentSpendStrict: async () => {
          throw new SpendLedgerUnavailableError("boom");
        },
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.error).toMatch(/ledger unavailable/i);
    }
  });

  it("fail-closes when wallet state is locked", async () => {
    const decision = await assertBackgroundSpendCap(
      { type: "SEND_TRANSFER", origin: ORIGIN, payload: { to: "x", lamports: "1" } },
      depsFor(null),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.error).toMatch(/locked|unavailable/i);
    }
  });

  it("fail-closes SEND_TRANSFER with invalid lamports when a cap is set", async () => {
    const decision = await assertBackgroundSpendCap(
      { type: "SEND_TRANSFER", origin: ORIGIN, payload: { to: "x", lamports: "0x10" } },
      depsFor(makeState({ spendingLimitSatsPerDay: 100 })),
    );
    expect(decision.allowed).toBe(false);
  });

  it("fail-closes when the origin has no connectedSites entry", async () => {
    const state = makeState({ spendingLimitSatsPerDay: 100 });
    delete state.connectedSites[ORIGIN];
    const decision = await assertBackgroundSpendCap(
      { type: "SEND_TRANSFER", origin: ORIGIN, payload: { to: "x", lamports: "1" } },
      depsFor(state),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.error).toMatch(/permissions/i);
    }
  });
});
