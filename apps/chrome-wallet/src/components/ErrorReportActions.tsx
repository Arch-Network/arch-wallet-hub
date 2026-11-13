/**
 * What a user can do with an error: copy a report of it, or send that
 * report to the Wallet Hub's operators. Sending takes two clicks. The
 * first says what would be sent and where; nothing leaves the device
 * until the second.
 */
import { useState } from "react";

import { collectErrorDetails, formatErrorDetails } from "../utils/error-details";
import { errorReportHost, sendErrorReport } from "../utils/error-report";
import { isHubRateLimitError } from "../utils/hub-rate-limit";
import { walletHubErrorStatus } from "../utils/sdk";

type Props = {
  message: string;
  /** The Hub's id for the failed request, when the error came from a Hub response. */
  requestId?: string;
};

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "Copy error details",
  copied: "Copied",
  failed: "Couldn't copy",
};

type SendState =
  | { step: "idle" | "sending" }
  | { step: "confirm"; host: string }
  | { step: "sent"; id: string }
  | { step: "failed"; why: string };

/** A request id is long; its first block is enough to read out and to search a log for. */
export function shortReference(id: string): string {
  return id.slice(0, 8);
}

export default function ErrorReportActions({ message, requestId }: Props) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [send, setSend] = useState<SendState>({ step: "idle" });

  const copy = async () => {
    let next: CopyState = "copied";
    try {
      const details = await collectErrorDetails(message, requestId);
      await navigator.clipboard.writeText(formatErrorDetails(details));
    } catch {
      next = "failed";
    }
    setCopyState(next);
    setTimeout(() => setCopyState("idle"), 1500);
  };

  const askToSend = async () => {
    try {
      setSend({ step: "confirm", host: await errorReportHost() });
    } catch {
      setSend({ step: "failed", why: "Couldn't send the report. Copy the details instead." });
    }
  };

  const sendNow = async () => {
    setSend({ step: "sending" });
    try {
      setSend({ step: "sent", id: await sendErrorReport(message, requestId) });
    } catch (err) {
      const tooMany = isHubRateLimitError(err) || walletHubErrorStatus(err) === 429;
      setSend({
        step: "failed",
        why: tooMany
          ? "Too many reports were sent recently. Copy the details instead."
          : "Couldn't send the report. Copy the details instead.",
      });
    }
  };

  return (
    <div className="error-report-actions">
      <button type="button" className="error-banner-copy" onClick={copy}>
        {COPY_LABEL[copyState]}
      </button>
      {send.step === "idle" || send.step === "failed" ? (
        <button type="button" className="error-banner-copy" onClick={askToSend}>
          Send report
        </button>
      ) : null}
      {send.step === "confirm" ? (
        <div className="error-report-confirm">
          <p>
            Sends this error with the app version, screen, network, wallet type, browser and recent diagnostic log
            to the Wallet Hub at {send.host}, where its operators can read it. Addresses, transaction ids and emails
            are masked.
          </p>
          <button type="button" className="error-banner-copy" onClick={sendNow}>
            Send
          </button>
          <button type="button" className="error-banner-copy" onClick={() => setSend({ step: "idle" })}>
            Cancel
          </button>
        </div>
      ) : null}
      {send.step === "sending" ? <span role="status">Sending…</span> : null}
      {send.step === "sent" ? <span role="status">Report sent. Reference {shortReference(send.id)}</span> : null}
      {send.step === "failed" ? <span role="status">{send.why}</span> : null}
    </div>
  );
}
