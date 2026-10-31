import { describe, expect, it, vi } from "vitest";
import { insertIdentity, setVerifiedPrimaryEmail } from "../identities.js";

/**
 * The two person-layer writes a login proof must never make on another
 * user's behalf. No Postgres here: the guard is in the SQL, so the test
 * pins the clause and the null the route code branches on.
 */

const fakeClient = (rows: unknown[]) => ({ query: vi.fn(async (_sql: string, _params: unknown[]) => ({ rows, rowCount: rows.length })) });
const identity = {
  appId: "app", userId: "user-1", kind: "email" as const, subject: "jonah@arch.network",
  issuer: null, audience: null, emailAtLink: "jonah@arch.network", verified: true,
};

describe("insertIdentity", () => {
  it("returns null when the row belongs to another user, and the upsert only updates the caller's own row", async () => {
    const client = fakeClient([]);
    expect(await insertIdentity(client as never, identity)).toBeNull();
    const sql = client.query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/ON CONFLICT \(app_id, kind, subject\) DO UPDATE[\s\S]*WHERE user_identities\.user_id = EXCLUDED\.user_id[\s\S]*RETURNING \*/);
  });

  it("returns the caller's own row", async () => {
    const row = { id: "ident-1", user_id: "user-1", kind: "email", subject: "jonah@arch.network" };
    const client = fakeClient([row]);
    expect(await insertIdentity(client as never, identity)).toEqual(row);
  });
});

describe("setVerifiedPrimaryEmail", () => {
  it("updates nothing while another user of the app holds the email verified", async () => {
    const client = fakeClient([]);
    await setVerifiedPrimaryEmail(client as never, { appId: "app", userId: "user-1", email: "jonah@arch.network" });
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toMatch(/AND NOT EXISTS \([\s\S]*other\.app_id = \$1 AND other\.id <> \$2[\s\S]*lower\(other\.primary_email\) = lower\(\$3\) AND other\.email_verified_at IS NOT NULL/);
    expect(params).toEqual(["app", "user-1", "jonah@arch.network"]);
  });
});
