/**
 * RecoverViaEmailCta -- the single canonical entry point into the
 * email-OTP recovery flow.
 *
 * Two contexts use this component:
 *
 *   1. Unlock screen (`pinToActiveAccount=false`): the user forgot
 *      their password. We don't yet know which wallet they want to
 *      recover, so the Recover screen will ask for the email cold.
 *
 *   2. Settings (`pinToActiveAccount=true`): the user is already
 *      logged into a specific wallet and wants to re-bootstrap its
 *      session (or replace a lost passkey). We resolve the local
 *      install id and pin the Recover screen to that externalUserId,
 *      which lets it skip the wallet-picker step when the Hub
 *      returns exactly one candidate.
 *
 * Keeping the navigation logic in one place prevents the two call
 * sites from drifting -- a recurring bug-class in this kind of UI
 * is "the button on screen A pins externalUserId but the button on
 * screen B doesn't, and a year later we can't remember why".
 *
 * The component is intentionally *just* a CTA -- the recovery flow
 * itself lives in `pages/Recover`, where we have room for state,
 * forms, and async error handling. This file is reusable styling +
 * one navigation decision.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getExternalUserId } from "../utils/sdk";

interface Props {
  /**
   * If true, fetch the local externalUserId before navigating and
   * pass it to the Recover screen as a query param. The Recover
   * screen will pre-fill the email (if unlocked state has it) and
   * skip the wallet-picker step.
   */
  pinToActiveAccount?: boolean;
  /** Optional active wallet resource id used to disambiguate same-email wallets. */
  resourceId?: string;
  /**
   * "button" renders a full-width secondary button (the default,
   * appropriate when the CTA is the primary action of its section);
   * "link" renders a slim text link for places where the CTA is
   * secondary to something else on screen.
   */
  variant?: "button" | "link";
  /** Override the visible label; falls back to "Recover via email". */
  label?: string;
  /** Override the tooltip; the default tells the user what to expect. */
  title?: string;
}

const DEFAULT_LABEL = "Recover via email";
const DEFAULT_TITLE =
  "Use email recovery to rebuild this wallet's session on this device";

export default function RecoverViaEmailCta({
  pinToActiveAccount = false,
  resourceId,
  variant = "button",
  label = DEFAULT_LABEL,
  title = DEFAULT_TITLE,
}: Props) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const handle = useCallback(async () => {
    setBusy(true);
    try {
      if (pinToActiveAccount) {
        // getExternalUserId() reads chrome.storage.local, which is
        // available even when the wallet keystore is locked. We
        // still wrap in try/finally so a missing storage value
        // doesn't strand the user with a spinning button.
        const externalUserId = await getExternalUserId();
        const qs = new URLSearchParams({ externalUserId });
        if (resourceId) qs.set("resourceId", resourceId);
        navigate(`/recover?${qs.toString()}`);
      } else {
        navigate(`/recover`);
      }
    } finally {
      setBusy(false);
    }
  }, [pinToActiveAccount, resourceId, navigate]);

  if (variant === "link") {
    return (
      <button
        type="button"
        onClick={handle}
        disabled={busy}
        title={title}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: "var(--text-muted)",
          textDecoration: "underline",
          cursor: busy ? "default" : "pointer",
          fontSize: 12,
        }}
      >
        {busy ? "Loading..." : label}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-secondary btn-full"
      onClick={handle}
      disabled={busy}
      title={title}
    >
      {busy ? "Loading..." : label}
    </button>
  );
}
