import type { PortfolioResponse } from "@arch/wallet-hub-sdk";

type ArchSummary = {
  balance?: string;
  lamports?: string;
  tokens?: Array<{
    mint?: string;
    amount?: string;
    decimals?: number;
    symbol?: string;
    name?: string;
  }>;
};

type BtcSummary = {
  balance?: string;
  satoshis?: number;
  confirmed?: number;
  unconfirmed?: number;
};

export function PortfolioPanel(props: { portfolio: PortfolioResponse; className?: string }) {
  const { portfolio, className } = props;
  const archSummary = (portfolio.arch.summary as ArchSummary) || {};
  const btcSummary = (portfolio.btc.summary as BtcSummary) || {};

  // Format lamports to ARCH (assuming 1 ARCH = 1e9 lamports, similar to SOL)
  const formatLamports = (lamports: string | number | undefined) => {
    if (!lamports) return "0";
    const num = typeof lamports === "string" ? BigInt(lamports) : BigInt(lamports);
    return (Number(num) / 1e9).toFixed(9);
  };

  // Format satoshis to BTC
  const formatSatoshis = (satoshis: number | undefined) => {
    if (!satoshis) return "0";
    return (satoshis / 1e8).toFixed(8);
  };

  return (
    <div className={className} style={{ fontFamily: "system-ui", fontSize: 14 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 600 }}>Portfolio</h3>
        
        {/* Addresses */}
        <div style={{ marginBottom: 16, padding: 12, background: "#f8f9fa", borderRadius: 6 }}>
          <div style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 12, color: "#6c757d" }}>BTC Address (Taproot):</strong>
            <div style={{ marginTop: 4 }}>
              <code style={{ fontSize: 12, wordBreak: "break-all" }}>{portfolio.btc.address}</code>
            </div>
          </div>
          <div>
            <strong style={{ fontSize: 12, color: "#6c757d" }}>Arch Account:</strong>
            <div style={{ marginTop: 4 }}>
              <code style={{ fontSize: 12, wordBreak: "break-all" }}>{portfolio.arch.accountAddress}</code>
            </div>
          </div>
        </div>

        {/* BTC Balance */}
        <div style={{ marginBottom: 16, padding: 12, background: "#f8f9fa", borderRadius: 6 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Bitcoin (L1)</strong>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            {formatSatoshis(btcSummary.balance ? Number(btcSummary.balance) : btcSummary.satoshis)} BTC
          </div>
          {btcSummary.confirmed !== undefined && (
            <div style={{ fontSize: 12, color: "#6c757d", marginTop: 4 }}>
              Confirmed: {formatSatoshis(btcSummary.confirmed)} BTC
              {btcSummary.unconfirmed !== undefined && btcSummary.unconfirmed > 0 && (
                <span> • Unconfirmed: {formatSatoshis(btcSummary.unconfirmed)} BTC</span>
              )}
            </div>
          )}
        </div>

        {/* Arch L2 Balance */}
        <div style={{ marginBottom: 16, padding: 12, background: "#e7f3ff", borderRadius: 6, border: "1px solid #b3d9ff" }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Arch Network (L2)</strong>
            <span style={{ fontSize: 11, color: "#6c757d", marginLeft: 8 }}>
              ⚠️ Not shown in Bitcoin wallets
            </span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            {formatLamports(archSummary.lamports || archSummary.balance)} ARCH
          </div>
          {archSummary.balance && (
            <div style={{ fontSize: 12, color: "#6c757d", marginTop: 4 }}>
              {archSummary.lamports || archSummary.balance} lamports
            </div>
          )}
        </div>

        {/* Arch L2 Tokens */}
        {archSummary.tokens && archSummary.tokens.length > 0 && (
          <div style={{ marginBottom: 16, padding: 12, background: "#e7f3ff", borderRadius: 6, border: "1px solid #b3d9ff" }}>
            <div style={{ marginBottom: 8 }}>
              <strong>Arch L2 Tokens</strong>
              <span style={{ fontSize: 11, color: "#6c757d", marginLeft: 8 }}>
                ⚠️ Not shown in Bitcoin wallets
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {archSummary.tokens.map((token, i) => {
                const decimals = token.decimals ?? 0;
                const amount = token.amount
                  ? (Number(token.amount) / Math.pow(10, decimals)).toFixed(decimals > 0 ? decimals : 0)
                  : "0";
                return (
                  <div key={i} style={{ padding: 8, background: "white", borderRadius: 4 }}>
                    <div style={{ fontWeight: 600 }}>
                      {token.symbol || token.name || "Unknown Token"}
                    </div>
                    <div style={{ fontSize: 16, marginTop: 4 }}>{amount}</div>
                    {token.mint && (
                      <div style={{ fontSize: 11, color: "#6c757d", marginTop: 4, wordBreak: "break-all" }}>
                        {token.mint}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Debug: Raw Data */}
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "#6c757d" }}>Raw Data (Debug)</summary>
        <div style={{ marginTop: 8, display: "flex", gap: 16 }}>
          <details style={{ flex: 1 }}>
            <summary style={{ cursor: "pointer", fontSize: 12 }}>BTC Data</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, marginTop: 4 }}>
              {JSON.stringify(portfolio.btc, null, 2)}
            </pre>
          </details>
          <details style={{ flex: 1 }}>
            <summary style={{ cursor: "pointer", fontSize: 12 }}>Arch Data</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, marginTop: 4 }}>
              {JSON.stringify(portfolio.arch, null, 2)}
            </pre>
          </details>
        </div>
      </details>
    </div>
  );
}
