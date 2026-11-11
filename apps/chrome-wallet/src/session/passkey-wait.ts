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

let current: PasskeyWait | null = null;
const listeners = new Set<() => void>();

export function getPasskeyWait(): PasskeyWait | null {
  return current;
}

export function setPasskeyWait(next: PasskeyWait | null): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribePasskeyWait(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
