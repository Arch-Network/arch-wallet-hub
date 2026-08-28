import type { PoolClient } from "pg";

export type CreateUserRow = { id: string };

export async function createUser(client: PoolClient): Promise<CreateUserRow> {
  const res = await client.query<CreateUserRow>(
    `INSERT INTO users DEFAULT VALUES RETURNING id`
  );
  return res.rows[0]!;
}

/**
 * Discriminator for sub-org wallets. "passkey" wallets are bootstrapped via
 * WebAuthn at create-time and use a WebAuthn-stamped activity to re-mint
 * IndexedDB sessions; "email" wallets have no authenticator and rely on
 * an OTP-derived recovery API key to bootstrap each session. NULL is a
 * legacy/parent-org row that the recovery route filters out anyway.
 */
export type TurnkeyAuthMethod = "passkey" | "email";

export type InsertTurnkeyResourceParams = {
  appId: string;
  userId: string | null;
  organizationId: string;
  turnkeyRootUserId: string | null;
  walletId: string | null;
  vaultId: string | null;
  keyId: string | null;
  policyId: string | null;
  defaultAddress: string | null;
  defaultPublicKeyHex: string | null;
  defaultAddressFormat: string | null;
  defaultDerivationPath: string | null;
  authMethod: TurnkeyAuthMethod | null;
};

export type TurnkeyResourceRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  organization_id: string;
  turnkey_root_user_id: string | null;
  wallet_id: string | null;
  vault_id: string | null;
  key_id: string | null;
  policy_id: string | null;
  default_address: string | null;
  default_public_key_hex: string | null;
  default_address_format: string | null;
  default_derivation_path: string | null;
  auth_method: TurnkeyAuthMethod | null;
  created_at: string;
  updated_at: string;
};

export async function insertTurnkeyResource(
  client: PoolClient,
  params: InsertTurnkeyResourceParams
): Promise<TurnkeyResourceRow> {
  const res = await client.query<TurnkeyResourceRow>(
    `
      INSERT INTO turnkey_resources (
        app_id,
        user_id,
        organization_id,
        turnkey_root_user_id,
        wallet_id,
        vault_id,
        key_id,
        policy_id,
        default_address,
        default_public_key_hex,
        default_address_format,
        default_derivation_path,
        auth_method
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `,
    [
      params.appId,
      params.userId,
      params.organizationId,
      params.turnkeyRootUserId,
      params.walletId,
      params.vaultId,
      params.keyId,
      params.policyId,
      params.defaultAddress,
      params.defaultPublicKeyHex,
      params.defaultAddressFormat,
      params.defaultDerivationPath,
      params.authMethod
    ]
  );
  return res.rows[0]!;
}

export async function getTurnkeyResourceById(
  client: PoolClient,
  id: string
): Promise<TurnkeyResourceRow | null> {
  const res = await client.query<TurnkeyResourceRow>(
    `SELECT * FROM turnkey_resources WHERE id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function getTurnkeyResourceByIdForApp(
  client: PoolClient,
  params: { id: string; appId: string }
): Promise<TurnkeyResourceRow | null> {
  const res = await client.query<TurnkeyResourceRow>(
    `SELECT * FROM turnkey_resources WHERE id = $1 AND app_id = $2`,
    [params.id, params.appId]
  );
  return res.rows[0] ?? null;
}

export type LinkedWalletRow = {
  id: string;
  app_id: string;
  user_id: string;
  wallet_provider: string;
  address: string;
};

/**
 * Fetch a linked wallet for (app, user, provider, address). Used by the
 * external-wallet session-mint to confirm the BIP-322 signer's address
 * belongs to the challenge's user before issuing a token.
 */
export async function getLinkedWalletForUser(
  client: PoolClient,
  params: { appId: string; userId: string; walletProvider: string; address: string }
): Promise<LinkedWalletRow | null> {
  const res = await client.query<LinkedWalletRow>(
    `
      SELECT id, app_id, user_id, wallet_provider, address
      FROM linked_wallets
      WHERE app_id = $1 AND user_id = $2 AND wallet_provider = $3 AND address = $4
    `,
    [params.appId, params.userId, params.walletProvider, params.address]
  );
  return res.rows[0] ?? null;
}

export async function updateTurnkeyResourceDefaultPublicKeyHexForApp(
  client: PoolClient,
  params: { id: string; appId: string; defaultPublicKeyHex: string }
): Promise<TurnkeyResourceRow | null> {
  const res = await client.query<TurnkeyResourceRow>(
    `
      UPDATE turnkey_resources
      SET default_public_key_hex = $3, updated_at = NOW()
      WHERE id = $1 AND app_id = $2
      RETURNING *
    `,
    [params.id, params.appId, params.defaultPublicKeyHex]
  );
  return res.rows[0] ?? null;
}

export async function listTurnkeyResourcesForUserForApp(
  client: PoolClient,
  params: { appId: string; userId: string }
): Promise<TurnkeyResourceRow[]> {
  const res = await client.query<TurnkeyResourceRow>(
    `SELECT * FROM turnkey_resources WHERE app_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
    [params.appId, params.userId]
  );
  return res.rows;
}

