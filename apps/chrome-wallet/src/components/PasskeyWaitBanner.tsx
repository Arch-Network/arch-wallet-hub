import { useSyncExternalStore } from "react";
import { getPasskeyWait, subscribePasskeyWait } from "../session/passkey-wait";

/**
 * Shown while a passkey ceremony is open in its own window. Mounted
 * once at the app root: unlock, approve, send, onboarding and recovery
 * all wait on the same window and otherwise show only a spinner.
 */
export default function PasskeyWaitBanner() {
  const wait = useSyncExternalStore(subscribePasskeyWait, getPasskeyWait);
  if (!wait) return null;

  return (
    <div className="passkey-wait" role="status">
      <strong>Waiting for your passkey</strong>
      <div>Finish in the passkey window. It may be behind this one.</div>
      <div className="passkey-wait-actions">
        <button type="button" onClick={wait.focus}>
          Show passkey window
        </button>
        <button type="button" onClick={wait.cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
