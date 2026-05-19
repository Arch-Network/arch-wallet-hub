import type { TokenSymbol } from "@/lib/arch/types";
import type { Token } from "@/lib/swap/types";

export { QUOTE_ONLY_PUBKEY, QUOTE_TTL_MS } from "@/lib/swap/types";

export const TOKENS: Record<TokenSymbol, Token> = {
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    decimals: 8,
    color: "#ec641d",
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    color: "#2775CA",
  },
  USDT: {
    symbol: "USDT",
    name: "Tether",
    decimals: 9,
    color: "#26A17B",
  },
};

export const PRICE_IMPACT_FACTOR = 1e-4;
export const MAX_PRICE_IMPACT_WARN = 5;
