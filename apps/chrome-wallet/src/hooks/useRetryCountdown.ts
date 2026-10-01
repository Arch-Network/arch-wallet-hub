import { useEffect, useRef, useState } from "react";

/**
 * Whole seconds until `retryAt` (epoch ms), ticking once a second, and
 * calls `onExpire` once when it is reached. Returns null when `retryAt`
 * is null. Stays at 0 after expiry until the caller sets a new
 * `retryAt` (or null), so a retry in flight can still say so.
 */
export function useRetryCountdown(retryAt: number | null, onExpire: () => void): number | null {
  const [now, setNow] = useState(() => Date.now());
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (retryAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= retryAt) {
        clearInterval(timer);
        onExpireRef.current();
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [retryAt]);

  return retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
}
