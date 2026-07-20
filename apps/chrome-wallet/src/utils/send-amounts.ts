const SATS_PER_BTC = 100_000_000;

function trimDecimalZeros(value: string): string {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * Convert a fiat amount to a BTC input rounded to whole satoshis.
 * The wallet still submits BTC; USD is only an input convenience.
 */
export function usdInputToBtc(input: string, btcUsd: number | null): string {
  if (!input.trim() || btcUsd === null || !Number.isFinite(btcUsd) || btcUsd <= 0) {
    return "";
  }
  const usd = Number(input);
  if (!Number.isFinite(usd) || usd < 0) return "";
  const sats = Math.round((usd / btcUsd) * SATS_PER_BTC);
  return trimDecimalZeros((sats / SATS_PER_BTC).toFixed(8));
}

/** Convert a BTC input to a plain numeric USD input value. */
export function btcInputToUsd(input: string, btcUsd: number | null): string {
  if (!input.trim() || btcUsd === null || !Number.isFinite(btcUsd) || btcUsd <= 0) {
    return "";
  }
  const btc = Number(input);
  if (!Number.isFinite(btc) || btc < 0) return "";
  const usd = btc * btcUsd;
  return usd.toFixed(usd > 0 && usd < 1 ? 4 : 2);
}

/**
 * Format an atomic token balance as an exact, input-safe decimal.
 * Unlike locale display strings, the result never contains commas.
 */
export function rawTokenAmountToInput(rawAmount: string, decimals: number): string {
  const normalized = rawAmount.trim();
  if (!/^\d+$/.test(normalized)) return "";

  const digits = BigInt(normalized).toString();
  if (decimals <= 0) return digits;

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
