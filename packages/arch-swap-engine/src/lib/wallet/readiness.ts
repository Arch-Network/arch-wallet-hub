/**
 * Composite "is this account ready to swap?" probe.
 *
 * `readFeePayerEligibility` alone is insufficient because it only
 * checks the user's own account (present, system-owned, rent-exempt).
 * A swap also requires every supported-mint ATA to exist so the
 * router can route fees + token movement through them — and the most
 * common partial state in practice is "account exists (created by the
 * wallet's ARCH airdrop) but ATAs don't (never went through
 * arch-swap's onboarding)".
 *
 * This module exposes a single function that resolves both probes in
 * parallel and returns a flat readiness shape the UI can switch on
 * without re-implementing the math.
 *
 * Note: we deliberately do NOT call `ensureOnboarding` to discover
 * what's missing — `ensureOnboarding` is the *mutation* path and
 * builds a faucet-signed account-creation transaction as part of its
 * "needs_signature" return shape, which we don't want as a side effect
 * of a passive probe.
 */

import { PubkeyUtil } from "@saturnbtcio/arch-sdk";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@/lib/arch/program-ids";
import { hexToBytes } from "@/lib/arch/hex";
import { fetchAccountInfo } from "@/lib/indexer/accounts";
import {
  getToken,
  getTokenSymbols,
  type NetworkConfig,
  type TokenSymbol,
} from "@/lib/network/config";

import {
  readFeePayerEligibility,
  type FeePayerEligibility,
} from "@/lib/arch/account-eligibility";

export interface SwapAccountReadiness {
  /** Underlying fee-payer eligibility result (account-level only). */
  eligibility: FeePayerEligibility;
  /** Mints whose ATA does not yet exist for this user. */
  missingAtas: TokenSymbol[];
  /**
   * Convenience: `true` when the account is eligible AND every
   * supported mint has an ATA. The UI maps this to "ready to swap".
   */
  isReady: boolean;
  /**
   * Convenience inverse used by the UI to render the Initialize
   * affordance. `true` whenever any structural step is missing
   * (account, ATAs, or both).
   */
  needsSetup: boolean;
}

/**
 * Resolve readiness in a single round-trip's worth of parallelism.
 *
 * Fetches the account info + one ATA fetch per supported mint. On the
 * default testnet config that's ~4 reads; well within the indexer's
 * budget and runs in <500ms typically.
 *
 * Failures fall open: a thrown indexer error on the ATA probe is
 * interpreted as "missing" so the user sees the Initialize affordance
 * (the alternative — silently allowing a "ready" state on a probe
 * failure — would lead them straight into a confusing faucet rejection).
 */
export async function probeSwapAccountReadiness(
  config: NetworkConfig,
  pubkeyHex: string,
): Promise<SwapAccountReadiness> {
  const pubkeyBytes = hexToBytes(pubkeyHex);

  const symbols = getTokenSymbols(config);
  const ataAddresses = symbols.map((symbol) => {
    const mint = hexToBytes(getToken(symbol, config).mint);
    const ata = PubkeyUtil.getAssociatedTokenAddress(
      mint,
      pubkeyBytes,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    return { symbol, ata };
  });

  const [eligibility, ataResults] = await Promise.all([
    readFeePayerEligibility(pubkeyBytes),
    Promise.all(
      ataAddresses.map(({ symbol, ata }) =>
        fetchAccountInfo(ata)
          .then((info) => ({ symbol, exists: info !== null }))
          // Fall open on indexer errors so the UI nudges the user to
          // re-initialize rather than silently treating the ATA as present.
          .catch(() => ({ symbol, exists: false })),
      ),
    ),
  ]);

  const missingAtas = ataResults
    .filter((r) => !r.exists)
    .map((r) => r.symbol);

  const isReady = eligibility.eligible && missingAtas.length === 0;

  return {
    eligibility,
    missingAtas,
    isReady,
    needsSetup: !isReady,
  };
}
