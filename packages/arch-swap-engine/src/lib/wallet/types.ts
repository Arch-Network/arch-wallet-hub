/**
 * Minimal wallet-state types the engine needs for quote pubkey resolution
 * and runtime-tx construction. Mirrors the shape upstream arch-swap exposes
 * via `@/lib/wallet/types`, scoped to just what the engine reads -- the
 * host wallet maintains its own richer wallet model.
 */

export type ConnectionPhase = "idle" | "connecting" | "connected" | "error";

export interface WalletIdentity {
  /** Wallet provider id ("xverse", "unisat", "arch-wallet", etc.). */
  providerId: string;
  /** Human label for UI. */
  providerLabel: string;
}

export interface WalletState {
  /** Hex of the wallet's Schnorr x-only public key (32 bytes / 64 hex chars). */
  pubkeyXCoord: string;
  /** BIP-86 taproot address (`bc1p…` / `tb1p…`). */
  taprootAddress: string;
  identity: WalletIdentity;
}
