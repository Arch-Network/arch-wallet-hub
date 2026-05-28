import { describe, expect, it } from "vitest";
import {
  canonicalPayloadHash,
  computeRowHash,
  DEV_AUDIT_SECRET_SENTINEL,
  GENESIS_PREV_HASH,
  resolveAuditSecret,
  verifyChain,
  type CanonicalRow,
} from "../chain";

const SECRET = "test-secret-32-bytes-long-padding-here";

function makeRow(overrides: Partial<CanonicalRow> = {}): CanonicalRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    createdAt: "2026-05-28T12:00:00.000Z",
    appId: "11111111-1111-1111-1111-111111111111",
    requestId: null,
    userId: null,
    eventType: "sign_request_create",
    entityType: "signing_request",
    entityId: "req_abc",
    turnkeyActivityId: null,
    turnkeyRequestId: null,
    payloadHashHex: canonicalPayloadHash({ foo: 1, bar: 2 }),
    outcome: "requested",
    ...overrides,
  };
}

describe("audit/chain — pure helpers", () => {
  describe("canonicalPayloadHash", () => {
    it("is deterministic regardless of key order", () => {
      const a = canonicalPayloadHash({ foo: 1, bar: 2, baz: { x: 1, y: 2 } });
      const b = canonicalPayloadHash({ baz: { y: 2, x: 1 }, bar: 2, foo: 1 });
      expect(a).toBe(b);
    });

    it("distinguishes null / {} / empty string", () => {
      const nullHash = canonicalPayloadHash(null);
      const emptyObj = canonicalPayloadHash({});
      const emptyStr = canonicalPayloadHash("");
      expect(new Set([nullHash, emptyObj, emptyStr]).size).toBe(3);
    });

    it("is sensitive to array order", () => {
      const a = canonicalPayloadHash([1, 2, 3]);
      const b = canonicalPayloadHash([3, 2, 1]);
      expect(a).not.toBe(b);
    });

    it("returns 64-char lowercase hex", () => {
      const h = canonicalPayloadHash({ x: 1 });
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("computeRowHash", () => {
    it("is deterministic", () => {
      const row = makeRow();
      const h1 = computeRowHash(SECRET, null, row);
      const h2 = computeRowHash(SECRET, null, row);
      expect(h1).toBe(h2);
    });

    it("changes when ANY field changes", () => {
      const base = makeRow();
      const hBase = computeRowHash(SECRET, null, base);
      const cases: Array<[keyof CanonicalRow, Partial<CanonicalRow>]> = [
        ["id", { id: "00000000-0000-0000-0000-000000000099" }],
        ["createdAt", { createdAt: "2026-05-28T13:00:00.000Z" }],
        ["appId", { appId: "99999999-9999-9999-9999-999999999999" }],
        ["requestId", { requestId: "req-other" }],
        ["userId", { userId: "user-other" }],
        ["eventType", { eventType: "sign_request_complete" }],
        ["entityType", { entityType: "different" }],
        ["entityId", { entityId: "req_xyz" }],
        ["turnkeyActivityId", { turnkeyActivityId: "act-1" }],
        ["turnkeyRequestId", { turnkeyRequestId: "tk-req-1" }],
        ["payloadHashHex", { payloadHashHex: canonicalPayloadHash({ z: 1 }) }],
        ["outcome", { outcome: "succeeded" }],
      ];
      for (const [field, override] of cases) {
        const h = computeRowHash(SECRET, null, makeRow(override));
        expect(h, `field ${field} should affect the hash`).not.toBe(hBase);
      }
    });

    it("changes when prev_hash changes", () => {
      const row = makeRow();
      const a = computeRowHash(SECRET, null, row);
      const b = computeRowHash(SECRET, "0".repeat(64), row);
      expect(a).not.toBe(b);
    });

    it("changes when the secret changes", () => {
      const row = makeRow();
      const a = computeRowHash(SECRET, null, row);
      const b = computeRowHash(SECRET + "x", null, row);
      expect(a).not.toBe(b);
    });

    it("treats null prev_hash and the literal genesis sentinel identically", () => {
      const row = makeRow();
      const withNull = computeRowHash(SECRET, null, row);
      const withGenesis = computeRowHash(SECRET, GENESIS_PREV_HASH, row);
      expect(withNull).toBe(withGenesis);
    });

    it("is NUL-separated so adjacent fields don't collide", () => {
      // If the serializer ever loses NUL separators (e.g. switches to
      // plain concatenation), these two would hash identically.
      // Smush-test: move bytes between adjacent fields and confirm the
      // hashes differ.
      const a = makeRow({ entityType: "ab", entityId: "cd" });
      const b = makeRow({ entityType: "abc", entityId: "d" });
      expect(computeRowHash(SECRET, null, a)).not.toBe(
        computeRowHash(SECRET, null, b),
      );
    });
  });

  describe("verifyChain", () => {
    function buildChain(count: number) {
      const rows: Array<{
        row: CanonicalRow;
        storedPrevHash: string | null;
        storedHash: string | null;
        chainSeq: number | null;
      }> = [];
      let prev: string | null = null;
      for (let i = 0; i < count; i++) {
        const row = makeRow({
          id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
          createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        });
        const hash = computeRowHash(SECRET, prev, row);
        rows.push({ row, storedPrevHash: prev, storedHash: hash, chainSeq: i + 1 });
        prev = hash;
      }
      return rows;
    }

    it("validates an empty chain", () => {
      const r = verifyChain(SECRET, []);
      expect(r.ok).toBe(true);
      expect(r.reason).toBe("chain-empty");
    });

    it("validates a well-formed chain", () => {
      const chain = buildChain(5);
      const r = verifyChain(SECRET, chain);
      expect(r.ok).toBe(true);
      expect(r.reason).toBe("ok");
      expect(r.failedAt).toBeNull();
    });

    it("flags a tampered payload (hash-mismatch on the edited row)", () => {
      const chain = buildChain(5);
      chain[2]!.row = makeRow({
        ...chain[2]!.row,
        eventType: "sign_request_complete",
      });
      const r = verifyChain(SECRET, chain);
      expect(r.ok).toBe(false);
      expect(r.failedAt).toBe(2);
      expect(r.reason).toBe("hash-mismatch");
    });

    it("flags a deleted middle row (chain_seq jumps)", () => {
      const chain = buildChain(5);
      chain.splice(2, 1);
      const r = verifyChain(SECRET, chain);
      expect(r.ok).toBe(false);
      // We hit the seq gap before the prev-hash check, so failure
      // surfaces as chain-seq-non-monotonic at index 2.
      expect(r.reason).toBe("chain-seq-non-monotonic");
      expect(r.failedAt).toBe(2);
    });

    it("flags reordered rows", () => {
      const chain = buildChain(3);
      [chain[0], chain[1]] = [chain[1]!, chain[0]!];
      const r = verifyChain(SECRET, chain);
      expect(r.ok).toBe(false);
    });

    it("flags a missing hash column", () => {
      const chain = buildChain(2);
      chain[1]!.storedHash = null;
      const r = verifyChain(SECRET, chain);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("missing-hash");
      expect(r.failedAt).toBe(1);
    });

    it("flags a wrong-secret verification attempt", () => {
      const chain = buildChain(3);
      const r = verifyChain(SECRET + "x", chain);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("hash-mismatch");
    });
  });

  describe("resolveAuditSecret", () => {
    it("returns the configured secret when set", () => {
      expect(
        resolveAuditSecret({ AUDIT_HMAC_SECRET: "abc", NODE_ENV: "production" }),
      ).toBe("abc");
    });

    it("throws in production when the secret is missing", () => {
      expect(() => resolveAuditSecret({ NODE_ENV: "production" })).toThrow(
        /AUDIT_HMAC_SECRET missing/,
      );
    });

    it("returns the dev sentinel in development", () => {
      expect(resolveAuditSecret({ NODE_ENV: "development" })).toBe(
        DEV_AUDIT_SECRET_SENTINEL,
      );
    });

    it("returns the dev sentinel in test", () => {
      expect(resolveAuditSecret({ NODE_ENV: "test" })).toBe(
        DEV_AUDIT_SECRET_SENTINEL,
      );
    });
  });
});
