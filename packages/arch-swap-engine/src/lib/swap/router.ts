import { hexToBytes, bytesToHex } from "@/lib/arch/hex";
import { hexToBase58 } from "@/lib/arch/base58";
import { fetchTokenAccountBalance } from "@/lib/indexer/balances";
import { getToken, type NetworkConfig } from "@/lib/network/config";
import type { AmmMode } from "@/lib/arch/types";
import { quoteSwap } from "@/lib/swap/quote-client";
import {
  QUOTE_ONLY_PUBKEY,
  QUOTE_TTL_MS,
  type Quote,
  type Token,
  type WalletState,
} from "@/lib/swap/types";
import {
  fetchWhirlpoolState,
  fetchVaultBalances,
  getSwapQuote as getClammSwapQuote,
  buildSwapTransaction as buildClammSwapTx,
} from "@/lib/clamm/client";
import { sqrtPriceToPrice } from "@/lib/clamm/math/tick-math";
import { createDebugLogger } from "@/lib/utils/debug-logger";

const logger = createDebugLogger("AMMRouter");

// ── AMM type resolution ────────────────────────────────────────────────────

function getClammPoolAddress(config: NetworkConfig): Uint8Array | null {
  const hex = config.clammPoolAddress;
  if (!hex) return null;
  return hexToBytes(hex);
}

// ── CLAMM quote ────────────────────────────────────────────────────────────

export async function getClammQuote(
  config: NetworkConfig,
  wallet: WalletState | null,
  sellToken: Token,
  buyToken: Token,
  amount: number,
  options?: { btcPrice?: number },
): Promise<Quote> {
  const poolAddress = getClammPoolAddress(config);
  if (!poolAddress) {
    throw new Error(
      "CLAMM pool address not configured (clammPoolAddress in network-config.ts)",
    );
  }

  const userPubkey = hexToBytes(wallet?.pubkeyXCoord ?? QUOTE_ONLY_PUBKEY);
  const aToB = sellToken.symbol === "BTC";

  // Atomic scaling and sqrt-price math both need the active pair's *actual*
  // mint decimals — hardcoding 1e9 here was a holdover from an earlier
  // ArchVM convention and silently broke whenever a token's real on-chain
  // decimals differed (e.g. USDC = 6, BTC = 8 on testnet today).
  const { base: baseSym, quote: quoteSym } = config.tradingPair;
  const decimalsA = getToken(baseSym, config).decimals;
  const decimalsB = getToken(quoteSym, config).decimals;
  const sellDecimals = sellToken.symbol === baseSym ? decimalsA : decimalsB;
  const buyDecimals = sellToken.symbol === baseSym ? decimalsB : decimalsA;
  const scaledAmount = BigInt(Math.round(amount * 10 ** sellDecimals));

  const pool = await fetchWhirlpoolState(poolAddress);
  const slippageBps = 100;

  const swapQuote = await getClammSwapQuote(
    config,
    poolAddress,
    scaledAmount,
    aToB,
    slippageBps,
  );
  const runtimeTx = await buildClammSwapTx(
    config,
    userPubkey,
    poolAddress,
    swapQuote,
    pool,
  );

  const price = sqrtPriceToPrice(pool.sqrtPrice, decimalsA, decimalsB);
  const btcPrice = options?.btcPrice ?? price;

  const buyAmount = Number(swapQuote.estimatedAmountOut) / 10 ** buyDecimals;
  const rate =
    amount > 0
      ? buyAmount / amount
      : sellToken.symbol === "BTC"
      ? btcPrice
      : 1 / btcPrice;
  const feePercent =
    (Number(swapQuote.estimatedFeeAmount) / Number(scaledAmount)) * 100;

  return {
    sellSymbol: sellToken.symbol,
    buySymbol: buyToken.symbol,
    sellAmount: amount,
    buyAmount: Math.max(0, buyAmount),
    rate,
    priceImpactPct: Math.min(feePercent, 5),
    expiresAt: Date.now() + QUOTE_TTL_MS,
    runtimeTx,
    source: "clamm",
  };
}

// ── Fillability checks ─────────────────────────────────────────────────────

async function checkPropAmmFillable(
  config: NetworkConfig,
  quote: Quote,
  sellIsBtc: boolean,
): Promise<boolean> {
  try {
    const runtimeTx = quote.runtimeTx;
    // Find the swap instruction (last instruction typically)
    const ix =
      runtimeTx.message.instructions[runtimeTx.message.instructions.length - 1];
    if (!ix || ix.accounts.length < 8) return false;

    // PropAMM swap ix layout: account[4] = base vault, account[5] = quote vault.
    // Selling base → output is quote → read account[5]; selling quote → output
    // is base → read account[4].
    const outputVaultIndex = sellIsBtc ? 5 : 4;
    const vaultPubkey =
      runtimeTx.message.account_keys[ix.accounts[outputVaultIndex]];
    if (!vaultPubkey) return false;

    const vaultArchAddress = hexToBase58(bytesToHex(new Uint8Array(vaultPubkey)));
    const vaultBalance = await fetchTokenAccountBalance(vaultArchAddress);
    // Null = the indexer can't confirm liquidity; treat as not fillable.
    if (vaultBalance === null) return false;

    // PropAMM uses native token decimals — pick whichever side is the output
    // for this swap direction.
    const { base: baseSym, quote: quoteSym } = config.tradingPair;
    const outputDecimals = sellIsBtc
      ? getToken(quoteSym, config).decimals
      : getToken(baseSym, config).decimals;
    const rawOutputAmount = BigInt(
      Math.round(quote.buyAmount * Math.pow(10, outputDecimals)),
    );
    return vaultBalance >= rawOutputAmount;
  } catch {
    return false;
  }
}

