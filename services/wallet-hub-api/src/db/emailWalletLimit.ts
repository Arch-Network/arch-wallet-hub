import type { Pool, PoolClient } from "pg";
import { withDbTransaction } from "./tx.js";

/**
 * How long an in-flight reservation counts against the cap. Longer than
 * a Turnkey create, short enough that a crashed request frees the email.
 */
export const EMAIL_WALLET_CLAIM_TTL_SECONDS = 10 * 60;

export const emailWalletLimitError = {
  email_wallet_limit_reached: "This app allows a limited number of wallets per email",
  recovery_email_locked: "Recovery email is already set for this user",
  email_required: "This app requires an email address to create a wallet",
  email_wallet_import_locked:
    "This app locks wallet creation to an email quota; import is not available",
  email_wallet_limit_exceeds_existing: "Existing wallets for an email already exceed this limit",
} as const;

export type EmailWalletLimitCode = keyof typeof emailWalletLimitError;

export type EmailWalletLimitDecision =
  | { action: "skip" }
  | { action: "reserve" }
  | { action: "reject"; code: EmailWalletLimitCode };

export function normalizeRecoveryEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readLimit(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("apps.email_wallet_limit is not a positive integer or null");
  }
  return n;
}

function readCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("email wallet count was not a non-negative integer");
  return n;
}

/**
 * Decide whether this create may take a slot.
 *
 * `persistedForEmail` is wallets already stored against the email.
 * `inflightForEmail` is unexpired reservations that do not yet have a
 * wallet row. `userResourceCount` covers wallets on this user that are
 * not yet attributed to the email; a successful write stores the email
 * on the user, so those wallets would start counting too.
 */
export function decideEmailWalletLimit(args: {
  limit: number | null;
  requestedEmail: string | null | undefined;
  currentEmail: string | null;
  persistedForEmail: number;
  inflightForEmail: number;
  userResourceCount: number;
}): EmailWalletLimitDecision {
  if (args.limit == null) return { action: "skip" };
  const email = normalizeRecoveryEmail(args.requestedEmail);
  if (!email) return { action: "reject", code: "email_required" };
  const current = normalizeRecoveryEmail(args.currentEmail);
  if (current && current !== email) return { action: "reject", code: "recovery_email_locked" };
  const already = current === email ? args.persistedForEmail : args.persistedForEmail + args.userResourceCount;
  if (already + args.inflightForEmail + 1 > args.limit) {
    return { action: "reject", code: "email_wallet_limit_reached" };
  }
  return { action: "reserve" };
}

export async function getAppEmailWalletLimit(
  client: PoolClient,
  appId: string,
  lock: "share" | "update" | "none" = "share"
): Promise<number | null> {
  const clause = lock === "update" ? " FOR UPDATE" : lock === "share" ? " FOR SHARE" : "";
  const res = await client.query<{ email_wallet_limit: number | null }>(
    `SELECT email_wallet_limit FROM apps WHERE id = $1${clause}`,
    [appId]
  );
  if (res.rows.length === 0) {
    throw new Error(`app ${appId} not found`);
  }
  return readLimit(res.rows[0]!.email_wallet_limit);
}

type AcquireResult =
  | { kind: "skip" }
  | { kind: "reserved"; claimId: string }
  | { kind: "rejected"; code: EmailWalletLimitCode; message: string };

function rejected(code: EmailWalletLimitCode): AcquireResult {
  return { kind: "rejected", code, message: emailWalletLimitError[code] };
}

/**
 * Reserve a slot for a locked app, or skip when the app is unlimited.
 * The transaction commits before Turnkey is called. Callers must release
 * the claim if the create does not commit a wallet row.
 */
