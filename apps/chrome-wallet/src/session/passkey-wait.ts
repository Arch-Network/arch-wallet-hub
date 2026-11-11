/**
 * Tells the wallet UI that a passkey ceremony is open in its own
 * window (passkey-hosted.ts).
 *
 * The page that started the ceremony only knows "still waiting", for
 * up to the ceremony timeout. Without this the user sees a bare
 * spinner and no hint that the answer is expected in another window,
 * which may be behind this one.
 */

export interface PasskeyWait {
  /** Bring the passkey window to the front. */
  focus(): void;
  /** Close the passkey window and fail the ceremony. */
  cancel(): void;
}

/**
 * A ceremony that failed after the screen that started it was gone.
 * Unlock is the case: the dashboard is already showing when the
 * passkey answers, so the failure has nowhere else to appear.
 */
export interface PasskeyProblem {
  message: string;
  /** Run the ceremony again. */
  retry(): void;
}

let current: PasskeyWait | null = null;
let problem: PasskeyProblem | null = null;
const listeners = new Set<() => void>();

export function getPasskeyWait(): PasskeyWait | null {
  return current;
}

export function setPasskeyWait(next: PasskeyWait | null): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getPasskeyProblem(): PasskeyProblem | null {
  return problem;
}

export function setPasskeyProblem(next: PasskeyProblem | null): void {
  if (problem === next) return;
  problem = next;
  for (const listener of listeners) listener();
}

/** Fires when the wait or the problem changes. */
export function subscribePasskeyWait(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
