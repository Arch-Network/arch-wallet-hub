import { useEffect, useState } from "react";

/**
 * Returns true when the current viewport is wide enough to take advantage
 * of extra horizontal space (e.g. wide side panel, large standalone window).
 *
 * Defaults to false on first render so SSR / pre-hydration shells use the
 * compact layout. The actual value lands after the first effect runs.
 *
 * The breakpoint is intentionally a bit higher than the sidebar-appears
 * threshold (560px) so the "wide" treatment only kicks in once there's
 * meaningful extra real estate to spend, not just enough for the sidebar.
 */
export function useWideMode(minWidth = 720): boolean {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [minWidth]);

  return wide;
}
