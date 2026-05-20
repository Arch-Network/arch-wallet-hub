/**
 * SessionManager unit tests.
 *
 * Strategy: bypass the real `IndexedDbStamper` (which needs a working
 * IndexedDB + SubtleCrypto stack) by mocking the module before
 * importing SessionManager. We exercise the state machine, TTL
 * clamping, listener notifications, and the cross-account rotation
 * guarantee. We deliberately do NOT cover the live Turnkey HTTP
 * client; that's the bootstrap test's job and there's no good way to
 * fake it without effectively re-implementing the SDK.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletAccount } from "../../state/types";
import type { SessionBootstrap } from "../types";

const mockGetPublicKey = vi.fn<() => string | null>(() => "0xpub");
const mockInit = vi.fn<() => Promise<void>>(async () => {});
const mockResetKeyPair = vi.fn<() => Promise<void>>(async () => {});
const mockClear = vi.fn<() => Promise<void>>(async () => {});

vi.mock("@turnkey/indexed-db-stamper", () => ({
  IndexedDbStamper: vi.fn(() => ({
    init: mockInit,
    resetKeyPair: mockResetKeyPair,
    getPublicKey: mockGetPublicKey,
    clear: mockClear,
  })),
}));

vi.mock("@turnkey/http", () => ({
  TurnkeyClient: vi.fn(() => ({ tag: "fake-tk-client" })),
}));

const makeAccount = (id: string, organizationId = `org-${id}`): WalletAccount =>
  ({
    id,
    label: `Wallet ${id}`,
    btcAddress: `tb1q-${id}`,
    publicKeyHex: `pk-${id}`,
    kind: "turnkey",
    turnkeyResourceId: `res-${id}`,
    organizationId,
    authMethod: "passkey",
    createdAt: 0,
  }) as WalletAccount;

const okBootstrap = (id: string = "test"): SessionBootstrap => ({
  id,
  register: vi.fn().mockResolvedValue(undefined),
});

describe("SessionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T12:00:00.000Z"));
    mockGetPublicKey.mockReturnValue("0xpub");
    mockInit.mockResolvedValue(undefined);
    mockResetKeyPair.mockResolvedValue(undefined);
    mockClear.mockResolvedValue(undefined);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("opens a session, exposes status, and returns a TurnkeyClient", async () => {
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();

    const account = makeAccount("a");
    const client = await mgr.open({
      account,
      ttlSeconds: 600,
      bootstrap: okBootstrap("passkey"),
    });

    expect(client).toBeTruthy();
    const status = mgr.status();
    expect(status.active).toBe(true);
    expect(status.accountId).toBe("a");
    expect(status.expiresAt).toBeGreaterThan(Date.now());
  });

  it("clamps the TTL below the floor and above the ceiling", async () => {
    const { SessionManager } = await import("../SessionManager");
    const { MIN_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS } = await import(
      "../constants"
    );

    const mgrLow = new SessionManager();
    await mgrLow.open({
      account: makeAccount("low"),
      ttlSeconds: 1, // below floor
      bootstrap: okBootstrap(),
    });
    expect(mgrLow.status().expiresAt).toBe(
      Date.now() + MIN_SESSION_TTL_SECONDS * 1000,
    );

    const mgrHigh = new SessionManager();
    await mgrHigh.open({
      account: makeAccount("high"),
      ttlSeconds: 999_999, // above ceiling
      bootstrap: okBootstrap(),
    });
    expect(mgrHigh.status().expiresAt).toBe(
      Date.now() + MAX_SESSION_TTL_SECONDS * 1000,
    );
  });

  it("getClient(accountId) returns null when the accountId mismatches", async () => {
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();
    await mgr.open({
      account: makeAccount("a"),
      ttlSeconds: 600,
      bootstrap: okBootstrap(),
    });
    expect(mgr.getClient("a")).toBeTruthy();
    expect(mgr.getClient("nope")).toBeNull();
  });

  it("getClient() returns null once the session is within the expiry slack", async () => {
    const { SessionManager } = await import("../SessionManager");
    const { SESSION_EXPIRY_SLACK_SECONDS } = await import("../constants");
    const mgr = new SessionManager();
    await mgr.open({
      account: makeAccount("a"),
      ttlSeconds: 60,
      bootstrap: okBootstrap(),
    });
    expect(mgr.getClient()).toBeTruthy();

    // Jump just past the slack threshold.
    vi.setSystemTime(
      new Date(Date.now() + (60 - SESSION_EXPIRY_SLACK_SECONDS + 1) * 1000),
    );
    expect(mgr.getClient()).toBeNull();
    expect(mgr.status().active).toBe(false);
  });

  it("rotates the session when switching accounts and clears the prior stamper", async () => {
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();
    const a = makeAccount("a", "org-a");
    const b = makeAccount("b", "org-b");
    const bsA = okBootstrap("a");
    const bsB = okBootstrap("b");

    await mgr.open({ account: a, ttlSeconds: 600, bootstrap: bsA });
    expect(mgr.status().accountId).toBe("a");

    await mgr.open({ account: b, ttlSeconds: 600, bootstrap: bsB });
    expect(mgr.status().accountId).toBe("b");
    // Stamper clear was called once on the rotation.
    expect(mockClear).toHaveBeenCalledTimes(1);
    // Each open path mints a fresh keypair.
    expect(mockResetKeyPair).toHaveBeenCalledTimes(2);
    // Each bootstrap got called exactly once for its account.
    expect(bsA.register).toHaveBeenCalledTimes(1);
    expect(bsB.register).toHaveBeenCalledTimes(1);
  });

  it("reuses the existing session when open() is called twice with the same account", async () => {
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();
    const account = makeAccount("a");
    const bootstrap = okBootstrap();

    await mgr.open({ account, ttlSeconds: 600, bootstrap });
    await mgr.open({ account, ttlSeconds: 600, bootstrap });

    // Reused: bootstrap is invoked exactly once for the same account.
    expect(bootstrap.register).toHaveBeenCalledTimes(1);
  });

  it("clears IndexedDB-side state on close() and notifies subscribers", async () => {
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();
    const listener = vi.fn();
    const unsubscribe = mgr.subscribe(listener);

    await mgr.open({
      account: makeAccount("a"),
      ttlSeconds: 600,
      bootstrap: okBootstrap(),
    });
    expect(listener).toHaveBeenCalledTimes(1);

    await mgr.close();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(mockClear).toHaveBeenCalled();
    expect(mgr.status().active).toBe(false);

    // close() on an already-closed manager is a no-op for listeners.
    const prior = listener.mock.calls.length;
    await mgr.close();
    expect(listener).toHaveBeenCalledTimes(prior);

    unsubscribe();
  });

  it("propagates a bootstrap failure and leaves the manager closed", async () => {
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();
    const failingBootstrap: SessionBootstrap = {
      id: "fail",
      register: vi.fn().mockRejectedValue(new Error("boom")),
    };

    await expect(
      mgr.open({
        account: makeAccount("a"),
        ttlSeconds: 600,
        bootstrap: failingBootstrap,
      }),
    ).rejects.toThrow(/boom/);

    expect(mgr.status().active).toBe(false);
    // We must have wiped the stamper key so a half-open state doesn't
    // pretend to be a real session.
    expect(mockClear).toHaveBeenCalled();
  });

  it("throws if IndexedDbStamper.getPublicKey() returns null", async () => {
    mockGetPublicKey.mockReturnValueOnce(null);
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();
    await expect(
      mgr.open({
        account: makeAccount("a"),
        ttlSeconds: 600,
        bootstrap: okBootstrap(),
      }),
    ).rejects.toThrow(/Failed to mint/i);
  });

  it("getVersion() increments on each notify and snapshots remain consistent", async () => {
    const { SessionManager } = await import("../SessionManager");
    const mgr = new SessionManager();
    const v0 = mgr.getVersion();
    await mgr.open({
      account: makeAccount("a"),
      ttlSeconds: 600,
      bootstrap: okBootstrap(),
    });
    const v1 = mgr.getVersion();
    await mgr.close();
    const v2 = mgr.getVersion();
    expect(v1).toBeGreaterThan(v0);
    expect(v2).toBeGreaterThan(v1);
  });
});
