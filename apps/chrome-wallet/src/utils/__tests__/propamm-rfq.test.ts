import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAINNET_CONFIG,
  TESTNET_CONFIG,
  executeSwapQuote,
  quoteFromRfqResponse,
  quotePropAmmSwap,
  submitRfqSwap,
  type Quote,
  type RfqQuoteResponse,
  type Token,
} from "@arch/swap-engine";

const BTC: Token = { symbol: "BTC", name: "Bitcoin", decimals: 8, color: "" };
const USDC: Token = { symbol: "USDC", name: "USD Coin", decimals: 6, color: "" };

const message = {
  signers: [],
  header: { num_required_signatures: 1, num_readonly_signed_accounts: 0, num_readonly_unsigned_accounts: 0 },
  account_keys: [],
  recent_blockhash: [],
  instructions: [],
} as unknown as RfqQuoteResponse["message"];

function rfqResponse(base_amount: number, quote_amount: number): RfqQuoteResponse {
  return {
    quote_id: "abc123",
    version: 0,
    signatures: [],
    message,
    estimated_quote: { base_amount, quote_amount },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quoteFromRfqResponse", () => {
  it("reads the quote side as output when selling the base token", () => {
    const quote = quoteFromRfqResponse(TESTNET_CONFIG, rfqResponse(10_000, 8_207_007), BTC, USDC, 0.0001);
    expect(quote.buyAmount).toBeCloseTo(8.207007, 6);
    expect(quote.rate).toBeCloseTo(82_070.07, 2);
    expect(quote.source).toBe("propamm");
    expect(quote.rfqQuoteId).toBe("abc123");
    expect(quote.runtimeTx).toEqual({ version: 0, signatures: [], message });
  });

  it("reads the base side as output when buying the base token", () => {
    const quote = quoteFromRfqResponse(TESTNET_CONFIG, rfqResponse(6_093, 5_000_000), USDC, BTC, 5);
    expect(quote.buyAmount).toBeCloseTo(0.00006093, 8);
  });
});

describe("PropAMM availability", () => {
  it("refuses to quote on a network without an RFQ server", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(quotePropAmmSwap(MAINNET_CONFIG, "00".repeat(32), BTC, USDC, 0.001)).rejects.toThrow(
      "PropAMM is not available on this network",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("submitRfqSwap", () => {
  it("posts the flattened transaction with quote_id to /rfq/swap and surfaces server errors", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"error":"bad sig","code":"rfq_invalid_user_signature"}', { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const tx = { version: 0, signatures: [[1, 2, 3]], message };

    await expect(submitRfqSwap(TESTNET_CONFIG, "abc123", tx)).rejects.toThrow(
      "PropAMM swap failed: HTTP 400",
    );
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${TESTNET_CONFIG.propAmmUpstreamUrl}/rfq/swap`);
    expect(JSON.parse(init.body)).toEqual({ ...tx, quote_id: "abc123" });
  });
});

describe("executeSwapQuote", () => {
  it("rejects a PropAMM quote without an RFQ id before asking for a signature", async () => {
    const signer = vi.fn();
    const quote = {
      ...quoteFromRfqResponse(TESTNET_CONFIG, rfqResponse(10_000, 8_000_000), BTC, USDC, 0.0001),
      rfqQuoteId: undefined,
    } satisfies Quote;
    await expect(executeSwapQuote(TESTNET_CONFIG, quote, signer, { label: "Swap" })).rejects.toThrow(
      "PropAMM quote is missing its RFQ id",
    );
    expect(signer).not.toHaveBeenCalled();
  });
});
