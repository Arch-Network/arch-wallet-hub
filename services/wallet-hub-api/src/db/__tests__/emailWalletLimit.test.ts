import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  acquireEmailWalletSlot,
  decideEmailWalletLimit,
  EMAIL_WALLET_CLAIM_TTL_SECONDS,
  setAppEmailWalletLimit,
} from "../emailWalletLimit.js";

describe("decideEmailWalletLimit", () => {
  const base = {
    limit: 1 as number | null,
    requestedEmail: "User@Example.com",
    currentEmail: null as string | null,
    persistedForEmail: 0,
    inflightForEmail: 0,
    userResourceCount: 0,
  };

  it("skips unlimited apps", () => {
    expect(decideEmailWalletLimit({ ...base, limit: null })).toEqual({ action: "skip" });
  });

  it("requires an email when the app is locked", () => {
    expect(decideEmailWalletLimit({ ...base, requestedEmail: "  " })).toEqual({
      action: "reject",
      code: "email_required",
    });
  });

  it("reserves the first wallet for an email", () => {
    expect(decideEmailWalletLimit(base)).toEqual({ action: "reserve" });
  });

  it("rejects when a stored wallet already uses the email", () => {
    expect(decideEmailWalletLimit({ ...base, persistedForEmail: 1 })).toEqual({
      action: "reject",
      code: "email_wallet_limit_reached",
    });
  });

  it("rejects a second in-flight create for the same email", () => {
    expect(decideEmailWalletLimit({ ...base, inflightForEmail: 1 })).toEqual({
      action: "reject",
      code: "email_wallet_limit_reached",
    });
  });

  it("allows a second wallet when the cap is higher than current occupancy", () => {
    expect(decideEmailWalletLimit({ ...base, limit: 2, persistedForEmail: 1 })).toEqual({
      action: "reserve",
    });
  });

  it("refuses to move a user who already has a different recovery email", () => {
    expect(
      decideEmailWalletLimit({ ...base, currentEmail: "other@example.com", userResourceCount: 1 }),
    ).toEqual({ action: "reject", code: "recovery_email_locked" });
  });

  it("counts this user's existing wallets once the email would be attached", () => {
    expect(decideEmailWalletLimit({ ...base, userResourceCount: 1 })).toEqual({
      action: "reject",
      code: "email_wallet_limit_reached",
    });
  });

  it("does not double-count wallets already stored on this email", () => {
    expect(
      decideEmailWalletLimit({
        ...base,
        limit: 2,
        currentEmail: "user@example.com",
        persistedForEmail: 1,
        userResourceCount: 1,
      }),
    ).toEqual({ action: "reserve" });
  });
});

type QueryStep = (sql: string, params: unknown[] | undefined) => { rows: unknown[] };

