// Type definitions for the per-network configuration. Pure declarations —
// no runtime, no environment access.

import type { NetworkId } from "@/engine-config";

export type { NetworkId };

export type TokenSymbol = "BTC" | "USDC" | "USDT";

export type TokenInfo = {
  symbol: TokenSymbol;
  name: string;
  icon: string;
  /** Native on-chain decimals declared on the token mint. Used for both
   * display formatting and atomic-amount scaling on the wire. */
  decimals: number;
  /** Hex-encoded mint pubkey (64 chars). */
  mint: string;
  /**
   * X-only pubkey of the mint authority (32 bytes / 64 hex chars). The
   * matching private key is server-only and read from
   * `MINT_AUTHORITY_PRIVATE_KEY_<NETWORK>_<SYMBOL>` (see
   * `lib/arch/mint-authority.ts`).
   */
  mintAuthority: string;
  /** Pyth TradingView-compatible symbol used by benchmarks.pyth.network for
   * historical price queries (e.g. "Crypto.BTC/USD"). Optional so long-tail
   * tokens without a Pyth feed cleanly fall back to mock chart data. */
  pythHistorySymbol?: string;
};

/** Stable identifier for a curator. Used as the static-config key into
 *  `NetworkConfig.curators` and stamped onto each `LendingMarket`. */
export type CuratorKey = "core" | "prime";

export type Curator = {
  /** X-only pubkey of the curator account on Arch. */
  pubkey: string;
  /** Short human label (e.g. "Conservative"). Renders in market cards. */
  name: string;
  /** One-sentence positioning line — surfaced in tooltips/about cards. */
  description: string;
};

export type LendingMarket = {
  /** Token used as supply (lent) side. */
  supply: TokenSymbol;
  /** Token used as collateral side. */
  collateral: TokenSymbol;
  /** Hex-encoded market account pubkey (64 chars). */
  address: string;
  /** Human-friendly market name (e.g. "BTC-USDC Conservative"). */
  displayName: string;
  /** Curator key — index into `NetworkConfig.curators`. */
  curator: CuratorKey;
  /**
   * Maximum LTV in percent, as advertised by the curator at deploy time.
   * The on-chain `MarketState.ltvConfig.maxLtv` is authoritative for risk
   * checks; this field is purely for static labeling.
   */
  maxLtvPct: number;
};

/**
 * Operator-controlled PropAMM deployment addresses. The frontend talks to the
 * AMM through the `/api/propamm` proxy, so these are not used to build
 * transactions client-side — they live here so `/config` can surface them for
 * runbook verification after a redeploy. Update in lockstep with the deployed
 * backend.
 */
export type PropAmmDeployment = {
  programId: string;
  configPubkey: string;
  quoteSignerPubkey: string;
  /** Vault account per token symbol. Only populated for the symbols actually
   *  traded on this network — see `tradingPair`. */
  vaults: Partial<Record<TokenSymbol, string>>;
};

export type NetworkConfig = {
  // Arch Network
  archRpcUrl: string;
  /**
   * Tokens live on this network. Each network ships a distinct subset
   * (e.g. testnet has tBTC + tUSDC; mainnet has tBTC + tUSDT) so this is a
   * partial map keyed by `TokenSymbol`. Use `getToken()` for safe access.
   */
  tokens: Partial<Record<TokenSymbol, TokenInfo>>;
  /**
   * Single AMM trading pair on this network. Both PropAMM and CLAMM trade
   * this pair; UI surfaces that need "the pair" should read from here
   * instead of hardcoding symbols.
   */
  tradingPair: { base: TokenSymbol; quote: TokenSymbol };
  clammProgramId: string;
  clammPoolAddress: string;
  lendingProgramId: string;
  /**
   * Pyth-style oracle program id used by the lending program. Surfaced in
   * `/config` so ops can verify the deployment matches the backend.
   */
  oracleProgramId: string;
  /** Backend-side signer that publishes oracle prices. Documentation only. */
  oracleSignerPubkey: string;
  /** Curator registry, keyed by `CuratorKey`. */
  curators: Record<CuratorKey, Curator>;
  lendingMarkets: LendingMarket[];

  // Indexer
  indexerApiBaseUrl: string;

  // PropAMM upstream
  propAmmUpstreamUrl: string;
  propAmm: PropAmmDeployment;

  // Bitcoin network
  /**
   * LaserEyes / wallet bitcoin network identifier. We run against Testnet4
   * (not legacy Testnet3) on the testnet deployment, so this can be
   * `"testnet4"` — wallets like Xverse treat the two as distinct networks
   * and reject signatures produced under the wrong one.
   */
  bitcoinNetwork: "mainnet" | "testnet" | "testnet4";
  /** WIF private key prefix: 0x80 = mainnet, 0xef = testnet/testnet4 */
  wifPrefix: number;
  /** Which address field to read from bip322-js Address objects. Testnet4
   *  uses the same `tb1…` taproot encoding as Testnet3, so this is just
   *  `"mainnet" | "testnet"`. */
  taprootAddressField: "mainnet" | "testnet";
  /** Xverse signMessage network type */
  xverseNetworkType: "Mainnet" | "Testnet" | "Testnet4";
  /** Mempool.space base URL */
  mempoolUrl: string;

  // Features
  faucetEnabled: boolean;
};
