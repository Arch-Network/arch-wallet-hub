// Mainnet deployment configuration. Data only — no runtime logic.
//
// Curator pubkeys, lending program ID, and oracle metadata are still
// placeholders pending mainnet deploy; the `TODO_*` strings get
// substituted at module-init time by `network-config.ts`.

import { TESTNET_CURATORS } from "@/lib/network/testnet";
import type {
  NetworkConfig,
  TokenInfo,
  TokenSymbol,
} from "@/lib/network/types";

const MAINNET_TOKENS: Partial<Record<TokenSymbol, TokenInfo>> = {
  BTC: {
    symbol: "BTC",
    name: "Arch Bitcoin",
    icon: "/btc.png",
    decimals: 8,
    mint: "225b03d6f9e05fd834cd18906b019fb46372544b0eeb9f6f8b615472467d46b0",
    mintAuthority: "36ba400747066a8fd2dfa87c152037347532b3405a0f6d7f2fa32bdf7d7845e0",
    pythHistorySymbol: "Crypto.BTC/USD",
  },
  USDT: {
    symbol: "USDT",
    name: "Arch USD",
    icon: "",
    decimals: 6,
    mint: "aec8ca1598d74bc27721536f1a88b5648740bc6a856546a0a47817ff7fe7437c",
    mintAuthority: "30cb47b0c98099ffd5f6d3011924cdff232169f6dcebf28d10ca57f473a4aec4",
    pythHistorySymbol: "Crypto.USDT/USD",
  },
};

export const MAINNET_CONFIG: NetworkConfig = {
  archRpcUrl: "https://rpc.mainnet.arch.network",
  tokens: MAINNET_TOKENS,
  tradingPair: { base: "BTC", quote: "USDT" },
  clammProgramId:
    "96feb7352aa992398e76a99d8e1801057eac114ee8458d3668847287353bcfb7",
  clammPoolAddress:
    "7caf3541b5d2d9bf06453480acbed988c1c9ebe9ff0edf6deb2f17e0e2e9cb32",
  lendingProgramId: "TODO_MAINNET_LENDING_PROGRAM_ID",
  oracleProgramId: "TODO_MAINNET_ORACLE_PROGRAM_ID",
  oracleSignerPubkey: "TODO_MAINNET_ORACLE_SIGNER",
  curators: {
    core: {
      pubkey: "TODO_MAINNET_CURATOR_CORE",
      name: "Arch Core",
      description: TESTNET_CURATORS.core.description,
    },
    prime: {
      pubkey: "TODO_MAINNET_CURATOR_PRIME",
      name: "Arch Prime",
      description: TESTNET_CURATORS.prime.description,
    },
  },
  lendingMarkets: [],

  indexerApiBaseUrl: "https://explorer.arch.network/api/v1/mainnet",
  propAmmUpstreamUrl: "http://64.34.82.201:3001",
  propAmm: {
    programId: "d31a682e813c641f40fefe1c906c052063fcff6d628556e01344fd4660636aec",
    configPubkey: "f1651efa9f9ecbd6cda417854e2acd976fd0469268dff3a07c39e07e643bf3a3",
    quoteSignerPubkey: "8094dceb67a73510db62b9d519fff4ed59a7493695dc3458a6204c0b7ec33e97",
    vaults: {
      BTC:  "9de22416e3343655461f0da1c3a9b6eff3853882337d608ee106967fc9cfb7bf",
      USDT: "f061a743352bfd12a3351b1b787d79456c9876c4e61cb04df16b5e18a9302b37",
    },
  },

  bitcoinNetwork: "mainnet",
  wifPrefix: 0x80,
  taprootAddressField: "mainnet",
  xverseNetworkType: "Mainnet",
  mempoolUrl: "https://mempool.space",

  faucetEnabled: true,
};
