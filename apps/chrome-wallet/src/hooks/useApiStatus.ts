import { useState, useEffect, useCallback, useRef } from "react";
import { getClient } from "../utils/sdk";

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

export function useApiStatus() {
  const [status, setStatus] = useState<NetworkStatus>(INITIAL_STATUS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    try {
      const client = await getClient();
      const res = await client.getHealthStatus();

      setStatus({
        api: "connected",
        bitcoin: res.networks.bitcoin.available ? "connected" : "disconnected",
        arch: res.networks.arch.available ? "connected" : "disconnected",
      });
    } catch {
      setStatus({ api: "disconnected", bitcoin: "disconnected", arch: "disconnected" });
    }
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
