import type { RuntimeTransaction } from "@/lib/arch/types";
import { createDebugLogger } from "@/lib/utils/debug-logger";
import { getToken, type NetworkConfig } from "@/lib/network/config";
import { getBtcUsdPrice } from "@/lib/wallet/btc-price";
import { getEngineConfig } from "@/engine-config";
import {
  MAX_PRICE_IMPACT_WARN,
  PRICE_IMPACT_FACTOR,
  QUOTE_TTL_MS,
} from "@/lib/swap/constants";
import type { Quote, Token } from "@/lib/swap/types";

const quoteLogger = createDebugLogger("QuoteSwap");

async function fetchPropAmmQuote(
  config: NetworkConfig,
  side: "sell" | "buy",
  amount: number,
  userPubkey: string,
): Promise<RuntimeTransaction> {
  const { base, quote } = config.tradingPair;
  const propAmmQuoteUrl = getEngineConfig().transport.propAmmQuoteUrl;
  const res = await fetch(propAmmQuoteUrl, {
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

function parsePropAmmQuoteAmounts(
  config: NetworkConfig,
  runtimeTx: RuntimeTransaction,
  sellIsBtc: boolean,
): { amountIn: number; amountOut: number } | null {
  const ix = runtimeTx.message.instructions[0];
  if (!ix || ix.data.length < 82) return null;

  function readU64LE(arr: number[], off: number): number {
    let v = 0;
    for (let i = 7; i >= 0; i -= 1) v = v * 256 + arr[off + i];
    return v;
  }

  const baseAmount = readU64LE(ix.data, 66);
  const quoteAmount = readU64LE(ix.data, 74);

  const { base, quote } = config.tradingPair;
  const baseScale = Math.pow(10, getToken(base, config).decimals);
  const quoteScale = Math.pow(10, getToken(quote, config).decimals);

  if (sellIsBtc) {
    return { amountIn: baseAmount / baseScale, amountOut: quoteAmount / quoteScale };
  }
  return { amountIn: quoteAmount / quoteScale, amountOut: baseAmount / baseScale };
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
  options?: { btcPrice?: number },
): Promise<Quote> {
  const side = sellToken.symbol === "BTC" ? "sell" : "buy";
  const scaledAmount = Math.round(amount * Math.pow(10, sellToken.decimals));
  const runtimeTx = await fetchPropAmmQuote(
    config,
    side,
    scaledAmount,
    pubkeyXCoord,
  );
  const parsed = parsePropAmmQuoteAmounts(
    config,
    runtimeTx,
    sellToken.symbol === "BTC",
  );

  let buyAmount: number;
  let rate: number;

  if (parsed && parsed.amountIn > 0) {
    buyAmount = parsed.amountOut;
    rate = amount > 0 ? buyAmount / amount : 0;
  } else {
    let btcPrice = options?.btcPrice ?? 95_000;
    if (!options?.btcPrice) {
      try {
        btcPrice = await getBtcUsdPrice(config);
      } catch {
        quoteLogger.warn("Failed BTC price fetch; using fallback");
      }
    }
    buyAmount = sellToken.symbol === "BTC" ? amount * btcPrice : amount / btcPrice;
    rate = amount > 0 ? buyAmount / amount : (sellToken.symbol === "BTC" ? btcPrice : 1 / btcPrice);
  }

  return {
    sellSymbol: sellToken.symbol,
    buySymbol: buyToken.symbol,
    sellAmount: amount,
    buyAmount: Math.max(0, buyAmount),
    rate,
    priceImpactPct: Math.min(amount * PRICE_IMPACT_FACTOR, MAX_PRICE_IMPACT_WARN),
    expiresAt: Date.now() + QUOTE_TTL_MS,
    runtimeTx,
    source: "propamm",
  };
}
