import type { PortfolioResponse } from "@arch/wallet-hub-sdk";

export function PortfolioPanel(props: { portfolio: PortfolioResponse }) {
  const { portfolio } = props;
  return (
    <div style={{ fontFamily: "system-ui", fontSize: 14 }}>
      <div>
        <strong>BTC Address:</strong> {portfolio.btc.address}
      </div>
      <div>
        <strong>Arch Account:</strong> {portfolio.arch.accountAddress}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary>Raw BTC</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(portfolio.btc, null, 2)}</pre>
      </details>
      <details style={{ marginTop: 8 }}>
        <summary>Raw Arch</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(portfolio.arch, null, 2)}</pre>
      </details>
    </div>
  );
}
