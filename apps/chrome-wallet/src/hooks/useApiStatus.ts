import { useState, useEffect, useCallback, useRef } from "react";
import { getClient } from "../utils/sdk";
import { getIndexer } from "../utils/indexer";

type StatusValue = "connected" | "disconnected" | "checking";

export interface NetworkStatus {
  api: StatusValue;
  bitcoin: StatusValue;
  arch: StatusValue;
}

const INITIAL_STATUS: NetworkStatus = {
  api: "checking",
  bitcoin: "checking",
  arch: "checking",
};

const POLL_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("probe-timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Probe upstream health using the Indexer (for `arch` + `bitcoin`) and the
 * Hub's Turnkey config (for `api`). Each probe is independent, so a Hub outage
 * doesn't make the chain pills go red, and vice versa. Each probe times out
 * independently so a hanging upstream can't keep the UI stuck in "checking".
 */
export function useApiStatus() {
  const [status, setStatus] = useState<NetworkStatus>(INITIAL_STATUS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    const indexer = await getIndexer();

    const archProbe = withTimeout(indexer.getNetworkStats(), PROBE_TIMEOUT_MS)
      .then(() => "connected" as const)
      .catch(() => "disconnected" as const);

    const btcProbe = withTimeout(indexer.getBtcFeeEstimates(), PROBE_TIMEOUT_MS)
      .then(() => "connected" as const)
      .catch(() => "disconnected" as const);

    const apiProbe = (async () => {
      try {
        const client = await getClient();
        await withTimeout(client.getTurnkeyConfig(), PROBE_TIMEOUT_MS);
        return "connected" as const;
      } catch {
        return "disconnected" as const;
      }
    })();

    const [arch, bitcoin, api] = await Promise.all([archProbe, btcProbe, apiProbe]);
    setStatus({ api, bitcoin, arch });
  }, []);

  useEffect(() => {
    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [check]);

  return { status, retry: check };
}
