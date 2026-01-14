import type { PoolClient } from "pg";

export type CreateUserRow = { id: string };

export async function createUser(client: PoolClient): Promise<CreateUserRow> {
  const res = await client.query<CreateUserRow>(
    `INSERT INTO users DEFAULT VALUES RETURNING id`
  );
  return res.rows[0]!;
}

export type InsertTurnkeyResourceParams = {
  appId: string;
  userId: string | null;
  organizationId: string;
  walletId: string | null;
  vaultId: string | null;
  keyId: string | null;
  policyId: string | null;
  defaultAddress: string | null;
  defaultAddressFormat: string | null;
  defaultDerivationPath: string | null;
};

export type TurnkeyResourceRow = {
  id: string;
  app_id: string;
  user_id: string | null;
  organization_id: string;
  wallet_id: string | null;
  vault_id: string | null;
  key_id: string | null;
  policy_id: string | null;
  default_address: string | null;
  default_address_format: string | null;
  default_derivation_path: string | null;
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
        wallet_id,
        vault_id,
        key_id,
        policy_id,
        default_address,
        default_address_format,
        default_derivation_path
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `,
    [
      params.appId,
      params.userId,
      params.organizationId,
      params.walletId,
      params.vaultId,
      params.keyId,
      params.policyId,
      params.defaultAddress,
      params.defaultAddressFormat,
      params.defaultDerivationPath
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
};

export async function insertAuditLog(
  client: PoolClient,
  params: InsertAuditLogParams
) {
  await client.query(
    `
      INSERT INTO audit_logs (
        app_id,
        request_id,
        user_id,
        event_type,
        entity_type,
        entity_id,
        turnkey_activity_id,
        turnkey_request_id,
        payload_json,
        outcome
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    `,
    [
      params.appId,
      params.requestId,
      params.userId,
      params.eventType,
      params.entityType,
      params.entityId,
      params.turnkeyActivityId,
      params.turnkeyRequestId,
      params.payloadJson ? JSON.stringify(params.payloadJson) : null,
      params.outcome
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
