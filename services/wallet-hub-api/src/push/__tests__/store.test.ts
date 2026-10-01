import { describe, expect, it, vi } from "vitest";
import type { PoolClient, QueryResult } from "pg";
import {
  CrossAppTokenConflict,
  lookupPushTargets,
  replaceDeviceRegistration,
} from "../store.js";

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe("push registration store", () => {
  it("keeps unchanged address rows so watch_started_at is preserved", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ id: "registration", app_id: "app", user_id: "user" }]),
      )
      .mockResolvedValueOnce(result([{ id: "registration" }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));
    const client = { query } as unknown as PoolClient;

    await replaceDeviceRegistration(client, {
      appId: "app",
      userId: "user",
      fcmToken: "token",
      platform: "ios",
      addresses: [{ chain: "arch", address: "address" }],
    });

    expect(query.mock.calls[3]?.[0]).toContain("NOT EXISTS");
    expect(query.mock.calls[4]?.[0]).toContain(
      "ON CONFLICT (registration_id, chain, address) DO NOTHING",
    );
  });

  it("rejects cross-app token takeover before mutating the registration", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ id: "registration", app_id: "other-app", user_id: "user" }]),
      );
    const client = { query } as unknown as PoolClient;

    await expect(
      replaceDeviceRegistration(client, {
        appId: "app",
        userId: "user",
        fcmToken: "token",
        platform: "ios",
        addresses: [],
      }),
    ).rejects.toBeInstanceOf(CrossAppTokenConflict);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("allows same-app user handoff and resets the address watch set", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(
        result([{ id: "registration", app_id: "app", user_id: "old-user" }]),
      )
      .mockResolvedValueOnce(result([{ id: "registration" }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));
    const client = { query } as unknown as PoolClient;

    await replaceDeviceRegistration(client, {
      appId: "app",
      userId: "new-user",
      fcmToken: "token",
      platform: "android",
      addresses: [{ chain: "arch", address: "new-address" }],
    });

    expect(query.mock.calls[3]?.[0]).toContain(
      "DELETE FROM push_registration_addresses WHERE registration_id = $1",
    );
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("enforces forward-only watches and correlates batched results", async () => {
    const query = vi.fn().mockResolvedValue(
      result([
        {
          ordinal: "2",
          registration_id: "device-2",
          app_id: "app-2",
          fcm_token: "token-2",
          platform: "android",
        },
      ]),
    );
    const client = { query } as unknown as PoolClient;
    const lookups = [
      {
        chain: "arch" as const,
        address: "first",
        observedAt: "2026-08-06T12:00:00.000Z",
      },
      {
        chain: "btc" as const,
        address: "second",
        observedAt: "2026-08-06T12:01:00.000Z",
      },
    ];

    const results = await lookupPushTargets(client, lookups);

    expect(query.mock.calls[0]?.[0]).toContain(
      "addresses.watch_started_at <= requested.observed_at",
    );
    expect(query.mock.calls[0]?.[0]).toContain("registrations.app_id");
    expect(results[0]?.targets).toEqual([]);
    expect(results[1]?.targets).toEqual([
      {
        registrationId: "device-2",
        appId: "app-2",
        fcmToken: "token-2",
        platform: "android",
      },
    ]);
  });
});
