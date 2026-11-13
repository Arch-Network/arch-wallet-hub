/**
 * Sending an error report to the Wallet Hub. Only ever called from the
 * "Send report" confirmation in `components/ErrorReportActions`:
 * nothing sends a report on its own.
 *
 * The Hub does not store the report; it writes it to its log, which the
 * Hub's operators read (services/wallet-hub-api/src/routes/errorReports.ts).
 */
import { DEFAULT_HUB_BASE_URL } from "../state/types";
import { walletStore } from "../state/wallet-store";
import { collectErrorDetails, formatErrorDetailsToFit } from "./error-details";
import { getClient } from "./sdk";

/**
 * Largest report the Hub accepts, as the UTF-8 bytes of its JSON string
 * encoding. Mirrors REPORT_MAX_ENCODED_BYTES in the Hub's
 * routes/errorReports.ts; keep the two in sync.
 */
export const ERROR_REPORT_MAX_ENCODED_BYTES = 12_000;

/** The host a report would go to: the Hub this wallet is configured to use. */
export async function errorReportHost(): Promise<string> {
  const state = await walletStore.getState();
  return new URL(state.hubBaseUrl || DEFAULT_HUB_BASE_URL).host;
}

/** Send the report for `message`. Resolves to the id the Hub logged it under. */
export async function sendErrorReport(message: string, requestId?: string): Promise<string> {
  const details = await collectErrorDetails(message, requestId);
  const report = formatErrorDetailsToFit(details, ERROR_REPORT_MAX_ENCODED_BYTES);
  const client = await getClient();
  return (await client.submitErrorReport({ report })).id;
}
