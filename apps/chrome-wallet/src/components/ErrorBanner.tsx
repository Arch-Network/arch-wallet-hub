/**
 * An error shown to the user, with a way to copy what a bug report
 * needs. Most failures are caught and shown here rather than thrown, so
 * this is the one place a user can hand us the build, screen and recent
 * log along with the message. The copy stays on the clipboard; see
 * `utils/error-details`.
 *
 * Only the message is the alert: `id` goes on it too, so a field that
 * points at the banner with `aria-describedby` is described by the
 * error and not by the button.
 */
import { useState, type CSSProperties } from "react";

import { collectErrorDetails, formatErrorDetails } from "../utils/error-details";

type Props = {
  message: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
};

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "Copy error details",
  copied: "Copied",
  failed: "Couldn't copy",
};

export default function ErrorBanner({ message, id, className, style }: Props) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  const copy = async () => {
    let next: CopyState = "copied";
    try {
      const details = await collectErrorDetails(message);
      await navigator.clipboard.writeText(formatErrorDetails(details));
    } catch {
      next = "failed";
    }
    setCopyState(next);
    setTimeout(() => setCopyState("idle"), 1500);
  };

  return (
    <div className={className ? `error-banner ${className}` : "error-banner"} style={style}>
      <span id={id} role="alert">
        {message}
      </span>
      <button type="button" className="error-banner-copy" onClick={copy}>
        {COPY_LABEL[copyState]}
      </button>
    </div>
  );
}
