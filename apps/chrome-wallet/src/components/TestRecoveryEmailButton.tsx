/**
 * TestRecoveryEmailButton -- a tiny diagnostic that lets the user
 * verify their recovery email actually receives mail *before* they
 * find themselves locked out and racing the clock.
 *
 * Why this exists
 * ---------------
 * The recovery flow has three hard external dependencies:
 *
 *   1. The recovery email on file is a valid mailbox.
 *   2. The Hub's `findUsersByRecoveryEmail` knows about this user.
 *   3. Turnkey's `initOtpAuth` can address each candidate sub-org.
 *
 * Any of those can silently rot (mailbox change, db divergence,
 * stale rootUserId, suspended sub-org) and the user will only find
 * out at the worst possible moment -- when they need recovery to
 * actually work. This button lets them probe (1)-(3) any time
 * without committing to a full re-authentication.
 *
 * Implementation note
 * -------------------
 * Calling `initRecoveryEmail` *will* send a real OTP. We do not
 * call `verifyRecoveryEmail` -- the test is satisfied when the Hub
 * confirms at least one candidate was contacted (i.e. Turnkey
 * accepted INIT_OTP_AUTH against a known sub-org and we can mask
 * out the destination address). Each click also counts against the
 * 3-per-hour init rate limit, which we surface in the UI so the
 * user doesn't accidentally burn their recovery budget right
 * before they actually need it.
 */

import { useCallback, useState } from "react";
import { getClient } from "../utils/sdk";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; emailMasked: string; candidates: number }
  | { kind: "no_match" }
  | { kind: "error"; message: string };

interface Props {
  /**
   * The recovery email currently stored on the active account.
   * Pulled from `WalletAccount.recoveryEmail`; when undefined the
   * button renders disabled with an explanatory tooltip.
   */
  email: string | undefined;
}

export default function TestRecoveryEmailButton({ email }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const handleClick = useCallback(async () => {
    if (!email) return;
    setStatus({ kind: "sending" });
    try {
      const client = await getClient();
      const res = await client.initRecoveryEmail({ email });
      if (res.candidates.length > 0) {
        setStatus({
          kind: "sent",
          emailMasked: res.emailMasked,
          candidates: res.candidates.length,
        });
      } else {
        // Server returns 0 candidates both for "no match found" and
        // "you hit the rate limit"; we can't tell them apart on the
        // client by design (anti-enumeration). The message below
        // covers both cases.
        setStatus({ kind: "no_match" });
      }
    } catch (e: any) {
      setStatus({
        kind: "error",
        message: e?.message ?? "Unknown error",
      });
    }
  }, [email]);

  const disabled = !email || status.kind === "sending";
  const tooltip = email
    ? "Send a one-time code to your recovery email to verify delivery."
    : "Add a recovery email on this account first.";

  return (
    <div style={{ marginTop: 8 }}>
      <button
        className="btn btn-secondary btn-full"
        onClick={handleClick}
        disabled={disabled}
        title={tooltip}
      >
        {status.kind === "sending" ? "Sending..." : "Send myself a test OTP"}
      </button>

      <p
        style={{
          fontSize: 10,
          color: "var(--text-muted)",
          marginTop: 8,
          marginBottom: 0,
          lineHeight: 1.5,
        }}
      >
        Verifies your recovery email is reachable. You don't need to
        enter the code -- arrival in your inbox is enough. Counts
        against the 3-per-hour recovery limit, so don't spam this
        right before a real recovery.
      </p>

      <StatusRow status={status} />
    </div>
  );
}

function StatusRow({ status }: { status: Status }) {
  if (status.kind === "idle" || status.kind === "sending") return null;

  const common = {
    marginTop: 8,
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.4 as const,
  };

  if (status.kind === "sent") {
    return (
      <div
        role="status"
        style={{
          ...common,
          background: "var(--success-bg, rgba(34,197,94,0.1))",
          color: "var(--success-text, #16a34a)",
          border: "1px solid var(--success-border, rgba(34,197,94,0.3))",
        }}
      >
        Sent to {status.emailMasked}
        {status.candidates > 1
          ? ` (covers ${status.candidates} wallets on this email)`
          : ""}
        . Check your inbox -- you can discard the code.
      </div>
    );
  }

  if (status.kind === "no_match") {
    return (
      <div
        role="status"
        style={{
          ...common,
          background: "var(--warning-bg, rgba(234,179,8,0.1))",
          color: "var(--warning-text, #ca8a04)",
          border: "1px solid var(--warning-border, rgba(234,179,8,0.3))",
        }}
      >
        No wallet matched, or you hit the hourly recovery limit. If
        your email looks right, wait an hour and try again.
      </div>
    );
  }

  return (
    <div
      role="alert"
      style={{
        ...common,
        background: "var(--error-bg, rgba(239,68,68,0.1))",
        color: "var(--error-text, #dc2626)",
        border: "1px solid var(--error-border, rgba(239,68,68,0.3))",
      }}
    >
      Failed: {status.message}
    </div>
  );
}
