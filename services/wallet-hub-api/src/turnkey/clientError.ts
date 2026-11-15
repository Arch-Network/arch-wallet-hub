/**
 * Turnkey's gRPC code 3 is INVALID_ARGUMENT: the request body was rejected
 * (a missing attestation field, an unknown variant, a protobuf syntax error).
 * That is the caller's input. Other Turnkey failures stay server errors.
 */
export function isTurnkeyInvalidRequest(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === 3 || code === "3";
}
