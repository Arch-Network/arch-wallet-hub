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
    "5c748cd0eb8a1a4aa5793f744f3ba00b814a7bdbb3ec568cc9cbb985480fbe98",
  clammPoolAddress:
    "5f903ac05d8955be9ecedfa3c7b377b3040be0b25c1715f7ef6d049042c5a202",
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
    programId: "b15585263fa7ccdc99a912e3549be984b939e21ae42ba13cc644fb18b57e2928",
    configPubkey: "c0c1c7809def76810b9ec7758e300276213477e9c8292aac753c4bcf7a83e5bd",
    quoteSignerPubkey: "460b20ee0851ecd95f464c58a730c9d936262fd46ef926de82a319de2ca7bdd1",
    vaults: {
      BTC:  "3346c57b16c98065b8f8bae0cb13e11030d0faa0d6be2fb622a5f72a7d1582d3",
      USDT: "aea079f7d8c7ae9ef32cbd4b3d3b814e37f24919fa68fb3304aa57f08f110451",
    },
  },

  bitcoinNetwork: "mainnet",
  wifPrefix: 0x80,
  taprootAddressField: "mainnet",
  xverseNetworkType: "Mainnet",
  mempoolUrl: "https://mempool.space",

  faucetEnabled: true,
};
