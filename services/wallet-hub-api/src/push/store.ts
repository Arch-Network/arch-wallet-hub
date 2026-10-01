import type { PoolClient } from "pg";
import type { PushAddress, PushChain } from "./addresses.js";

export type PushTargetLookup = {
  chain: PushChain;
  address: string;
  observedAt: string;
};

export type PushTarget = {
  registrationId: string;
  appId: string;
  fcmToken: string;
  platform: "ios" | "android";
};

export type PushTargetResult = PushTargetLookup & {
  targets: PushTarget[];
};

export class CrossAppTokenConflict extends Error {
  constructor() {
    super("FCM token is already registered to another app");
    this.name = "CrossAppTokenConflict";
  }
}

async function lockToken(client: PoolClient, fcmToken: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [fcmToken],
  );
}

export async function replaceDeviceRegistration(
  client: PoolClient,
  input: {
    appId: string;
    userId: string;
    fcmToken: string;
    platform: "ios" | "android";
    addresses: PushAddress[];
  },
): Promise<void> {
  await lockToken(client, input.fcmToken);

  const existing = await client.query<{
    id: string;
    app_id: string;
    user_id: string;
  }>(
    `
      SELECT id, app_id, user_id
      FROM push_device_registrations
      WHERE fcm_token = $1
      FOR UPDATE
    `,
    [input.fcmToken],
  );

  const previous = existing.rows[0];
  if (previous && previous.app_id !== input.appId) {
    throw new CrossAppTokenConflict();
  }

  const registration = await client.query<{ id: string }>(
    `
      INSERT INTO push_device_registrations
        (app_id, user_id, fcm_token, platform)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (fcm_token) DO UPDATE SET
        app_id = EXCLUDED.app_id,
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        updated_at = NOW()
      RETURNING id
    `,
    [input.appId, input.userId, input.fcmToken, input.platform],
  );
  const registrationId = registration.rows[0]!.id;
  const ownerChanged =
    previous !== undefined && previous.user_id !== input.userId;

  if (ownerChanged) {
    await client.query(
      "DELETE FROM push_registration_addresses WHERE registration_id = $1",
      [registrationId],
    );
  } else {
    await client.query(
      `
        DELETE FROM push_registration_addresses existing
        WHERE existing.registration_id = $1
          AND NOT EXISTS (
            SELECT 1
            FROM unnest($2::text[], $3::text[]) AS wanted(chain, address)
            WHERE wanted.chain = existing.chain
              AND wanted.address = existing.address
          )
      `,
      [
        registrationId,
        input.addresses.map((item) => item.chain),
        input.addresses.map((item) => item.address),
      ],
    );
  }

  if (input.addresses.length > 0) {
    await client.query(
      `
        INSERT INTO push_registration_addresses
          (registration_id, chain, address)
        SELECT $1, input.chain, input.address
        FROM unnest($2::text[], $3::text[]) AS input(chain, address)
        ON CONFLICT (registration_id, chain, address) DO NOTHING
      `,
      [
        registrationId,
        input.addresses.map((item) => item.chain),
        input.addresses.map((item) => item.address),
      ],
    );
  }
}

export async function deleteDeviceRegistration(
  client: PoolClient,
  input: { appId: string; userId: string; fcmToken: string },
): Promise<void> {
  await lockToken(client, input.fcmToken);
  await client.query(
    `
      DELETE FROM push_device_registrations
      WHERE app_id = $1 AND user_id = $2 AND fcm_token = $3
    `,
    [input.appId, input.userId, input.fcmToken],
  );
}

export async function lookupPushTargets(
  client: PoolClient,
  lookups: PushTargetLookup[],
): Promise<PushTargetResult[]> {
  const results: PushTargetResult[] = lookups.map((lookup) => ({
    ...lookup,
    targets: [],
  }));
  if (lookups.length === 0) return results;

  const rows = await client.query<{
    ordinal: string;
    registration_id: string;
    app_id: string;
    fcm_token: string;
    platform: "ios" | "android";
  }>(
    `
      WITH requested AS (
        SELECT chain, address, observed_at, ordinal
        FROM unnest($1::text[], $2::text[], $3::timestamptz[])
          WITH ORDINALITY AS input(chain, address, observed_at, ordinal)
      )
      SELECT
        requested.ordinal,
        registrations.id AS registration_id,
        registrations.app_id,
        registrations.fcm_token,
        registrations.platform
      FROM requested
      JOIN push_registration_addresses addresses
        ON addresses.chain = requested.chain
       AND addresses.address = requested.address
       AND addresses.watch_started_at <= requested.observed_at
      JOIN push_device_registrations registrations
        ON registrations.id = addresses.registration_id
      ORDER BY requested.ordinal, registrations.id
    `,
    [
      lookups.map((item) => item.chain),
      lookups.map((item) => item.address),
      lookups.map((item) => item.observedAt),
    ],
  );

  for (const row of rows.rows) {
    results[Number(row.ordinal) - 1]?.targets.push({
      registrationId: row.registration_id,
      appId: row.app_id,
      fcmToken: row.fcm_token,
      platform: row.platform,
    });
  }
  return results;
}

export async function pruneInvalidTokens(
  client: PoolClient,
  fcmTokens: string[],
): Promise<number> {
  if (fcmTokens.length === 0) return 0;
  const result = await client.query(
    `
      DELETE FROM push_device_registrations
      WHERE fcm_token = ANY($1::text[])
    `,
    [fcmTokens],
  );
  return result.rowCount ?? 0;
}
