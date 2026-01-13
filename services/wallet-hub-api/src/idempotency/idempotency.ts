import crypto from "node:crypto";
import type { PoolClient } from "pg";
import {
  getIdempotencyRow,
  insertIdempotencyRow,
  type IdempotencyRow
} from "../db/queries.js";

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function computeRequestHash(body: unknown) {
  return sha256Hex(stableStringify(body));
}

export type ConsumeIdempotencyKeyResult =
  | { kind: "created"; row: IdempotencyRow }
  | { kind: "replayed"; row: IdempotencyRow; response: unknown }
  | { kind: "conflict"; reason: string }
  | { kind: "in_progress"; reason: string }
  | { kind: "failed"; reason: string; error: unknown | null };

export async function consumeIdempotencyKey(params: {
  client: PoolClient;
  appId: string;
  key: string;
  route: string;
  requestHash: string;
}): Promise<ConsumeIdempotencyKeyResult> {
  const existing = await getIdempotencyRow(params.client, {
    appId: params.appId,
    key: params.key,
    route: params.route
  });

  if (!existing) {
    const row = await insertIdempotencyRow(params.client, {
      appId: params.appId,
      key: params.key,
      route: params.route,
      requestHash: params.requestHash
    });
    return { kind: "created", row };
  }

  if (existing.request_hash !== params.requestHash) {
    return {
      kind: "conflict",
      reason: "Idempotency-Key reuse with different request body"
    };
  }

  if (existing.status === "succeeded") {
    return { kind: "replayed", row: existing, response: existing.response_json };
  }

  if (existing.status === "pending") {
    return { kind: "in_progress", reason: "Request with this Idempotency-Key is still pending" };
  }

  return { kind: "failed", reason: "Previous attempt failed", error: existing.error_json };
}
