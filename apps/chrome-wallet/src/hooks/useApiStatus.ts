import { useState, useEffect, useCallback, useRef } from "react";
import { getClient } from "../utils/sdk";

export type ApiStatus = "connected" | "disconnected" | "checking";

const POLL_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 8_000;

export function useApiStatus() {
  const [status, setStatus] = useState<ApiStatus>("checking");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    try {
      const client = await getClient();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      await client.getNetworkStats();
      clearTimeout(timer);
      setStatus("connected");
    } catch {
      setStatus("disconnected");
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
