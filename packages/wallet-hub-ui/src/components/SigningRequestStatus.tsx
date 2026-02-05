import type { GetSigningRequestResponse, SigningRequestReadiness } from "@arch/wallet-hub-sdk";

export function SigningRequestStatus(props: {
  signingRequest: GetSigningRequestResponse;
  className?: string;
}) {
  const { signingRequest, className } = props;
  const { status, readiness } = signingRequest;

  const getStatusColor = (s: string) => {
    if (s === "succeeded") return "#28a745";
    if (s === "pending") return "#ffc107";
    if (s === "failed") return "#dc3545";
    return "#6c757d";
  };

  const getReadinessColor = (r: SigningRequestReadiness) => {
    if (r.status === "ready") return "#28a745";
    if (r.status === "not_ready") return "#ffc107";
    return "#6c757d";
  };

  return (
    <div className={className} style={{ fontFamily: "system-ui", fontSize: 14 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong>Status:</strong>
          <span
            style={{
              padding: "4px 8px",
              borderRadius: 4,
              background: getStatusColor(status),
              color: "white",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {status.toUpperCase()}
          </span>
        </div>

        {readiness && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <strong>Readiness:</strong>
            <span
              style={{
                padding: "4px 8px",
                borderRadius: 4,
                background: getReadinessColor(readiness),
                color: "white",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {readiness.status.toUpperCase()}
            </span>
            {readiness.reason && (
              <span style={{ fontSize: 12, color: "#6c757d" }}>({readiness.reason})</span>
            )}
          </div>
        )}

        {readiness?.status === "not_ready" && readiness.reason === "BtcUtxoNotConfirmed" && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              background: "#fff3cd",
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            <strong>⏳ Waiting for BTC confirmations:</strong>
            <div style={{ marginTop: 4 }}>
              {readiness.confirmations ?? 0} / {readiness.requiredConfirmations ?? 20} confirmations
            </div>
            {readiness.btcAccountAddress && (
              <div style={{ marginTop: 4, fontSize: 12 }}>
                BTC Account: <code>{readiness.btcAccountAddress}</code>
              </div>
            )}
          </div>
        )}

        {readiness?.status === "not_ready" && readiness.reason === "NotAnchored" && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              background: "#fff3cd",
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            <strong>⚠️ Account not anchored:</strong>
            <div style={{ marginTop: 4 }}>
              This account needs to be anchored to a BTC UTXO before it can execute transfers. Submit an{" "}
              <code>arch.anchor</code> transaction first.
            </div>
          </div>
        )}

        {readiness?.status === "not_ready" && readiness.reason === "ArchAccountNotFound" && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              background: "#fff3cd",
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            <strong>⚠️ Arch account not found:</strong>
            <div style={{ marginTop: 4 }}>
              The Arch account doesn't exist yet. Fund the account (airdrop) and then anchor a BTC UTXO.
            </div>
          </div>
        )}

        {readiness?.anchoredUtxo && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#6c757d" }}>
            <strong>Anchored UTXO:</strong> {readiness.anchoredUtxo.txid}:{readiness.anchoredUtxo.vout}
          </div>
        )}
      </div>

      {signingRequest.result != null && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Transaction Result</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8 }}>
            {JSON.stringify(signingRequest.result, null, 2)}
          </pre>
        </details>
      )}

      {signingRequest.error != null && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, color: "#dc3545" }}>Error</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8, color: "#dc3545" }}>
            {JSON.stringify(signingRequest.error, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