/**
 * Find the earliest email-auth wallet registered to `email` within `appId`,
 * across every user that shares that recovery email. Backs the get-or-create
 * behaviour of POST /turnkey/email-wallets so one email maps to one wallet:
 * without it, each create mints a fresh sub-org and repeated email logins
 * (including ones triggered by a rate-limited /init returning an empty
 * candidate list) accumulate duplicate wallets under the same identity.
 *
 * Only addressable rows qualify — a default address and public key are
 * required so the caller can return a usable wallet without re-deriving.
 */
export async function findEmailWalletByRecoveryEmail(
  client: PoolClient,
  params: { appId: string; email: string }
): Promise<TurnkeyResourceRow | null> {
  const normalised = params.email.trim().toLowerCase();
  if (!normalised) return null;
  const res = await client.query<TurnkeyResourceRow>(
    `
      SELECT r.*
      FROM turnkey_resources r
      JOIN users u ON u.id = r.user_id
      WHERE r.app_id = $1
        AND lower(u.recovery_email) = $2
        AND r.auth_method = 'email'
        AND r.default_address IS NOT NULL
        AND r.default_public_key_hex IS NOT NULL
      ORDER BY r.created_at ASC
      LIMIT 1
    `,
    [params.appId, normalised]
  );
  return res.rows[0] ?? null;
}

export type InsertAuditLogParams = {
  appId: string;
  requestId: string | null;
  userId: string | null;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  turnkeyActivityId: string | null;
  turnkeyRequestId: string | null;
  payloadJson: unknown | null;
  outcome: "requested" | "succeeded" | "failed";
  /** HMAC key for the per-app chain. See audit/chain.ts. */
  chainSecret: string;
};

/**
 * Insert an audit row AND compute its position in the per-app HMAC
 * chain. Concurrency strategy:
 *
 *   1. `pg_advisory_xact_lock(hashtextextended(app_id::text, 0))`
 *      serializes inserts for the SAME app without blocking other
 *      apps or any read traffic. The lock auto-releases at xact end.
 *   2. SELECT the chain tip (hash + chain_seq) within the lock so
 *      no other inserter can race past us.
 *   3. INSERT with prev_hash = tip.hash, chain_seq = tip.seq + 1,
 *      hash = HMAC(secret, prev || canonical(row)).
 *
 * The row id is generated client-side (uuid.v4) so we can include
 * it in the hash input -- otherwise we'd need a two-step INSERT...
 * RETURNING id; UPDATE ... SET hash dance. With a client-side id we
 * compute the hash up-front and write the full row in one statement.
 *
 * The function must be called within an existing transaction (the
 * caller's PoolClient should already be in a BEGIN). The advisory
 * lock keyword `_xact_` enforces this by silently doing nothing
 * outside a transaction, which would corrupt the chain. We don't
 * BEGIN here because callers compose multiple writes atomically.
 */
