import type { Env } from "../config/env.js";

export class EntitlementConfigurationError extends Error {}
export class EntitlementUpstreamError extends Error {}

function internalBaseUrl(config: Env): string | null {
  if (config.INDEXER_INTERNAL_BASE_URL) {
    return config.INDEXER_INTERNAL_BASE_URL.replace(/\/+$/, "");
  }
  if (!config.INDEXER_BASE_URL) return null;
  return config.INDEXER_BASE_URL
    .replace(/\/api\/v1(?:\/(?:mainnet|testnet))?\/?$/, "")
    .replace(/\/+$/, "");
}

export async function isPushEntitled(
  config: Env,
  appId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const baseUrl = internalBaseUrl(config);
  const serviceKey = config.INDEXER_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    throw new EntitlementConfigurationError(
      "Push entitlement service is not configured",
    );
  }

  const url =
    `${baseUrl}/api/v1/internal/push-entitlements/by-app/` +
    encodeURIComponent(appId);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${serviceKey}`,
        "x-service-key": serviceKey,
      },
      signal: AbortSignal.timeout(config.INDEXER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EntitlementUpstreamError(
      `Push entitlement request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (response.status === 404) return false;
  if (!response.ok) {
    throw new EntitlementUpstreamError(
      `Push entitlement service returned ${response.status}`,
    );
  }

  const body = (await response.json()) as { entitled?: unknown };
  if (typeof body.entitled !== "boolean") {
    throw new EntitlementUpstreamError(
      "Push entitlement service returned an invalid response",
    );
  }
  return body.entitled;
}
