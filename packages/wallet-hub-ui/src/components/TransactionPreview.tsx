import { useEffect, useState } from "react";
import {
  computeDisplayHash,
  type CreateSigningResponse,
  type GetSigningRequestResponse,
} from "@arch-network/wallet-hub-sdk";

type DisplayMetadata = {
  kind?: string;
  from?: { taprootAddress?: string; archAccountAddress?: string };
  to?: { input?: string; archAccountAddress?: string };
  account?: { taprootAddress?: string; archAccountAddress?: string; btcAccountAddress?: string };
  lamports?: string;
  utxo?: { txid?: string; vout?: number };
  warnings?: string[];
};

type DisplayIntegrity =
  | { state: "checking" }
  | { state: "verified" }
  | { state: "mismatch"; expected: string; computed: string }
  | { state: "missing" }
  | { state: "error"; message: string };

/**
 * Cap on length of any user-controlled string we render inline. The
 * server normalises addresses to a known schema, but defence in depth
 * is cheap and keeps malformed responses from blowing up the layout.
 */
const MAX_INLINE_LEN = 256;

function truncate(value: unknown, max = MAX_INLINE_LEN): string {
  if (typeof value !== "string") return String(value ?? "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function TransactionPreview(props: {
  signingRequest: CreateSigningResponse | GetSigningRequestResponse;
  className?: string;
}) {
  const { signingRequest, className } = props;
  const display = (signingRequest.display as DisplayMetadata) || {};
  // SECURITY: before showing anything signable, recompute the display
  // hash locally and compare against the server's `displayHash`.
  // Mismatch means the bytes we're about to sign do not correspond
  // to the preview the user is reading -- the canonical blind-sign
  // failure mode.
  const [integrity, setIntegrity] = useState<DisplayIntegrity>({ state: "checking" });
  useEffect(() => {
    let cancelled = false;
    const expected = (signingRequest as { displayHash?: string }).displayHash;
    if (!expected) {
      setIntegrity({ state: "missing" });
      return;
    }
    (async () => {
      try {
        const computed = await computeDisplayHash(signingRequest.display);
        if (cancelled) return;
        setIntegrity(
          computed === expected
            ? { state: "verified" }
            : { state: "mismatch", expected, computed },
        );
      } catch (err: any) {
        if (cancelled) return;
        setIntegrity({ state: "error", message: err?.message ?? String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signingRequest]);

  const integrityBanner = renderIntegrityBanner(integrity);

  if (display.kind === "arch.transfer") {
    return (
      <div className={className} style={{ fontFamily: "system-ui", fontSize: 14 }}>
        {integrityBanner}
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: 16, fontWeight: 600 }}>Transfer</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div>
              <strong>From:</strong>{" "}
              <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                {truncate(display.from?.archAccountAddress || display.from?.taprootAddress || "Unknown")}
              </code>
            </div>
            <div>
              <strong>To:</strong>{" "}
              <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                {truncate(display.to?.archAccountAddress || display.to?.input || "Unknown")}
              </code>
            </div>
            <div>
              <strong>Amount:</strong> {truncate(display.lamports || "0", 32)} lamports
            </div>
          </div>
        </div>
        {display.warnings && display.warnings.length > 0 && (
          <div style={{ marginTop: 12, padding: 8, background: "#fff3cd", borderRadius: 4, fontSize: 13 }}>
            <strong>Warnings:</strong>
            <ul style={{ margin: "4px 0 0 0", paddingLeft: 20 }}>
              {display.warnings.map((warning, i) => (
                <li key={i}>{truncate(warning, 512)}</li>
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
        {integrityBanner}
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ margin: "0 0 8px 0", fontSize: 16, fontWeight: 600 }}>Anchor Account</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {display.account && (
              <>
                <div>
                  <strong>Taproot Address:</strong>{" "}
                  <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                    {truncate(display.account.taprootAddress || "Unknown")}
                  </code>
                </div>
                <div>
                  <strong>Arch Account:</strong>{" "}
                  <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                    {truncate(display.account.archAccountAddress || "Unknown")}
                  </code>
                </div>
                {display.account.btcAccountAddress && (
                  <div>
                    <strong>BTC Account Address:</strong>{" "}
                    <code style={{ fontSize: 12, background: "#f0f0f0", padding: "2px 6px", borderRadius: 3 }}>
                      {truncate(display.account.btcAccountAddress)}
                    </code>
                  </div>
                )}
              </>
            )}
            {display.utxo && (
              <div style={{ marginTop: 8 }}>
                <strong>UTXO:</strong> {truncate(display.utxo.txid, 80)}:{display.utxo.vout}
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
      {integrityBanner}
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Transaction Details</summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8 }}>
          {JSON.stringify(display, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function renderIntegrityBanner(state: DisplayIntegrity) {
  if (state.state === "verified") return null;
  if (state.state === "checking") {
    return (
      <div style={bannerStyle("#eef")}>Verifying transaction preview matches server payload...</div>
    );
  }
  if (state.state === "missing") {
    return (
      <div style={bannerStyle("#fff3cd")}>
        <strong>No displayHash from server.</strong> Cannot verify that the preview below matches
        the bytes being signed; proceed with caution.
      </div>
    );
  }
  if (state.state === "mismatch") {
    return (
      <div style={bannerStyle("#f8d7da")}>
        <strong>Display hash mismatch.</strong> The transaction preview does NOT match the server's
        recorded payload. DO NOT SIGN.
        <div style={{ fontFamily: "monospace", fontSize: 11, marginTop: 4 }}>
          expected {state.expected.slice(0, 12)}... got {state.computed.slice(0, 12)}...
        </div>
      </div>
    );
  }
  return (
    <div style={bannerStyle("#f8d7da")}>
      <strong>Could not verify transaction preview.</strong> {state.message}
    </div>
  );
}

function bannerStyle(bg: string) {
  return {
    padding: 8,
    background: bg,
    borderRadius: 4,
    fontSize: 13,
    marginBottom: 12,
  } as const;
}
