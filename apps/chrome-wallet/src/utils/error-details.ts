/**
 * Text a user can paste into a bug report from an error banner.
 *
 * Built on the device and only ever copied to the clipboard: nothing
 * here is sent anywhere. It carries what a report usually lacks (the
 * build, the screen, who signs) and nothing that identifies the wallet:
 * no addresses, account ids or labels. Log lines come from the
 * `utils/log` ring, which sanitizes them when they are written.
 */
import { walletStore } from "../state/wallet-store";
import { signerInfo } from "../wallets/capabilities";
import { getRecentLogs, type LogEntry } from "./log";
import { APP_VERSION } from "./version";

export interface ErrorDetails {
  message: string;
  version: string;
  time: Date;
  page: string;
  /** Unset when the wallet state could not be read. */
  wallet?: "not set up" | "locked" | { network: string; signer: string };
  userAgent: string;
  logs: LogEntry[];
}

/**
 * The extension page and the screen on it, e.g. `popup.html#/send`.
 * Only the first route segment is kept: later ones and the query name
 * assets, recipients and amounts.
 */
export function pageLabel(location: { pathname: string; hash: string }): string {
  const file = location.pathname.split("/").pop() ?? "";
  const screen = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return screen ? `${file}#/${screen}` : file;
}

export async function collectErrorDetails(message: string): Promise<ErrorDetails> {
  let wallet: ErrorDetails["wallet"];
  try {
    const state = await walletStore.getState();
    if (!state.initialized) wallet = "not set up";
    else if (state.locked) wallet = "locked";
    else {
      const account = state.accounts.find((a) => a.id === state.activeAccountId);
      wallet = {
        network: state.network,
        signer: account ? signerInfo(account).label : "no account",
      };
    }
  } catch {
    // The error on screen may be the storage failing; report without it.
  }
  return {
    message,
    version: APP_VERSION,
    time: new Date(),
    page: pageLabel(window.location),
    wallet,
    userAgent: navigator.userAgent,
    logs: getRecentLogs(),
  };
}

function formatLogEntry(entry: LogEntry): string {
  let extra = "";
  if (entry.extra !== undefined) {
    try {
      extra = ` ${JSON.stringify(entry.extra)}`;
    } catch {
      extra = " [unserializable]";
    }
  }
  return `[${new Date(entry.ts).toISOString()}] ${entry.level.toUpperCase()} ${entry.msg}${extra}`;
}

export function formatErrorDetails(details: ErrorDetails): string {
  const wallet =
    details.wallet === undefined
      ? "unknown"
      : typeof details.wallet === "string"
        ? details.wallet
        : `${details.wallet.network}, ${details.wallet.signer}`;
  const lines = [
    "Arch Wallet error report",
    `Error: ${details.message}`,
    `Version: ${details.version}`,
    `Time: ${details.time.toISOString()}`,
    `Page: ${details.page}`,
    `Wallet: ${wallet}`,
    `Browser: ${details.userAgent}`,
    "",
    details.logs.length === 0 ? "Recent log: (empty)" : `Recent log (${details.logs.length}):`,
    ...details.logs.map(formatLogEntry),
  ];
  return lines.join("\n");
}