async function checkClammFillable(
  config: NetworkConfig,
  quote: Quote,
  sellIsBtc: boolean,
): Promise<boolean> {
  try {
    const poolAddress = getClammPoolAddress(config);
    if (!poolAddress) return false;

    const pool = await fetchWhirlpoolState(poolAddress);
    const { tokenA, tokenB } = await fetchVaultBalances(pool);

    // Pool token A = `tradingPair.base`, token B = `tradingPair.quote`. Selling
    // base outputs quote → check vault B against quote decimals; selling quote
    // outputs base → check vault A against base decimals.
    const { base: baseSym, quote: quoteSym } = config.tradingPair;
    const outputDecimals = sellIsBtc
      ? getToken(quoteSym, config).decimals
      : getToken(baseSym, config).decimals;
    const rawOutputAmount = BigInt(
      Math.round(quote.buyAmount * Math.pow(10, outputDecimals)),
    );
    const availableBalance = sellIsBtc ? tokenB : tokenA;
    return availableBalance >= rawOutputAmount;
  } catch {
    return false;
  }
}

// ── Aggregator ─────────────────────────────────────────────────────────────

export async function getAggregatedQuote(
  config: NetworkConfig,
  mode: AmmMode,
  wallet: WalletState | null,
  sellToken: Token,
  buyToken: Token,
  amount: number,
  options?: { btcPrice?: number },
): Promise<Quote> {
  const sellIsBtc = sellToken.symbol === "BTC";
  const pubkey = wallet?.pubkeyXCoord ?? QUOTE_ONLY_PUBKEY;

  logger.log("getAggregatedQuote called", {
    mode,
    sellToken: sellToken.symbol,
    buyToken: buyToken.symbol,
    amount,
    walletConnected: !!wallet,
  });

  // Single-AMM modes
  if (mode === "clamm") {
    logger.log("routing to CLAMM only");
    const result = await getClammQuote(
      config,
      wallet,
      sellToken,
      buyToken,
      amount,
      options,
    );
    logger.log("CLAMM quote result", {
      buyAmount: result.buyAmount,
      rate: result.rate,
      source: result.source,
    });
    return result;
  }
  if (mode === "propamm") {
    logger.log("routing to PropAMM only");
    const result = await quoteSwap(
      config,
      pubkey,
      sellToken,
      buyToken,
      amount,
      options,
    );
    logger.log("PropAMM quote result", {
      buyAmount: result.buyAmount,
      rate: result.rate,
      source: result.source,
    });
    return result;
  }

  // Aggregator mode: fetch both in parallel
  logger.log("aggregator mode — fetching both AMMs in parallel");
  const aggStart = performance.now();
  const [propResult, clammResult] = await Promise.allSettled([
    quoteSwap(config, pubkey, sellToken, buyToken, amount, options),
    getClammQuote(config, wallet, sellToken, buyToken, amount, options),
  ]);
  const quoteFetchMs = Math.round(performance.now() - aggStart);

  logger.log("parallel quote fetch complete", {
    quoteFetchMs,
    propAmm: propResult.status === "fulfilled"
      ? { buyAmount: propResult.value.buyAmount, rate: propResult.value.rate }
      : { error: String((propResult as PromiseRejectedResult).reason) },
    clamm: clammResult.status === "fulfilled"
      ? { buyAmount: clammResult.value.buyAmount, rate: clammResult.value.rate }
      : { error: String((clammResult as PromiseRejectedResult).reason) },
  });

  type Candidate = { quote: Quote; fillable: boolean };
  const candidates: Candidate[] = [];

  // Check fillability for each successful quote
  const fillChecks: Promise<void>[] = [];

  if (propResult.status === "fulfilled") {
    const entry: Candidate = { quote: propResult.value, fillable: false };
    candidates.push(entry);
    fillChecks.push(
      checkPropAmmFillable(config, propResult.value, sellIsBtc).then((ok) => {
        entry.fillable = ok;
      }),
    );
  }

  if (clammResult.status === "fulfilled") {
    const entry: Candidate = { quote: clammResult.value, fillable: false };
    candidates.push(entry);
    fillChecks.push(
      checkClammFillable(config, clammResult.value, sellIsBtc).then((ok) => {
        entry.fillable = ok;
      }),
    );
  }

  await Promise.allSettled(fillChecks);

  logger.log("fillability results", {
    candidates: candidates.map((c) => ({
      source: c.quote.source,
      fillable: c.fillable,
      buyAmount: c.quote.buyAmount,
      rate: c.quote.rate,
    })),
  });

  if (candidates.length === 0) {
    logger.error("no AMM quotes available — both failed");
    if (propResult.status === "rejected") throw propResult.reason;
    if (clammResult.status === "rejected") throw clammResult.reason;
    throw new Error("No AMM quotes available");
  }

  // Sort: fillable first, then by buyAmount descending
  candidates.sort((a, b) => {
    if (a.fillable !== b.fillable) return a.fillable ? -1 : 1;
    return b.quote.buyAmount - a.quote.buyAmount;
  });

  const selected = candidates[0];
  logger.log("SELECTED quote", {
    source: selected.quote.source,
    fillable: selected.fillable,
    buyAmount: selected.quote.buyAmount,
    rate: selected.quote.rate,
    totalAggregatorMs: Math.round(performance.now() - aggStart),
  });

  return selected.quote;
}
