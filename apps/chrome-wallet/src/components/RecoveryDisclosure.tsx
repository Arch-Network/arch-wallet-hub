/**
 * Shared disclosure component used on Onboarding and Add Wallet to
 * replace the older "We never see your keys" footer trust copy. That
 * line was technically true but actively misleading -- it implied
 * recovery was automatic. This component lists the three loss
 * scenarios with their honest recovery paths so users can make an
 * informed choice about whether to add a recovery email.
 *
 * Scenarios covered:
 *
 *   1. Lost passkey, still have password and email      -> recoverable
 *   2. Lost password, still have device + email + key   -> partial:
 *      Reset Wallet + re-enroll (workaround until case (b) lands).
 *   3. Lost device entirely, only have email            -> recoverable
 *      iff a recovery email was set; otherwise lost.
 *
 * Renders as a collapsed `<details>` so it doesn't dominate the
 * onboarding screen but is always reachable.
 */

interface RecoveryDisclosureProps {
  variant?: "default" | "compact";
}

export default function RecoveryDisclosure({
  variant = "default",
}: RecoveryDisclosureProps) {
  const fontSize = variant === "compact" ? 11 : 12;
  return (
    <details
      style={{
        width: "100%",
        marginTop: 12,
        textAlign: "left",
        fontSize,
        color: "var(--text-secondary)",
        lineHeight: 1.6,
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize,
          fontWeight: 600,
          padding: "4px 0",
        }}
      >
        What if I lose access?
      </summary>
      <ul
        style={{
          margin: "6px 0 0 0",
          paddingLeft: 18,
          color: "var(--text-secondary)",
        }}
      >
        <li style={{ marginBottom: 6 }}>
          <strong>Lost passkey, still know your password:</strong> Open
          Settings &rarr; Replace passkey via email. We&apos;ll send a
          code to your recovery email and attach a new passkey.
        </li>
        <li style={{ marginBottom: 6 }}>
          <strong>Forgot your password:</strong> Reset Wallet in
          Settings, then recover via your recovery email. (A direct
          "forgot password" flow is on the roadmap.)
        </li>
        <li style={{ marginBottom: 6 }}>
          <strong>Lost this device entirely:</strong> Reinstall the
          extension and choose &quot;Recover wallet&quot; on the
          unlock screen. You&apos;ll need access to your recovery
          email.
        </li>
        <li style={{ color: "var(--text-muted)" }}>
          <em>Without a recovery email, none of the above is
          possible</em> -- your wallet would be permanently
          inaccessible if you lose the passkey. That&apos;s why we
          recommend setting one even though it&apos;s optional.
        </li>
      </ul>
    </details>
  );
}
