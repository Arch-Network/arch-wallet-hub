import { timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function extractServiceKey(headers: Record<string, unknown>): string | null {
  const direct = headers["x-service-key"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const authorization = headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function hasValidServiceKey(
  headers: Record<string, unknown>,
  configuredKey: string | undefined,
): boolean {
  if (!configuredKey) return false;
  const supplied = extractServiceKey(headers);
  return supplied !== null && safeEqual(supplied, configuredKey);
}
