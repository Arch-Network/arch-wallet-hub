/**
 * Diagnostics for the onboarding / signing path.
 *
 * Upstream arch-swap colocates a `deriveTaprootAddresses` helper here used
 * only by the lasereyes connect modal to verify pubkey↔address consistency.
 * The wallet popup doesn't need that — accounts are passkey-backed and the
 * Taproot address is derived deterministically from the same pubkey we sign
 * against — so we vendor only the logger used by `onboarding.ts`.
 *
 * Filter the browser console with `[WalletConnect]` to see these messages.
 */

import { createDebugLogger } from "@/lib/utils/debug-logger";

export const walletLogger = createDebugLogger("WalletConnect");
