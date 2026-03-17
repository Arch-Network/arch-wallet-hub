import { useState, useEffect } from "react";
import { useWallet } from "../../hooks/useWallet";
import { getClient } from "../../utils/sdk";
import { formatTokenAmount, truncateAddress } from "../../utils/format";
import CopyButton from "../../components/CopyButton";

interface TokenHolding {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  image?: string;
}

export default function TokenList() {
  const { activeAccount } = useWallet();
  const [tokens, setTokens] = useState<TokenHolding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeAccount) return;
    (async () => {
      setLoading(true);
      try {
        const client = await getClient();
        const res = await client.getAccountTokens(activeAccount.btcAddress);
        setTokens(
          ((res as any)?.tokens ?? []).map((t: any) => ({
            mint: t.mint_address,
            symbol: t.symbol || "APL",
            name: t.name || "Unknown Token",
            balance: t.amount ?? 0,
            decimals: t.decimals ?? 0,
            image: t.image,
          }))
        );
      } catch {
        setTokens([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [activeAccount]);

  if (loading) {
    return (
      <div className="spinner-center">
        <div className="spinner" />
      </div>
    );
  }

  if (tokens.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">◈</div>
        <div>No APL tokens found</div>
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Tokens on the Arch network will appear here once you receive them.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="section-title">APL Tokens</div>
      <div className="card">
        {tokens.map((tk) => (
          <div className="asset-row" key={tk.mint}>
            <div className="asset-icon apl">
              {tk.image ? (
                <img src={tk.image} alt={tk.symbol} style={{ width: 24, height: 24, borderRadius: "50%" }} />
              ) : (
                "◈"
              )}
            </div>
            <div className="asset-info">
              <div className="asset-name">{tk.symbol}</div>
              <div className="asset-sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {truncateAddress(tk.mint, 6)}
                <CopyButton text={tk.mint} />
              </div>
            </div>
            <div className="asset-balance">{formatTokenAmount(tk.balance, tk.decimals)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
