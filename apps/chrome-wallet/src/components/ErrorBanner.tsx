/**
 * An error shown to the user, with a way to copy or send what a bug
 * report needs. Most failures are caught and shown here rather than
 * thrown, so this is the one place a user can hand us the build, screen
 * and recent log along with the message, and the one place that sees
 * every error a user was shown.
 *
 * Only the message is the alert: `id` goes on it too, so a field that
 * points at the banner with `aria-describedby` is described by the
 * error and not by the reference or the buttons.
 */
import { useEffect, useMemo, type CSSProperties } from "react";

import { hubRequestIdFor } from "../utils/hub-error";
import { log } from "../utils/log";
import ErrorReportActions, { shortReference } from "./ErrorReportActions";

type Props = {
  message: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
};

/** A screen that polls shows the same failure again and again; log each message once in this long. */
const SHOWN_AGAIN_AFTER_MS = 60_000;
/** `log` keeps a string whole up to this length. */
const LOGGED_MESSAGE_MAX = 200;
const lastShownAt = new Map<string, number>();

/**
 * Put a shown error in the diagnostics log, so a later report also lists
 * the errors that came before the one it is about.
 */
function noteErrorShown(message: string, requestId: string | undefined): void {
  const now = Date.now();
  for (const [shown, at] of lastShownAt) {
    if (now - at >= SHOWN_AGAIN_AFTER_MS) lastShownAt.delete(shown);
  }
  if (lastShownAt.has(message)) return;
  lastShownAt.set(message, now);
  log.warn("Error shown", { message: message.slice(0, LOGGED_MESSAGE_MAX), requestId });
}

export default function ErrorBanner({ message, id, className, style }: Props) {
  // Looked up when the message appears: the failure behind it is recent
  // now, and a later one with the same wording is a different request.
  const requestId = useMemo(() => hubRequestIdFor(message), [message]);

  useEffect(() => {
    noteErrorShown(message, requestId);
  }, [message, requestId]);

  return (
    <div className={className ? `error-banner ${className}` : "error-banner"} style={style}>
      <span id={id} role="alert">
        {message}
      </span>
      {requestId ? <span className="error-banner-ref">Ref {shortReference(requestId)}</span> : null}
      <ErrorReportActions message={message} requestId={requestId} />
    </div>
  );
}
