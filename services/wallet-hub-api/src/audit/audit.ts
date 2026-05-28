import type { PoolClient } from "pg";
import { insertAuditLog } from "../db/queries.js";

/**
 * Module-level holder for the HMAC chain secret. Set once at boot
 * by `configureAudit` (called from createServer); read on every
 * audit insert. We use a module singleton rather than threading
 * the secret through every call site because:
 *   - The secret never changes at runtime.
 *   - Audit calls are scattered across ~6 route modules; passing
 *     it as a parameter to every auditEvent call would inflate
 *     every signature for zero benefit.
 *   - Tests of the pure chain helpers don't need this -- they
 *     pass the secret explicitly to computeRowHash / verifyChain.
 *
 * If `configureAudit` is never called and an insert happens, we
 * throw -- silently inserting unchained rows would defeat the
 * tamper-evidence goal of this whole subsystem.
 */
let auditSecret: string | null = null;

export function configureAudit(secret: string): void {
  auditSecret = secret;
}

function requireAuditSecret(): string {
  if (auditSecret === null) {
    throw new Error(
      "audit subsystem not configured: call configureAudit(secret) at boot",
    );
  }
  return auditSecret;
}

export async function auditEvent(params: {
  client: PoolClient;
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
}) {
  await insertAuditLog(params.client, {
    appId: params.appId,
    requestId: params.requestId,
    userId: params.userId,
    eventType: params.eventType,
    entityType: params.entityType,
    entityId: params.entityId,
    turnkeyActivityId: params.turnkeyActivityId,
    turnkeyRequestId: params.turnkeyRequestId,
    payloadJson: params.payloadJson,
    outcome: params.outcome,
    chainSecret: requireAuditSecret()
  });
}
