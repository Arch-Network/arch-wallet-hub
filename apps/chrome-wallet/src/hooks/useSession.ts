/**
 * useSession -- thin React adapter over the SessionManager singleton.
 *
 * The SessionManager itself is non-reactive (a plain singleton), but
 * the gating logic in App.tsx -- "do we show the OTP bootstrap screen
 * vs the main app?" -- needs to re-render any time a session opens,
 * closes, or expires. We expose that via useSyncExternalStore.
 *
 * Why not move the gate into wallet-store: wallet-store already
 * fires whenever the persisted AppState changes (via
 * chrome.storage.onChanged). Session state never touches
 * chrome.storage (the stamper lives in IndexedDB and that's
 * intentional -- chrome.storage is a synced log of metadata, not
 * the right home for cryptographic material). Keeping the two
 * observables independent avoids a coupling that would force every
 * AppState write to bust session caches.
 */

import { useSyncExternalStore } from "react";
import { sessionManager } from "../session/SessionManager";
import type { SessionStatus } from "../session/types";

export function useSession(): SessionStatus {
  useSyncExternalStore(
    (listener) => sessionManager.subscribe(listener),
    sessionManager.getVersion,
    sessionManager.getVersion,
  );
  return sessionManager.status();
}
