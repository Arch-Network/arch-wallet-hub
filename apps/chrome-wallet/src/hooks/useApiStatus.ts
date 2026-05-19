import { useState, useEffect, useCallback, useRef } from "react";
import { getClient } from "../utils/sdk";
import { getIndexer, isIndexerAuthError } from "../utils/indexer";

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
// Cold-start on the indexer's Bitcoin RPC backend can routinely blow past
// PROBE_TIMEOUT_MS on the very first hit after the popup opens, even when
// the service is fully healthy. We retry once with a longer timeout before
// reporting "disconnected" so users don't see a spurious
// "Bitcoin data unavailable" banner that goes away on its own 30s later.
const PROBE_RETRY_TIMEOUT_MS = 12_000;
const PROBE_RETRY_DELAY_MS = 500;
// We require this many consecutive failed checks before flipping any
// probe's status to "disconnected" and surfacing a banner. One failed
// check is treated as a transient blip; the UI stays in "checking" until
// a second check confirms the outage. This trades a small detection
// delay for a much lower false-positive rate.
const MIN_FAILURES_TO_DISCONNECT = 2;
// How quickly to fire a confirmation check after a single failed probe.
// Short enough that genuine outages still surface within seconds, long
// enough to let a cold-start backend warm up between attempts.
const FAST_CONFIRM_DELAY_MS = 3_000;
const PROBE_KEYS = ["arch", "bitcoin", "api"] as const;
type ProbeKey = (typeof PROBE_KEYS)[number];

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
 * Run a single upstream probe with one cold-start retry. The first attempt
 * uses the short timeout; if it fails for any reason we wait briefly and
 * try once more with a longer timeout. Returns "connected" if either
 * attempt succeeds, otherwise "disconnected".
 */
async function probeWithRetry(fn: () => Promise<unknown>): Promise<"connected" | "disconnected"> {
  try {
    await withTimeout(fn(), PROBE_TIMEOUT_MS);
    return "connected";
  } catch {
    try {
      await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAY_MS));
      await withTimeout(fn(), PROBE_RETRY_TIMEOUT_MS);
      return "connected";
    } catch {
      return "disconnected";
    }
  }
}

export interface UseApiStatusOptions {
  /**
   * When false, the hook stays in `"checking"` and does not probe. Use this
   * to defer probing until the wallet is unlocked, otherwise the very first
   * check runs against an empty indexer API key (locked-shell state) and
   * the BTC endpoint — which requires auth — flips to `"disconnected"`,
   * surfacing a spurious "Bitcoin data unavailable" banner until the next
   * 30s tick or a manual retry.
   */
  enabled?: boolean;
}

/**
 * Probe upstream health using the Indexer (for `arch` + `bitcoin`) and the
 * Hub's Turnkey config (for `api`). Each probe is independent, so a Hub outage
 * doesn't make the chain pills go red, and vice versa. Each probe times out
 * independently so a hanging upstream can't keep the UI stuck in "checking".
 */
export function useApiStatus(options: UseApiStatusOptions = {}) {
  const { enabled = true } = options;
  const [status, setStatus] = useState<NetworkStatus>(INITIAL_STATUS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fastConfirmRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef<Record<ProbeKey, number>>({ arch: 0, bitcoin: 0, api: 0 });
  // Guard against overlapping checks. The 30s interval can fire while a
  // slow check is still in flight (e.g. when both attempts of all three
  // probes time out). Letting both runs race causes the failure counters
  // to double-tick on the same outage window.
  const inflightRef = useRef(false);

  const check = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const indexer = await getIndexer().catch((err) => {
        if (isIndexerAuthError(err)) return null;
        throw err;
      });

      const archProbe = indexer
        ? probeWithRetry(() => indexer.getNetworkStats())
        : Promise.resolve<"disconnected">("disconnected");
      const btcProbe = indexer
        ? probeWithRetry(() => indexer.getBtcFeeEstimates())
        : Promise.resolve<"disconnected">("disconnected");
      const apiProbe = probeWithRetry(async () => {
        const client = await getClient();
        return client.getTurnkeyConfig();
      });

      const [arch, bitcoin, api] = await Promise.all([archProbe, btcProbe, apiProbe]);
      const results: Record<ProbeKey, "connected" | "disconnected"> = { arch, bitcoin, api };

      let needsConfirm = false;
      setStatus((prev) => {
        const next: NetworkStatus = { ...prev };
        for (const key of PROBE_KEYS) {
          if (results[key] === "connected") {
            failuresRef.current[key] = 0;
            next[key] = "connected";
          } else {
            failuresRef.current[key] += 1;
            if (failuresRef.current[key] >= MIN_FAILURES_TO_DISCONNECT) {
              next[key] = "disconnected";
            } else {
              // First-failure: don't flip the banner yet. Preserve the
              // previous "connected" reading if we had one; otherwise
              // hold in "checking" while a fast confirmation check runs.
              next[key] = prev[key] === "connected" ? "connected" : "checking";
              needsConfirm = true;
            }
          }
        }
        return next;
      });

      if (needsConfirm) {
        if (fastConfirmRef.current) clearTimeout(fastConfirmRef.current);
        fastConfirmRef.current = setTimeout(() => {
          fastConfirmRef.current = null;
          void check();
        }, FAST_CONFIRM_DELAY_MS);
      }
    } finally {
      inflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Phase 5.7: don't burn CPU/network polling while the popup or
    // sidepanel is hidden in the background. Run a single check on
    // mount and on each visibility -> visible transition; otherwise
    // poll only when visible.
    const start = () => {
      if (intervalRef.current) return;
      check();
      intervalRef.current = setInterval(check, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (fastConfirmRef.current) {
        clearTimeout(fastConfirmRef.current);
        fastConfirmRef.current = null;
      }
    };

    if (!enabled) {
      // Reset to "checking" so any prior result from a previous enabled
      // window doesn't bleed through (e.g. unlocked -> lock -> unlock).
      stop();
      failuresRef.current = { arch: 0, bitcoin: 0, api: 0 };
      setStatus(INITIAL_STATUS);
      return;
    }

    const handleVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      stop();
    };
  }, [check, enabled]);

  return { status, retry: check };
}
