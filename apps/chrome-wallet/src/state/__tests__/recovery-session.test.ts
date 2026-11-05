/**
 * The password step has to outlive the wallet window. Verify spends
 * the one-time code, so a reload that restored the OTP form would
 * 410. These tests pin the checkpoint that prevents that, including
 * the write order: a slow OTP save must not land after the password
 * save and resurrect the spent challenge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecoveryEmailCandidate } from "@arch-network/wallet-hub-sdk";
import {
  clearRecoverySession,
  hasActiveRecoveryCheckpoint,
  isSpentRecoveryChallenge,
  loadRecoverySession,
  saveRecoverySession,
  type RecoveryVerifiedMaterial,
} from "../recovery-session";

interface FakeSession {
  data: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  holdNextSet: () => () => void;
}

function installChrome(): FakeSession {
  const data: Record<string, unknown> = {};
  let hold: Promise<void> | null = null;
  const session: FakeSession = {
    data,
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const blocker = hold;
      hold = null;
      if (blocker) await blocker;
      Object.assign(data, items);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete data[k];
    }),
    holdNextSet() {
      let release: () => void = () => {};
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
  vi.stubGlobal("chrome", { storage: { session } });
  return session;
}

const candidate: RecoveryEmailCandidate = {
  candidateToken: "tok",
  walletLabel: "Passkey wallet",
  addressMasked: "bc1q…xyz",
  createdAt: "2026-11-04T17:49:00.000Z",
  isCustodial: false,
  authMethod: "passkey",
};

const verified: RecoveryVerifiedMaterial = {
  credentialBundle: "bundle",
  organizationId: "org",
  rootUserId: "root",
  walletId: "wallet",
  defaultAddress: "bc1qexample",
  defaultPublicKeyHex: "aa",
  externalUserId: "user",
  authMethod: "passkey",
  ephemeralPrivateKeyHex: "bb".repeat(32),
};

function envelope(step: "otp" | "pick" | "password" | "email" | "done") {
  return {
    step,
    email: "ttm.cap@gmail.com",
    challengeId: "chal-1",
    candidates: [candidate],
    emailMasked: "t***@gmail.com",
    pickedToken: "tok",
    pinnedExternalUserId: null,
    pinnedResourceId: null,
  };
}

describe("recovery-session", () => {
  beforeEach(() => {
    installChrome();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("restores an in-progress code entry", async () => {
    await saveRecoverySession(envelope("otp"));
    const loaded = await loadRecoverySession();
    expect(loaded?.step).toBe("otp");
    expect(loaded?.challengeId).toBe("chal-1");
    expect(loaded?.verified).toBeUndefined();
    expect(await hasActiveRecoveryCheckpoint()).toBe(true);
  });

  it("restores the password step with the decrypt material and without the password", async () => {
    await saveRecoverySession({ ...envelope("password"), verified });
    const loaded = await loadRecoverySession();
    expect(loaded?.step).toBe("password");
    expect(loaded?.verified).toEqual(verified);
    expect(loaded).not.toHaveProperty("password");
    expect(JSON.stringify(loaded)).not.toContain("user-secret-password");
    expect(await hasActiveRecoveryCheckpoint()).toBe(true);
  });

  it("drops a password checkpoint that cannot finish recovery", async () => {
    await saveRecoverySession(envelope("password"));
    expect(await loadRecoverySession()).toBeNull();
    expect(await hasActiveRecoveryCheckpoint()).toBe(false);
  });

  it("expires the checkpoint on the same 10 minute window as the Hub challenge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T18:00:00.000Z"));
    await saveRecoverySession({ ...envelope("password"), verified });

    vi.setSystemTime(new Date("2026-11-05T18:10:00.000Z"));
    expect((await loadRecoverySession())?.step).toBe("password");

    vi.setSystemTime(new Date("2026-11-05T18:10:00.001Z"));
    expect(await loadRecoverySession()).toBeNull();
  });

  it("does not let a slow OTP save overwrite the password step", async () => {
    const session = installChrome();
    const release = session.holdNextSet();
    const otpSave = saveRecoverySession(envelope("otp"));
    const passwordSave = saveRecoverySession({ ...envelope("password"), verified });
    release();
    await otpSave;
    await passwordSave;
    expect((await loadRecoverySession())?.step).toBe("password");
    expect((await loadRecoverySession())?.verified?.ephemeralPrivateKeyHex).toBe(
      verified.ephemeralPrivateKeyHex,
    );
  });

  it("does not let an in-flight save undo a clear", async () => {
    const session = installChrome();
    const release = session.holdNextSet();
    const saving = saveRecoverySession(envelope("otp"));
    const clearing = clearRecoverySession();
    release();
    await saving;
    await clearing;
    expect(await loadRecoverySession()).toBeNull();
  });

  it("treats a consumed or expired challenge as spent, and a wrong code as not", () => {
    expect(
      isSpentRecoveryChallenge(
        new Error("WalletHub error 410 Gone: Challenge already consumed or expired"),
      ),
    ).toBe(true);
    expect(
      isSpentRecoveryChallenge("WalletHub error 410 Gone: Challenge expired"),
    ).toBe(true);
    expect(isSpentRecoveryChallenge(new Error("Invalid or expired code"))).toBe(false);
    expect(isSpentRecoveryChallenge(new Error("Failed to send verification code"))).toBe(false);
  });

  it("does not resume a finished or not-yet-started flow", async () => {
    await saveRecoverySession(envelope("email"));
    expect(await hasActiveRecoveryCheckpoint()).toBe(false);
    await saveRecoverySession(envelope("done"));
    expect(await hasActiveRecoveryCheckpoint()).toBe(false);
  });
});
