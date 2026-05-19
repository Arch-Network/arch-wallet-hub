// Static CLAMM program constants (network-agnostic).
// Program id comes from `getClammProgramIdBytes(config)`.

export const TICK_ARRAY_SIZE = 88;
export const MAX_TICK_INDEX = 443636;
export const MIN_TICK_INDEX = -443636;

export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673515401279992447579055n;

export const MAX_FEE_RATE = 60000;
export const FEE_RATE_MUL_VALUE = 1_000_000;
export const MAX_PROTOCOL_FEE_RATE = 2500;

export const SLIPPAGE_BPS = 100;
export const PREVIEW_SLIPPAGE_BPS = 100;

export const NUM_REWARDS = 3;

export const WHIRLPOOL_ACCOUNT_SIZE = 653;
export const TICK_ARRAY_ACCOUNT_SIZE = 9988;
export const POSITION_ACCOUNT_SIZE = 216;

export const TICK_SIZE = 113;

export const SYSTEM_PROGRAM_ID = new Uint8Array(32);

export { TOKEN_PROGRAM_ID } from "@/lib/arch/program-ids";

export const RENT_SYSVAR_ID = new Uint8Array([
  6, 167, 213, 23, 25, 44, 86, 142, 224, 138, 132, 95, 115, 210, 151, 136,
  207, 3, 92, 49, 69, 178, 26, 179, 68, 216, 6, 46, 169, 64, 0, 0,
]);
