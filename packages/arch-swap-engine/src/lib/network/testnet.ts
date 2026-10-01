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
    // Live Autara / CLAMM aBTC (2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW)
    mint: "1d46e0dd87393236e4e01252439f46dcbaec7c2255d1fd734e61771a00e8f4e9",
    mintAuthority: "2a533fae6d2aab9ca336f2bf5f07fc8048f5f4300337852a1d2a816d6ce25bda",
    pythHistorySymbol: "Crypto.BTC/USD",
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    icon: "/usdc.png",
    decimals: 6,
    // Live Autara / CLAMM aUSD (6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp)
    mint: "55c6cee38a31732e2dad821ab1c38f902a7c51efaefb3641d51f3485c4617a45",
    mintAuthority: "d0208cfc6086e663140b134b852d48564c22b57949ae4ceea9245006fd90b804",
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
    "0a0129c4d864d1728c4b6e8f6e0e473197cb111153e379a59b9d93c038efe918",
  clammPoolAddress:
    "06db06761eb1f114167ea2bbc4cf98cf8f98fbfc0ad18d1821e724cfeeb03461",
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
    programId: "63595891819a6b05db69185f6b13510d4287cb75bfb5271a1921bc2591fb3e13",
    configPubkey: "c4a57786a0e5525338fc0cf71d1e3c0a59c415aa97c8c2aa5385f0a4568d2eca",
    quoteSignerPubkey: "dc7d9c01e0d90b25a75917740da2f8da87c1ba63ea0fb40631a3d2bc4ac5f22a",
    vaults: {
      BTC:  "67c6d2aa63f8dc54c4e6c330e57ac762f090c383c14f46643e7f0b55e9665d55",
      USDC: "f28e03b4ce13ba3e066d225edb77f6a71ac21f0f588f1a2f9dc7d3fc091c2dff",
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
