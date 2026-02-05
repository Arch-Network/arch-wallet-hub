import type { CreateSigningResponse, GetSigningRequestResponse } from "@arch/wallet-hub-sdk";

type DisplayMetadata = {
  kind?: string;
  from?: { taprootAddress?: string; archAccountAddress?: string };
  to?: { input?: string; archAccountAddress?: string };
  account?: { taprootAddress?: string; archAccountAddress?: string; btcAccountAddress?: string };
  lamports?: string;
  utxo?: { txid?: string; vout?: number };
  warnings?: string[];
};

export function TransactionPreview(props: {
  signingRequest: CreateSigningResponse | GetSigningRequestResponse;
  className?: string;
}) {
  const { signingRequest, className } = props;
  const display = (signingRequest.display as DisplayMetadata) || {};

  if (display.kind === "arch.transfer") {
    return (
      <div className={className} style={{ fontFamily: "system-ui", fontSize: 14 }}>
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: 16, fontWeight: 600 }}>Transfer</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div>
              <strong>From:</strong>{" "}
              <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                {display.from?.archAccountAddress || display.from?.taprootAddress || "Unknown"}
              </code>
            </div>
            <div>
              <strong>To:</strong>{" "}
              <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                {display.to?.archAccountAddress || display.to?.input || "Unknown"}
              </code>
            </div>
            <div>
              <strong>Amount:</strong> {display.lamports || "0"} lamports
            </div>
          </div>
        </div>
        {display.warnings && display.warnings.length > 0 && (
          <div style={{ marginTop: 12, padding: 8, background: "#fff3cd", borderRadius: 4, fontSize: 13 }}>
            <strong>⚠️ Warnings:</strong>
            <ul style={{ margin: "4px 0 0 0", paddingLeft: 20 }}>
              {display.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (display.kind === "arch.anchor") {
    return (
      <div className={className} style={{ fontFamily: "system-ui", fontSize: 14 }}>
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: 16, fontWeight: 600 }}>Anchor Account</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {display.account && (
              <>
                <div>
                  <strong>Taproot Address:</strong>{" "}
                  <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                    {display.account.taprootAddress || "Unknown"}
                  </code>
                </div>
                <div>
                  <strong>Arch Account:</strong>{" "}
                  <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                    {display.account.archAccountAddress || "Unknown"}
                  </code>
                </div>
                {display.account.btcAccountAddress && (
                  <div>
                    <strong>BTC Account Address:</strong>{" "}
                    <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                      {display.account.btcAccountAddress}
                    </code>
                  </div>
                )}
              </>
            )}
            {display.utxo && (
              <div style={{ marginTop: 8 }}>
                <strong>UTXO:</strong> {display.utxo.txid}:{display.utxo.vout}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Fallback: show raw display data
  return (
    <div className={className} style={{ fontFamily: "system-ui", fontSize: 14 }}>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Transaction Details</summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8 }}>
          {JSON.stringify(display, null, 2)}
        </pre>
      </details>
    </div>
  );
}
