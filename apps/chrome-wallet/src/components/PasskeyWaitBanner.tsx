import { useSyncExternalStore } from "react";
import {
  getPasskeyProblem,
  getPasskeyWait,
  setPasskeyProblem,
  subscribePasskeyWait,
} from "../session/passkey-wait";

/**
 * Shown while a passkey ceremony is open in its own window. Mounted
 * once at the app root: unlock, approve, send, onboarding and recovery
 * all wait on the same window and otherwise show only a spinner.
 *
 * Also shows a ceremony that failed with no screen left to report it
 * (a wrong passkey chosen at unlock).
 */
export default function PasskeyWaitBanner() {
  const wait = useSyncExternalStore(subscribePasskeyWait, getPasskeyWait);
  const problem = useSyncExternalStore(subscribePasskeyWait, getPasskeyProblem);

  if (wait) {
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

  if (problem) {
    return (
      <div className="passkey-wait" role="alert">
        <strong>Signing is not unlocked yet</strong>
        <div>{problem.message}</div>
        <div className="passkey-wait-actions">
          <button type="button" onClick={problem.retry}>
            Try again
          </button>
          <button type="button" onClick={() => setPasskeyProblem(null)}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return null;
}
