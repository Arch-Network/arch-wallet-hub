export type RangePreset = "narrow" | "medium" | "wide" | "full" | "custom";

export function priceBandForPreset(
  preset: Exclude<RangePreset, "custom">,
  currentPrice: number,
): { lower: number; upper: number } {
  switch (preset) {
    case "narrow":
      return { lower: currentPrice * 0.95, upper: currentPrice * 1.05 };
    case "medium":
      return { lower: currentPrice * 0.8, upper: currentPrice * 1.2 };
    case "wide":
      return { lower: currentPrice * 0.5, upper: currentPrice * 2 };
    case "full":
      return { lower: currentPrice * 0.01, upper: currentPrice * 100 };
  }
}

export function formatFeeTier(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function feeRateBpsFromContract(feeRate: number): number {
  return Math.round(feeRate / 100);
}
