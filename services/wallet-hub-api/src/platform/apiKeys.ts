import crypto from "node:crypto";

export type GeneratedApiKey = {
  apiKey: string; // plaintext, returned once
  keyHash: string; // sha256 hex
  keyPrefix: string; // for display/logging
};

export function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  // 32 bytes -> ~43 chars base64url, good entropy for API keys.
  const apiKey = crypto.randomBytes(32).toString("base64url");
  return {
    apiKey,
    keyHash: sha256Hex(apiKey),
    keyPrefix: apiKey.slice(0, 8)
  };
}
