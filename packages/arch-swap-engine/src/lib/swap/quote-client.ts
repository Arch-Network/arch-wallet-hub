import type { RuntimeTransaction } from "@/lib/arch/types";
import { getToken, type NetworkConfig } from "@/lib/network/config";
import {
  MAX_PRICE_IMPACT_WARN,
  PRICE_IMPACT_FACTOR,
  QUOTE_TTL_MS,
} from "@/lib/swap/constants";
import type { Quote, Token } from "@/lib/swap/types";

/**
 * `POST /rfq/quote` response from the prop-amm server. The transaction is
 * flattened into the top level and arrives with no signatures: the user signs
 * it and hands it back to `/rfq/swap` with `quote_id`, and the server adds
 * the quote signer's signature before submitting.
 */
export type RfqQuoteResponse = RuntimeTransaction & {
  quote_id: string;
  estimated_quote: { base_amount: number; quote_amount: number };
};

export function propAmmBaseUrl(config: NetworkConfig): string {
  const url = config.propAmmUpstreamUrl.replace(/\/+$/, "");
  if (!url) throw new Error("PropAMM is not available on this network");
  return url;
}

async function fetchPropAmmQuote(
  config: NetworkConfig,
  side: "sell" | "buy",
  amount: number,
  userPubkey: string,
): Promise<RfqQuoteResponse> {
  const { base, quote } = config.tradingPair;
  const res = await fetch(`${propAmmBaseUrl(config)}/rfq/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_mint: getToken(base, config).mint,
      quote_mint: getToken(quote, config).mint,
      side,
      amount,
      user_pubkey: userPubkey,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `PropAMM quote failed: HTTP ${res.status}${body ? `: ${body.slice(0, 240)}` : ""}`,
    );
  }
  return res.json();
}

/**
 * Turn an RFQ response into the canonical `Quote`. Amounts come from the
 * server's `estimated_quote` in base units of each side of the pair.
 */
export function quoteFromRfqResponse(
  config: NetworkConfig,
  response: RfqQuoteResponse,
  sellToken: Token,
  buyToken: Token,
  amount: number,
): Quote {
  const { base, quote } = config.tradingPair;
  const baseAmount = response.estimated_quote.base_amount / 10 ** getToken(base, config).decimals;
  const quoteAmount = response.estimated_quote.quote_amount / 10 ** getToken(quote, config).decimals;
  const buyAmount = sellToken.symbol === base ? quoteAmount : baseAmount;

  return {
    sellSymbol: sellToken.symbol,
    buySymbol: buyToken.symbol,
    sellAmount: amount,
    buyAmount: Math.max(0, buyAmount),
    rate: amount > 0 ? buyAmount / amount : 0,
    priceImpactPct: Math.min(amount * PRICE_IMPACT_FACTOR, MAX_PRICE_IMPACT_WARN),
    expiresAt: Date.now() + QUOTE_TTL_MS,
    runtimeTx: {
      version: response.version,
      signatures: response.signatures,
      message: response.message,
    },
    source: "propamm",
    rfqQuoteId: response.quote_id,
  };
}

/**
 * Quote a PropAMM swap. Returns the canonical `Quote` shape consumed by the
 * UI — `runtimeTx` and `source` baked in, `expiresAt` as a unix-ms number.
 */
export async function quoteSwap(
  config: NetworkConfig,
  pubkeyXCoord: string,
  sellToken: Token,
  buyToken: Token,
  amount: number,
): Promise<Quote> {
  const side = sellToken.symbol === config.tradingPair.base ? "sell" : "buy";
  const scaledAmount = Math.round(amount * Math.pow(10, sellToken.decimals));
  const response = await fetchPropAmmQuote(config, side, scaledAmount, pubkeyXCoord);
  return quoteFromRfqResponse(config, response, sellToken, buyToken, amount);
}
