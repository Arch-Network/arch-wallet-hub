// HTTP transport for the Arch indexer. Domain modules in this directory
// build on `indexerFetch` (REST) and `indexerRpc` (JSON-RPC 2.0).
//
// This is the chrome-wallet adaptation: gone are the `isBrowser()` /
// `next/headers` paths -- the extension always calls the upstream directly,
// using the build-time API key passed via `configureEngine(...)`. Chrome
// extensions bypass CORS for declared host_permissions so we can hit
// `https://explorer.arch.network/api/v1/{net}/rpc` directly from the popup
// or service worker without a proxy.

import { getEngineConfig, type NetworkId } from "@/engine-config";

function getBaseUrl(_networkId?: NetworkId): string {
  // The engine is configured for one network at a time. The `networkId`
  // parameter survives for source-parity with upstream call sites; if a
  // caller passes a different network, we still use the configured base
  // because the host owns network selection.
  return getEngineConfig().transport.indexerBaseUrl;
}

function getApiKey(): string | null {
  const key = getEngineConfig().transport.indexerApiKey?.trim();
  return key && key.length > 0 ? key : null;
}

export class IndexerHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "IndexerHttpError";
  }
}

export class IndexerRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "IndexerRpcError";
  }
}

export async function indexerFetch<T>(
  path: string,
  options: { networkId?: NetworkId } = {},
): Promise<T> {
  const cfg = getEngineConfig();
  const url = `${getBaseUrl(options.networkId)}${path}`;
  const headers: Record<string, string> = {};
  const apiKey = getApiKey();
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    cfg.requestTimeoutMs ?? 8_000,
  );
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const logFn = response.status === 401 || response.status === 403
        ? console.debug
        : console.error;
      logFn("[indexer] REST request failed", {
        path,
        url,
        status: response.status,
        statusText: response.statusText,
        body: body.slice(0, 2_000),
      });
      throw new IndexerHttpError(
        response.status,
        `Indexer ${path} → HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("[indexer] REST request timed out", {
        path,
        url,
        timeoutMs: cfg.requestTimeoutMs ?? 8_000,
      });
      throw new IndexerHttpError(
        0,
        `Indexer ${path} timed out after ${cfg.requestTimeoutMs ?? 8_000}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
};

/**
 * JSON-RPC 2.0 call to the indexer. `params` must be an array
 * (positional) or plain object (named) per JSON-RPC 2.0 §4.2; bare
 * scalars are rejected by the parser. Validator-proxied methods like
 * `send_transaction` accept a bare runtime-tx object for back-compat.
 */
export async function indexerRpc<T>(
  method: string,
  params: unknown,
  options: { networkId?: NetworkId } = {},
): Promise<T> {
  const cfg = getEngineConfig();
  const url = `${getBaseUrl(options.networkId)}/rpc`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = getApiKey();
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    cfg.requestTimeoutMs ?? 8_000,
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      cache: "no-store",
      signal: controller.signal,
      body: requestBody,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 401/403 are common when a local extension build was made
      // without a valid public indexer key. Do not error-spam the
      // console once per `read_account_info` probe; callers already
      // surface degraded readiness. Keep 5xx/network-shaped failures
      // noisy because those indicate real service health issues.
      const logFn = response.status === 401 || response.status === 403
        ? console.debug
        : console.error;
      logFn("[indexer] RPC HTTP error", {
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        params,
        responseBody: body.slice(0, 2_000),
      });
      throw new IndexerRpcError(
        method,
        undefined,
        `Indexer RPC ${method} → HTTP ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`,
      );
    }
    const body = (await response.json()) as JsonRpcResponse<T>;
    if (body.error) {
      // -32002 ("not found") is the expected outcome of sparse-coverage
      // probes; log at debug to keep the error-level signal actionable.
      const logFn = body.error.code === -32002 ? console.debug : console.error;
      logFn("[indexer] RPC returned error", {
        method,
        url,
        params,
        error: body.error,
      });
      const baseMsg = body.error.message ?? `Indexer RPC ${method} failed`;
      const dataStr = body.error.data
        ? ` (${JSON.stringify(body.error.data).slice(0, 240)})`
        : "";
      const code = body.error.code != null ? ` [code ${body.error.code}]` : "";
      throw new IndexerRpcError(
        method,
        body.error.code,
        `${baseMsg}${code}${dataStr}`,
      );
    }
    return body.result as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("[indexer] RPC request timed out", {
        method,
        url,
        timeoutMs: cfg.requestTimeoutMs ?? 8_000,
        params,
      });
      throw new IndexerRpcError(
        method,
        undefined,
        `Indexer RPC ${method} timed out after ${cfg.requestTimeoutMs ?? 8_000}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
