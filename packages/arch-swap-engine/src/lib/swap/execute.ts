import type { RuntimeTransaction } from "@/lib/arch/types";
import {
  signAndSendTransaction,
  type StatusCallback,
  type TransactionSigner,
} from "@/lib/arch/transaction-runner";
import { waitForConfirmation } from "@/lib/indexer/transactions";
import type { NetworkConfig } from "@/lib/network/config";
import { propAmmBaseUrl } from "@/lib/swap/quote-client";
import type { Quote } from "@/lib/swap/types";

/**
 * Hand a user-signed RFQ transaction to the prop-amm server, which adds the
 * quote signer's signature and submits it. Resolves once it confirms.
 */
export async function submitRfqSwap(
  config: NetworkConfig,
  quoteId: string,
  tx: RuntimeTransaction,
): Promise<string> {
  const res = await fetch(`${propAmmBaseUrl(config)}/rfq/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...tx, quote_id: quoteId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `PropAMM swap failed: HTTP ${res.status}${body ? `: ${body.slice(0, 240)}` : ""}`,
    );
  }
  const { transaction_hash: txid } = (await res.json()) as { transaction_hash: string };
  await waitForConfirmation(txid);
  return txid;
}

/**
 * Sign and submit a quote from `getAggregatedQuote`. CLAMM transactions go
 * straight to the chain; PropAMM transactions go back through `/rfq/swap`.
 */
export async function executeSwapQuote(
  config: NetworkConfig,
  quote: Quote,
  signer: TransactionSigner,
  { label, onStatus }: { label: string; onStatus?: StatusCallback },
): Promise<string> {
  let submit: ((tx: RuntimeTransaction) => Promise<string>) | undefined;
  if (quote.source === "propamm") {
    const quoteId = quote.rfqQuoteId;
    if (!quoteId) throw new Error("PropAMM quote is missing its RFQ id");
    submit = (tx) => submitRfqSwap(config, quoteId, tx);
  }
  return signAndSendTransaction(quote.runtimeTx, signer, {
    label,
    onStatus,
    signaturePlacement: "prepend",
    submit,
  });
}
