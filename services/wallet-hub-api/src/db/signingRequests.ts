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
  expiresAt: string | null;
}): Promise<SigningRequestRow> {
  const res = await client.query<SigningRequestRow>(
    `
      INSERT INTO signing_requests (
        app_id, user_id, status, signer_kind, signer_address, turnkey_resource_id,
        action_type, payload_to_sign, display_json, expires_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
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

export async function markSigningRequestSubmitted(client: PoolClient, params: {
  id: string;
  submittedSignatureJson: unknown;
  resultJson?: unknown;
}) {
  await client.query(
    `
      UPDATE signing_requests
      SET
        status = 'submitted',
        submitted_signature_json = $2::jsonb,
        result_json = COALESCE($3::jsonb, result_json),
        updated_at = NOW()
      WHERE id = $1
    `,
    [params.id, JSON.stringify(params.submittedSignatureJson), params.resultJson ? JSON.stringify(params.resultJson) : null]
  );
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
