import type { PoolClient } from "pg";
import { insertAuditLog } from "../db/queries.js";

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
    outcome: params.outcome
  });
}
