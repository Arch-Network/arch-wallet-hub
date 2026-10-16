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
    mint: "5b29d2ff08829791698237a6d056ec9fab29187072819b7bf7a43e431f027f18",
    mintAuthority: "1d80ef4da77f450b989f85e084cc53e98de065deaabc7cd210166b1a068e0650",
    pythHistorySymbol: "Crypto.BTC/USD",
  },
  USDT: {
    symbol: "USDT",
    name: "Arch USD",
    icon: "",
    decimals: 6,
    mint: "b8586267326264db356ca4c92b61dee74b4510cb95488897191d18520b3b18a4",
    mintAuthority: "00549845429d160aaad99fb42e5ac97c662bd174d554f8dee6e0cd03fc564318",
    pythHistorySymbol: "Crypto.USDT/USD",
  },
};

export const MAINNET_CONFIG: NetworkConfig = {
  archRpcUrl: "https://rpc.mainnet.arch.network",
  tokens: MAINNET_TOKENS,
  tradingPair: { base: "BTC", quote: "USDT" },
  clammProgramId:
    "948fc4f4794c9fff7d249114f90176178c483f219b9f42a5d42ab3eb21d23b05",
  clammPoolAddress:
    "98562c44288c3f2e4f5ee0fb8db34070907f79b1c42a86e1223dafa6e6cad58d",
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
  // No RFQ server is deployed for the mainnet-v2 prop-amm program yet; empty
  // makes PropAMM quoting fail so the aggregator routes to CLAMM.
  propAmmUpstreamUrl: "",
  propAmm: {
    programId: "4022dec7e57f757682712b45ddf13a8f324710f4637cefc0ebacc6343caab24c",
    configPubkey: "45c0e785edb21a9a064146a891a44c4b37594e481a61d1cc586bf8edcbc5144e",
    quoteSignerPubkey: "a4e7f563813ce2d93ca73740333ac2a742d58101f7a0a482f467c05324fcc5a6",
    vaults: {
      BTC:  "28c4296bfecbd76f1c22fc46e68a541fb3e7c867e6351553202e849b08a3fc11",
      USDT: "a74685b0df892001a8cfb05e50cedcadf3c6f3c71c93606161209b0720c7e183",
    },
  },

  bitcoinNetwork: "mainnet",
  wifPrefix: 0x80,
  taprootAddressField: "mainnet",
  xverseNetworkType: "Mainnet",
  mempoolUrl: "https://mempool.space",

  faucetEnabled: false,
};
