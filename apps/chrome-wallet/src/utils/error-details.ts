/**
 * The text of an error report: what a user copies from an error banner,
 * or sends to the Wallet Hub's operators with "Send report"
 * (`error-report.ts`). Built on the device, and it leaves the device
 * only by one of those two actions.
 *
 * It carries what a report usually lacks (the build, the screen, who
 * signs, the Hub's id for the failed request) and is built to leave out
 * what identifies the wallet: no account label, ids in a log line are
 * dropped by their key (`withoutIds`), and addresses, txids and emails
 * in an error message or a log line are masked by their shape
 * (`maskIdentifiers`). Both go by pattern, so neither is a guarantee.
 * Log lines come from the `utils/log` rings of this page and of the
 * background, which also sanitize them when they are written.
 *
 * The Hub request id is kept on purpose. It points at a line in the
 * Hub's own log, and for a read of an account that line names the
 * address: whoever has the report and the Hub's log can join the two.
 */
import { walletStore } from "../state/wallet-store";
import { signerInfo } from "../wallets/capabilities";
import { GET_RECENT_LOGS_MESSAGE, getRecentLogs, type LogEntry } from "./log";
import { APP_VERSION } from "./version";

/** A log entry and the extension context that wrote it: `popup`, `sidepanel` or `background`. */
export interface ReportLogEntry extends LogEntry {
  context: string;
}

export interface ErrorDetails {
  message: string;
  /** The Hub's id for the failed request, when the error came from a Hub response. */
  requestId?: string;
  version: string;
  time: Date;
  page: string;
  /** Unset when the wallet state could not be read. */
  wallet?: "not set up" | "locked" | { network: string; signer: string };
  userAgent: string;
  logs: ReportLogEntry[];
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

/** The extension context a page runs in, named after its file: `popup` or `sidepanel`. */
export function pageContext(location: { pathname: string }): string {
  return (location.pathname.split("/").pop() ?? "").replace(/\.html$/, "") || "page";
}

const BACKGROUND_LOGS_TIMEOUT_MS = 1_000;

/**
 * The background's log ring, or nothing if it does not answer in time.
 * A service worker that was asleep answers with an empty ring: the ring
 * is in memory and starts over each time the worker does.
 */
async function backgroundLogs(): Promise<LogEntry[]> {
  try {
    const reply = await Promise.race([
      chrome.runtime.sendMessage({ type: GET_RECENT_LOGS_MESSAGE }),
      new Promise<undefined>((resolve) => setTimeout(resolve, BACKGROUND_LOGS_TIMEOUT_MS)),
    ]);
    return Array.isArray(reply?.logs) ? reply.logs : [];
  } catch {
    return [];
  }
}

/** This page's log and the background's, oldest first. */
async function collectLogs(pageContext: string): Promise<ReportLogEntry[]> {
  const tagged = (entries: LogEntry[], context: string) => entries.map((entry) => ({ ...entry, context }));
  return [...tagged(getRecentLogs(), pageContext), ...tagged(await backgroundLogs(), "background")].sort(
    (a, b) => a.ts - b.ts,
  );
}

export async function collectErrorDetails(message: string, requestId?: string): Promise<ErrorDetails> {
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
    requestId,
    version: APP_VERSION,
    time: new Date(),
    page: pageLabel(window.location),
    wallet,
    userAgent: navigator.userAgent,
    logs: await collectLogs(pageContext(window.location)),
  };
}

/**
 * Replace what could identify a wallet or its owner. Error messages
 * quote request paths and server replies, which hold addresses, txids
 * and, during recovery, an email. A request id survives: it is a UUID,
 * whose hex runs are short.
 */
export function maskIdentifiers(text: string): string {
  return text
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:bc|tb|bcrt)1[02-9ac-hj-np-z]{11,87}/gi, "[address]")
    .replace(/[0-9a-fA-F]{32,}/g, "[hex]")
    .replace(/[1-9A-HJ-NP-Za-km-z]{26,}/g, "[id]");
}

/**
 * A log entry's payload without the ids in it. The session code logs
 * which account it worked on, and that id is the Hub's own id for the
 * wallet. It is a UUID, like the request id that has to stay, so it is
 * told apart by its key: `id`, or a name ending in `Id`, `ID` or `_id`.
 */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key !== "requestId" && /^id$|(Id|ID|_id)$/.test(key) ? "[id]" : withoutIds(inner),
    ]),
  );
}

function formatLogEntry(entry: ReportLogEntry): string {
  let extra = "";
  if (entry.extra !== undefined) {
    try {
      extra = ` ${JSON.stringify(withoutIds(entry.extra))}`;
    } catch {
      extra = " [unserializable]";
    }
  }
  return `[${new Date(entry.ts).toISOString()}] ${entry.context} ${entry.level.toUpperCase()} ${entry.msg}${extra}`;
}

/** `olderLeftOut` is how many entries before `details.logs` were dropped to fit a size limit. */
export function formatErrorDetails(details: ErrorDetails, olderLeftOut = 0): string {
  const wallet =
    details.wallet === undefined
      ? "unknown"
      : typeof details.wallet === "string"
        ? details.wallet
        : `${details.wallet.network}, ${details.wallet.signer}`;
  const shown = details.logs.length;
  const logHeading =
    shown + olderLeftOut === 0
      ? "Recent log: (empty)"
      : olderLeftOut === 0
        ? `Recent log (${shown}):`
        : `Recent log (latest ${shown}, ${olderLeftOut} older left out):`;
  const lines = [
    "Arch Wallet error report",
    `Error: ${details.message}`,
    ...(details.requestId ? [`Hub request: ${details.requestId}`] : []),
    `Version: ${details.version}`,
    `Time: ${details.time.toISOString()}`,
    `Page: ${details.page}`,
    `Wallet: ${wallet}`,
    `Browser: ${details.userAgent}`,
    "",
    logHeading,
    ...details.logs.map(formatLogEntry),
  ];
  return maskIdentifiers(lines.join("\n"));
}

/** The size the Hub measures a report by: the UTF-8 bytes of its JSON string encoding. */
function encodedBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length;
}

/**
 * The report text, with the oldest log entries left out until it is no
 * larger than `maxEncodedBytes`.
 */
export function formatErrorDetailsToFit(details: ErrorDetails, maxEncodedBytes: number): string {
  for (let dropped = 0; ; dropped++) {
    const text = formatErrorDetails({ ...details, logs: details.logs.slice(dropped) }, dropped);
    if (encodedBytes(text) <= maxEncodedBytes) return text;
    if (dropped < details.logs.length) continue;
    // No log left to drop: the error message itself is too long.
    let cut = text;
    while (encodedBytes(cut) > maxEncodedBytes) cut = cut.slice(0, Math.floor(cut.length * 0.9));
    return cut;
  }
}
