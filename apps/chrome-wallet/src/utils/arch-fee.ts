import type { SanitizedMessage } from "@arch-network/arch-sdk";
import bs58 from "bs58";

/**
 * arch-network `tpu/src/lib.rs` `BASE_FEE_PER_SIGNATURE` (checked at
 * a3af73e, 2026-06-19). `tpu/src/processing.rs` `calculate_fee` charges
 * this times `header.num_required_signatures`, and `pay_fees` debits it
 * from `account_keys[0]` before execution, kept even if the tx fails.
 * Compute-budget instructions only set CU limit / heap size; there is no
 * priority fee.
 */
export const ARCH_BASE_FEE_PER_SIGNATURE = 5_000n;

/**
 * arch-network `program/src/rent.rs` `minimum_rent`:
 * `(ACCOUNT_STORAGE_OVERHEAD + data_len) * DEFAULT_LAMPORTS_PER_BYTE_YEAR`
 * with overhead 128 and 2 lamports/byte. `tpu/src/processing.rs`
 * `check_rent` fails the tx unless every account in the message ends
 * with 0 lamports (and no data) or at least this much.
 */
const ACCOUNT_STORAGE_OVERHEAD = 128n;
const DEFAULT_LAMPORTS_PER_BYTE_YEAR = 2n;

export function minimumRent(dataLen: number): bigint {
  return (ACCOUNT_STORAGE_OVERHEAD + BigInt(dataLen)) * DEFAULT_LAMPORTS_PER_BYTE_YEAR;
}

/** Smallest non-zero balance a data-less wallet account may end a tx with (256). */
export const MIN_WALLET_BALANCE_LAMPORTS = minimumRent(0);

/**
 * Deposit the payer funds when the ATA program creates a token account:
 * `associated-token-account/src/tools.rs` `create_pda_account` passes
 * `minimum_rent(apl_token::state::Account::LEN)`, LEN = 165 (586).
 */
export const TOKEN_ACCOUNT_DEPOSIT_LAMPORTS = minimumRent(165);

/** True when `lamports` would fail `check_rent` for a data-less account. */
export function isRentDust(lamports: bigint): boolean {
  return lamports > 0n && lamports < MIN_WALLET_BALANCE_LAMPORTS;
}

export interface ArchFee {
  feeLamports: bigint;
  /** base58 `account_keys[0]`, the account the fee is debited from. */
  feePayer: string;
}

export function archMessageFee(message: SanitizedMessage): ArchFee {
  const payer = message.account_keys[0];
  if (!payer) throw new Error("Arch message has no fee payer");
  return {
    feeLamports: ARCH_BASE_FEE_PER_SIGNATURE * BigInt(message.header.num_required_signatures),
    feePayer: bs58.encode(payer),
  };
}

/** The part of `fee` debited from `archAddress`: 0 if another account pays, null if unknown. */
export function feeChargedTo(fee: ArchFee | null, archAddress: string | undefined): bigint | null {
  if (!fee || !archAddress) return null;
  return fee.feePayer === archAddress ? fee.feeLamports : 0n;
}
