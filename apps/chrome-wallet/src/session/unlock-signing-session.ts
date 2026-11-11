import { walletStore } from "../state/wallet-store";
import { WrongPasskeyError } from "./bootstrap-passkey";
import { setPasskeyProblem } from "./passkey-wait";

/**
 * Open a signing session for the active account right after unlock.
 * For a passkey wallet that is one WebAuthn prompt now; for an email
 * wallet it is nothing (the OTP step has its own flow, run before the
 * first sign).
 *
 * Best-effort: the keystore stays unlocked whatever happens here,
 * because viewing balances and history must not depend on a signing
 * credential being live. A dismissed prompt is dropped -- the next
 * sign attempt throws SessionLockedError and the UI re-prompts.
 *
 * A wrong passkey is the exception. Dropping it left the user with no
 * session and no idea why, until a later signature failed. It is
 * published instead, so the app root can say so and offer a retry.
 */
export async function openSigningSessionAfterUnlock(): Promise<void> {
  setPasskeyProblem(null);
  try {
    const account = await walletStore.getActiveAccount();
    if (account?.authMethod === "passkey") {
      await walletStore.openPasskeySession();
    }
  } catch (err) {
    if (err instanceof WrongPasskeyError) {
      setPasskeyProblem({
        message: err.message,
        retry: () => void openSigningSessionAfterUnlock(),
      });
    }
  }
}