function scriptedPool(steps: QueryStep[]): Pool {
  let i = 0;
  return {
    connect: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        const step = steps[i++];
        if (!step) throw new Error(`unexpected query: ${sql}`);
        return step(sql, params);
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
}

describe("acquireEmailWalletSlot", () => {
  it("does not reserve a slot when the app is unlimited", async () => {
    const pool = scriptedPool([
      (sql) => {
        expect(sql).toContain("FOR SHARE");
        return { rows: [{ email_wallet_limit: null }] };
      },
    ]);
    await expect(
      acquireEmailWalletSlot(pool, { appId: "app", userId: "user", email: "A@Example.com" }),
    ).resolves.toEqual({ kind: "skip" });
  });

  it("rejects a missing email before taking the email lock", async () => {
    const pool = scriptedPool([() => ({ rows: [{ email_wallet_limit: 1 }] })]);
    const result = await acquireEmailWalletSlot(pool, { appId: "app", userId: "user", email: " " });
    expect(result).toMatchObject({ kind: "rejected", code: "email_required" });
  });

  it("locks the email and inserts a claim when under the cap", async () => {
    const seen: string[] = [];
    const pool = scriptedPool([
      (sql) => {
        seen.push(sql);
        return { rows: [{ email_wallet_limit: 1 }] };
      },
      (sql, params) => {
        seen.push(sql);
        expect(params).toEqual(["app", "a@example.com"]);
        expect(sql).toContain("INSERT INTO email_wallet_locks");
        return { rows: [] };
      },
      (sql) => {
        seen.push(sql);
        expect(sql).toContain("FOR UPDATE");
        return { rows: [{}] };
      },
      (sql, params) => {
        seen.push(sql);
        expect(params?.[2]).toBe(EMAIL_WALLET_CLAIM_TTL_SECONDS);
        expect(sql).toContain("DELETE FROM email_wallet_claims");
        return { rows: [] };
      },
      () => ({
        rows: [{ current_email: null, user_resources: 0, persisted: 0, inflight: 0 }],
      }),
      (sql, params) => {
        expect(sql).toContain("INSERT INTO email_wallet_claims");
        expect(params).toEqual(["app", "a@example.com", "user"]);
        return { rows: [{ id: "claim-1" }] };
      },
    ]);
    await expect(
      acquireEmailWalletSlot(pool, { appId: "app", userId: "user", email: "A@Example.com" }),
    ).resolves.toEqual({ kind: "reserved", claimId: "claim-1" });
    expect(seen.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
  });

  it("does not insert a claim when the email is already at the cap", async () => {
    let inserted = false;
    const pool = scriptedPool([
      () => ({ rows: [{ email_wallet_limit: 1 }] }),
      () => ({ rows: [] }),
      () => ({ rows: [{}] }),
      () => ({ rows: [] }),
      () => ({
        rows: [{ current_email: null, user_resources: 0, persisted: 1, inflight: 0 }],
      }),
      () => {
        inserted = true;
        return { rows: [{ id: "should-not" }] };
      },
    ]);
    const result = await acquireEmailWalletSlot(pool, {
      appId: "app",
      userId: "user",
      email: "a@example.com",
    });
    expect(result).toMatchObject({ kind: "rejected", code: "email_wallet_limit_reached" });
    expect(inserted).toBe(false);
  });
});

describe("setAppEmailWalletLimit", () => {
  it("refuses a cap below the wallets an email already has", async () => {
    let updated = false;
    const pool = scriptedPool([
      (sql) => {
        expect(sql).toContain("FOR UPDATE");
        return { rows: [{ id: "app" }] };
      },
      (sql) => {
        expect(sql).toContain("DELETE FROM email_wallet_claims");
        return { rows: [] };
      },
      () => ({ rows: [{ email: "a@example.com", n: 2 }] }),
      () => {
        updated = true;
        return { rows: [] };
      },
    ]);
    await expect(setAppEmailWalletLimit(pool, { appId: "app", emailWalletLimit: 1 })).resolves.toEqual({
      kind: "conflict",
      email: "a@example.com",
      count: 2,
    });
    expect(updated).toBe(false);
  });

  it("clears claims when the lock is removed", async () => {
    const sqls: string[] = [];
    const pool = scriptedPool([
      () => ({ rows: [{ id: "app" }] }),
      (sql) => {
        sqls.push(sql);
        return { rows: [] };
      },
      (sql, params) => {
        sqls.push(sql);
        expect(params).toEqual(["app", null]);
        return { rows: [] };
      },
    ]);
    await expect(setAppEmailWalletLimit(pool, { appId: "app", emailWalletLimit: null })).resolves.toEqual({
      kind: "updated",
      emailWalletLimit: null,
    });
    expect(sqls[0]).toContain("DELETE FROM email_wallet_claims");
    expect(sqls[1]).toContain("UPDATE apps");
  });

  it("reports an unknown app", async () => {
    const pool = scriptedPool([() => ({ rows: [] })]);
    await expect(setAppEmailWalletLimit(pool, { appId: "missing", emailWalletLimit: 1 })).resolves.toEqual({
      kind: "not_found",
    });
  });
});
