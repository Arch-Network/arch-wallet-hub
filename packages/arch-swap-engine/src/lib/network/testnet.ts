// Testnet deployment configuration. Data only — no runtime logic.

import type {
  Curator,
  CuratorKey,
  NetworkConfig,
  TokenInfo,
  TokenSymbol,
} from "@/lib/network/types";

const TESTNET_TOKENS: Partial<Record<TokenSymbol, TokenInfo>> = {
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    icon: "/btc.png",
    decimals: 8,
    // Live CLAMM aBTC (BsScw2NUzyPjZpWyPqHqvQpvNLspYUkZryi8YSvoxtc5)
    mint: "a180e0b6a44745fdf44537e8c76836301122b719a19dfa4d21f7169f234f9276",
    mintAuthority: "08fc8d9068228fe8b9848b139dcdd61ae7ff78cc14d57dcbca7faba110da7a00",
    pythHistorySymbol: "Crypto.BTC/USD",
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    icon: "/usdc.png",
    decimals: 6,
    // Live CLAMM aUSD (J6Kc9nCCAqfLeQPmm6TAXQ8mNNSt2qk8EwwZ2kLJC76i)
    mint: "fdf39ea6a422926dbb7b133b0d98669197f171bc3fda7dedf867578ee1ecec0b",
    mintAuthority: "71bfa4d241940888cacc2851219f4458425a755288ceb7b4f6e38fc2c1f2cbcd",
    pythHistorySymbol: "Crypto.USDC/USD",
  },
};

export const TESTNET_CURATORS: Record<CuratorKey, Curator> = {
  core: {
    pubkey: "6809622804688d2e5630f83da500379f60592d8e77bf402f752c79a26032a617",
    name: "Arch Core",
    description:
      "Tighter LTV ceilings and stricter liquidation buffers — sized for capital preservation.",
  },
  prime: {
    pubkey: "43ef98a4e41f801e3421e5f5f79622c97ff0205d3d21b155c1390a107e47d19a",
    name: "Arch Prime",
    description:
      "Moderate LTVs that lean into capital efficiency while keeping margin for volatility.",
  },
};

export const TESTNET_CONFIG: NetworkConfig = {
  archRpcUrl: "https://rpc.testnet.arch.network",
  tokens: TESTNET_TOKENS,
  tradingPair: { base: "BTC", quote: "USDC" },
  clammProgramId:
    "9f516db987d50ed44bb440a4687df74779d9ec5c42c404974262b788f7d5cccc",
  clammPoolAddress:
    "40714362135db22393900842d545aedc0d352b7099ec89418140c42bdfafb9d6",
  lendingProgramId:
    "53def2dc8516302842b10e356914d2a5f6b33425ba42aec684f706aa1cf64192",
  oracleProgramId:
    "eee682c27db375bebbc17ed9a76aaa935c8b72bc7de50d736f03e2dfbed84b15",
  oracleSignerPubkey:
    "b5eb801401791f83345cf81bf8d4c04daf34fa203e715467dc73a6995e2d21de",
  curators: TESTNET_CURATORS,
  lendingMarkets: [
    // Conservative — BTC ↔ USDC, 80% LTV.
    {
      supply: "USDC", collateral: "BTC",
      address: "30272668a9327f79a559343879c40d802249a3494153cae6660b273121ad54b3",
      displayName: "BTC-USDC Conservative",
      curator: "core", maxLtvPct: 80,
    },
    {
      supply: "BTC", collateral: "USDC",
      address: "fb6bb2d6de9c23053c655949653b3e2786dc769901c376b55ef75b904ee88f7e",
      displayName: "BTC-USDC Conservative",
      curator: "core", maxLtvPct: 80,
    },
    // Balanced — BTC ↔ USDC, 86% LTV.
    {
      supply: "USDC", collateral: "BTC",
      address: "e5420175199b803a1dd85df0fc1722095d44241da679cbd58a47d2759ec2b24d",
      displayName: "BTC-USDC Balanced",
      curator: "prime", maxLtvPct: 86,
    },
    {
      supply: "BTC", collateral: "USDC",
      address: "f829fef6498ce2e76cfcc15736c24bb1615233d2ad6d8c606be9fc20a834ed6e",
      displayName: "BTC-USDC Balanced",
      curator: "prime", maxLtvPct: 86,
    },
  ],

  indexerApiBaseUrl: "https://explorer.arch.network/api/v1/testnet",
  propAmmUpstreamUrl: "http://64.34.82.201:3000",
  propAmm: {
    programId: "7a68831501d3a9806feff162e82815a36e1732964a2edd2b461faf69575c3628",
    configPubkey: "60dcc900483420626bf2194b10ad963eade440993fae3afc911e44f0ff6c2269",
    quoteSignerPubkey: "dc051dab62c61634c2fe962e633b09a86127c988ca65911f47ce9d407de1445f",
    vaults: {
      BTC:  "8970e70a31be695e87ddfa421178fb3d1ab3662398f68d2ed16d371eda9621f7",
      USDC: "26fc3bbcee019feb656887390951b483c094de519f92f62af325d6183e33c5d3",
    },
  },

  bitcoinNetwork: "testnet4",
  wifPrefix: 0xef,
  taprootAddressField: "testnet",
  // Xverse signMessage historically interprets `"Testnet"` as "whichever
  // testnet the wallet is on" — older builds reject `"Testnet4"` outright
  // and silently fall back to mainnet sighash (which Arch's testnet
  // verifier then rejects as Invalid signature). `"Testnet"` is the
  // safe value across Xverse versions.
  xverseNetworkType: "Testnet",
  mempoolUrl: "https://mempool.space/testnet4",

  faucetEnabled: true,
};
