// Canonical Arch program IDs, matching @saturnbtcio/arch-sdk v0.0.24.
// These are Arch program addresses, not Solana SPL program addresses.
export const TOKEN_PROGRAM_ID = new TextEncoder().encode(
  "apl-token00000000000000000000000",
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new TextEncoder().encode(
  "associated-token-account00000000",
);

export const SYSTEM_PROGRAM_ID = new Uint8Array(32);
SYSTEM_PROGRAM_ID[31] = 1;
