import type { PoolClient } from "pg";

export type SigningRequestRow = {
  id: string;
  app_id: string;
  user_id: string;
  status: "pending" | "submitted" | "succeeded" | "failed";
  signer_kind: "external" | "turnkey";
  signer_address: string | null;
  turnkey_resource_id: string | null;
  action_type: string;
  payload_to_sign: unknown;
  display_json: unknown;
  /**
   * sha256 hex digest of the canonical-JSON `display_json` value at
   * insert time. NULL for rows inserted before migration 012; the
   * GET handler computes it on the fly in that case so the wire
   * contract stays uniform.
   */
  display_hash: string | null;
  submitted_signature_json: unknown | null;
  result_json: unknown | null;
  error_json: unknown | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function insertSigningRequest(client: PoolClient, params: {
  appId: string;
  userId: string;
  status: SigningRequestRow["status"];
  signerKind: SigningRequestRow["signer_kind"];
  signerAddress: string | null;
  turnkeyResourceId: string | null;
  actionType: string;
  payloadToSign: unknown;
  display: unknown;
  displayHash: string;
  expiresAt: string | null;
}): Promise<SigningRequestRow> {
  const res = await client.query<SigningRequestRow>(
    `
      INSERT INTO signing_requests (
        app_id, user_id, status, signer_kind, signer_address, turnkey_resource_id,
        action_type, payload_to_sign, display_json, display_hash, expires_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)
      RETURNING *
    `,
    [
      params.appId,
      params.userId,
      params.status,
      params.signerKind,
      params.signerAddress,
      params.turnkeyResourceId,
      params.actionType,
      JSON.stringify(params.payloadToSign),
      JSON.stringify(params.display),
      params.displayHash,
      params.expiresAt
    ]
  );
  return res.rows[0]!;
}

export async function getSigningRequestForApp(client: PoolClient, params: {
  id: string;
  appId: string;
}): Promise<SigningRequestRow | null> {
  const res = await client.query<SigningRequestRow>(
    `SELECT * FROM signing_requests WHERE id = $1 AND app_id = $2`,
    [params.id, params.appId]
  );
  return res.rows[0] ?? null;
}

/**
 * Like `getSigningRequestForApp` but takes a row-level lock for the
 * duration of the surrounding transaction. Use this anywhere we are
 * about to transition status (e.g. pending -> submitted) so two
 * concurrent submits can't both observe `pending` and both proceed.
 */
export async function getSigningRequestForAppForUpdate(client: PoolClient, params: {
  id: string;
  appId: string;
}): Promise<SigningRequestRow | null> {
  const res = await client.query<SigningRequestRow>(
    `SELECT * FROM signing_requests WHERE id = $1 AND app_id = $2 FOR UPDATE`,
    [params.id, params.appId]
  );
  return res.rows[0] ?? null;
}

/**
 * Atomically transition a signing request from `pending` -> `submitted`.
 *
 * Returns `true` if this caller won the race and the row transitioned.
 * Returns `false` if another caller already submitted the row (or it
 * was expired / cancelled). Callers MUST treat `false` as
 * "another concurrent submission already happened, abort this one"
 * to avoid double-submitting the same signature to Arch.
 *
 * The `AND status = 'pending'` precondition is what makes this safe
 * even without a row-level lock around the surrounding RPC work.
 */
export async function markSigningRequestSubmitted(client: PoolClient, params: {
  id: string;
  submittedSignatureJson: unknown;
  resultJson?: unknown;
}): Promise<boolean> {
  const res = await client.query(
    `
      UPDATE signing_requests
      SET
        status = 'submitted',
        submitted_signature_json = $2::jsonb,
        result_json = COALESCE($3::jsonb, result_json),
        updated_at = NOW()
      WHERE id = $1
        AND status = 'pending'
    `,
    [params.id, JSON.stringify(params.submittedSignatureJson), params.resultJson ? JSON.stringify(params.resultJson) : null]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markSigningRequestSucceeded(client: PoolClient, params: {
  id: string;
  resultJson: unknown;
}) {
  await client.query(
    `
      UPDATE signing_requests
      SET status = 'succeeded', result_json = $2::jsonb, updated_at = NOW()
      WHERE id = $1
    `,
    [params.id, JSON.stringify(params.resultJson)]
  );
}

export async function markSigningRequestFailed(client: PoolClient, params: {
  id: string;
  errorJson: unknown;
}) {
  await client.query(
    `
      UPDATE signing_requests
      SET status = 'failed', error_json = $2::jsonb, updated_at = NOW()
      WHERE id = $1
    `,
    [params.id, JSON.stringify(params.errorJson)]
  );
}