export async function acquireEmailWalletSlot(
  pool: Pool,
  params: { appId: string; userId: string; email: string | null | undefined }
): Promise<AcquireResult> {
  return withDbTransaction(pool, async (client) => {
    const limit = await getAppEmailWalletLimit(client, params.appId, "share");
    const email = normalizeRecoveryEmail(params.email);
    if (limit == null) return { kind: "skip" };
    if (!email) return rejected("email_required");

    await client.query(
      `
        INSERT INTO email_wallet_locks (app_id, email_normalized)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [params.appId, email]
    );
    await client.query(
      `
        SELECT 1 FROM email_wallet_locks
        WHERE app_id = $1 AND email_normalized = $2
        FOR UPDATE
      `,
      [params.appId, email]
    );
    await client.query(
      `
        DELETE FROM email_wallet_claims
        WHERE app_id = $1 AND email_normalized = $2
          AND created_at < NOW() - make_interval(secs => $3::int)
      `,
      [params.appId, email, EMAIL_WALLET_CLAIM_TTL_SECONDS]
    );

    const counts = await client.query<{
      current_email: string | null;
      user_resources: number;
      persisted: number;
      inflight: number;
    }>(
      `
        SELECT
          (SELECT lower(recovery_email) FROM users WHERE id = $3 AND app_id = $1) AS current_email,
          (SELECT COUNT(*)::int FROM turnkey_resources r
             WHERE r.user_id = $3 AND r.app_id = $1) AS user_resources,
          (SELECT COUNT(*)::int FROM turnkey_resources r
             JOIN users eu ON eu.id = r.user_id AND eu.app_id = r.app_id
             WHERE r.app_id = $1 AND lower(eu.recovery_email) = $2) AS persisted,
          (SELECT COUNT(*)::int FROM email_wallet_claims c
             WHERE c.app_id = $1 AND c.email_normalized = $2) AS inflight
      `,
      [params.appId, email, params.userId]
    );
    const row = counts.rows[0]!;
    const decision = decideEmailWalletLimit({
      limit,
      requestedEmail: email,
      currentEmail: row.current_email,
      persistedForEmail: readCount(row.persisted),
      inflightForEmail: readCount(row.inflight),
      userResourceCount: readCount(row.user_resources),
    });
    if (decision.action === "skip") return { kind: "skip" };
    if (decision.action === "reject") return rejected(decision.code);

    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO email_wallet_claims (app_id, email_normalized, user_id)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [params.appId, email, params.userId]
    );
    return { kind: "reserved", claimId: inserted.rows[0]!.id };
  });
}

export async function releaseEmailWalletClaim(client: PoolClient, claimId: string): Promise<void> {
  await client.query(`DELETE FROM email_wallet_claims WHERE id = $1`, [claimId]);
}

export type SetEmailWalletLimitResult =
  | { kind: "updated"; emailWalletLimit: number | null }
  | { kind: "not_found" }
  | { kind: "conflict"; email: string; count: number };

/**
 * Admin write. Refuses to set a cap below the wallets an email already
 * has in this app, including unexpired in-flight reservations.
 */
export async function setAppEmailWalletLimit(
  pool: Pool,
  params: { appId: string; emailWalletLimit: number | null }
): Promise<SetEmailWalletLimitResult> {
  return withDbTransaction(pool, async (client) => {
    const existing = await client.query(`SELECT id FROM apps WHERE id = $1 FOR UPDATE`, [params.appId]);
    if (existing.rows.length === 0) return { kind: "not_found" };

    if (params.emailWalletLimit == null) {
      await client.query(`DELETE FROM email_wallet_claims WHERE app_id = $1`, [params.appId]);
    } else {
      await client.query(
        `
          DELETE FROM email_wallet_claims
          WHERE app_id = $1 AND created_at < NOW() - make_interval(secs => $2::int)
        `,
        [params.appId, EMAIL_WALLET_CLAIM_TTL_SECONDS]
      );
      const over = await client.query<{ email: string; n: number }>(
        `
          WITH occupied AS (
            SELECT lower(u.recovery_email) AS email
            FROM turnkey_resources r
            JOIN users u ON u.id = r.user_id AND u.app_id = r.app_id
            WHERE r.app_id = $1 AND u.recovery_email IS NOT NULL
            UNION ALL
            SELECT c.email_normalized AS email
            FROM email_wallet_claims c
            WHERE c.app_id = $1
              AND NOT EXISTS (
                SELECT 1
                FROM turnkey_resources r
                JOIN users u ON u.id = r.user_id AND u.app_id = r.app_id
                WHERE r.app_id = c.app_id
                  AND r.user_id = c.user_id
                  AND lower(u.recovery_email) = c.email_normalized
              )
          )
          SELECT email, COUNT(*)::int AS n
          FROM occupied
          GROUP BY email
          HAVING COUNT(*) > $2
          LIMIT 1
        `,
        [params.appId, params.emailWalletLimit]
      );
      const row = over.rows[0];
      if (row) return { kind: "conflict", email: row.email, count: readCount(row.n) };
    }

    await client.query(`UPDATE apps SET email_wallet_limit = $2 WHERE id = $1`, [
      params.appId,
      params.emailWalletLimit,
    ]);
    return { kind: "updated", emailWalletLimit: params.emailWalletLimit };
  });
}