export async function insertAuditLog(
  client: PoolClient,
  params: InsertAuditLogParams
) {
  const { computeRowHash, canonicalPayloadHash } = await import(
    "../audit/chain.js"
  );
  const { randomUUID } = await import("node:crypto");

  // Serialize per-app chain writes. We hash the app_id to a bigint
  // because pg_advisory_xact_lock takes integer args; hashtextextended
  // is deterministic + collision-resistant enough for keyspace
  // partitioning. Different apps hash to different keys with high
  // probability so cross-app inserts never wait on each other.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [params.appId]
  );

  const tipRes = await client.query<{
    hash: string | null;
    chain_seq: string | null;
  }>(
    `SELECT hash, chain_seq
       FROM audit_logs
      WHERE app_id = $1 AND chain_seq IS NOT NULL
      ORDER BY chain_seq DESC
      LIMIT 1`,
    [params.appId]
  );
  const tip = tipRes.rows[0] ?? null;
  const prevHash = tip?.hash ?? null;
  // chain_seq is a bigint in Postgres; node-pg returns it as a string
  // to avoid silent precision loss. We parseInt with safety in mind:
  // an audit chain that exceeds 2^53 events is implausible (10 years
  // at 1B events/year is < 1e10), so Number is fine. Belt-and-
  // suspenders: cap at MAX_SAFE_INTEGER and throw if we'd overflow.
  let nextSeq: number;
  if (tip?.chain_seq === null || tip?.chain_seq === undefined) {
    nextSeq = 1;
  } else {
    const tipSeq = Number(tip.chain_seq);
    if (!Number.isSafeInteger(tipSeq)) {
      throw new Error(`audit chain_seq overflow for app ${params.appId}`);
    }
    nextSeq = tipSeq + 1;
  }

  const id = randomUUID();
  const createdAtIso = new Date().toISOString();
  const payloadHashHex = canonicalPayloadHash(params.payloadJson ?? null);

  const hash = computeRowHash(params.chainSecret, prevHash, {
    id,
    createdAt: createdAtIso,
    appId: params.appId,
    requestId: params.requestId,
    userId: params.userId,
    eventType: params.eventType,
    entityType: params.entityType,
    entityId: params.entityId,
    turnkeyActivityId: params.turnkeyActivityId,
    turnkeyRequestId: params.turnkeyRequestId,
    payloadHashHex,
    outcome: params.outcome
  });

  await client.query(
    `
      INSERT INTO audit_logs (
        id,
        created_at,
        app_id,
        request_id,
        user_id,
        event_type,
        entity_type,
        entity_id,
        turnkey_activity_id,
        turnkey_request_id,
        payload_json,
        outcome,
        prev_hash,
        hash,
        chain_seq
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
    `,
    [
      id,
      createdAtIso,
      params.appId,
      params.requestId,
      params.userId,
      params.eventType,
      params.entityType,
      params.entityId,
      params.turnkeyActivityId,
      params.turnkeyRequestId,
      params.payloadJson ? JSON.stringify(params.payloadJson) : null,
      params.outcome,
      prevHash,
      hash,
      nextSeq
    ]
  );
}

export type IdempotencyStatus = "pending" | "succeeded" | "failed";

export type IdempotencyRow = {
  id: string;
  app_id: string;
  idempotency_key: string;
  route: string;
  request_hash: string;
  status: IdempotencyStatus;
  response_json: unknown | null;
  error_json: unknown | null;
};

export async function getIdempotencyRow(
  client: PoolClient,
  params: { appId: string; key: string; route: string }
): Promise<IdempotencyRow | null> {
  const res = await client.query<IdempotencyRow>(
    `SELECT id, app_id, idempotency_key, route, request_hash, status, response_json, error_json FROM idempotency_keys WHERE app_id = $1 AND idempotency_key = $2 AND route = $3`,
    [params.appId, params.key, params.route]
  );
  return res.rows[0] ?? null;
}

export async function insertIdempotencyRow(
  client: PoolClient,
  params: { appId: string; key: string; route: string; requestHash: string }
): Promise<IdempotencyRow> {
  const res = await client.query<IdempotencyRow>(
    `
      INSERT INTO idempotency_keys (app_id, idempotency_key, route, request_hash, status)
      VALUES ($1,$2,$3,$4,'pending')
      RETURNING id, app_id, idempotency_key, route, request_hash, status, response_json, error_json
    `,
    [params.appId, params.key, params.route, params.requestHash]
  );
  return res.rows[0]!;
}

export async function markIdempotencySucceeded(
  client: PoolClient,
  id: string,
  responseJson: unknown
) {
  await client.query(
    `
      UPDATE idempotency_keys
      SET status = 'succeeded', response_json = $2::jsonb, updated_at = NOW()
      WHERE id = $1
    `,
    [id, JSON.stringify(responseJson)]
  );
}

export async function markIdempotencyFailed(
  client: PoolClient,
  id: string,
  errorJson: unknown
) {
  await client.query(
    `
      UPDATE idempotency_keys
      SET status = 'failed', error_json = $2::jsonb, updated_at = NOW()
      WHERE id = $1
    `,
    [id, JSON.stringify(errorJson)]
  );
}
