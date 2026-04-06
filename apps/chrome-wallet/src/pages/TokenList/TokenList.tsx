import { useState, useEffect } from "react";
import { useWallet } from "../../hooks/useWallet";
import { getClient } from "../../utils/sdk";
import { formatTokenAmount, truncateAddress } from "../../utils/format";
import { enrichTokenFromRpc, getArchRpcUrl } from "../../utils/arch-rpc";
import CopyButton from "../../components/CopyButton";
import ArchIcon from "../../components/ArchIcon";

interface TokenHolding {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiAmount: string;
  image?: string;
  tokenAccount: string;
}

export default function TokenList() {
  const { activeAccount, state } = useWallet();
  const [tokens, setTokens] = useState<TokenHolding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeAccount) return;
    (async () => {
      setLoading(true);
      try {
        const client = await getClient();
        const tokenAddr = activeAccount.archAddress || activeAccount.btcAddress;
        const rpcUrl = getArchRpcUrl(state.network);
        const res = await client.getAccountTokens(tokenAddr, { archAddress: activeAccount.archAddress });
        const rawTokens = (res as any)?.tokens ?? [];
        const enriched = await Promise.all(
          rawTokens.map(async (t: any) => {
            const base = {
              mint: t.mint_address as string,
              symbol: t.symbol || truncateAddress(t.mint_address, 4),
              name: t.name || "APL Token",
              balance: Number(t.amount) || 0,
              decimals: t.decimals ?? 0,
              uiAmount: t.ui_amount || formatTokenAmount(Number(t.amount) || 0, t.decimals ?? 0),
              image: t.image as string | undefined,
              tokenAccount: (t.token_account_address || "") as string,
            };
            const needsEnrich = !t.name || !t.symbol || (!t.decimals && t.decimals !== undefined);
            if (!needsEnrich) return base;
            try {
              const rpc = await enrichTokenFromRpc(rpcUrl, t);
              if (rpc.name) base.name = rpc.name;
              if (rpc.symbol) base.symbol = rpc.symbol;
              if (rpc.image) base.image = rpc.image;
              if (rpc.decimals != null) base.decimals = rpc.decimals;
              if (rpc.uiAmount) base.uiAmount = rpc.uiAmount;
            } catch { /* best-effort */ }
            return base;
          }),
        );
        setTokens(enriched);
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
        <div className="empty-state-icon"><ArchIcon size={32} color="#7b68ee" /></div>
        <div>No APL tokens found</div>
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Tokens on the Arch network will appear here once you receive them.
        </p>
      </div>
    );
  }

  const isTestnet = state.network === "testnet4";
  const explorerBase = isTestnet
    ? "https://explorer.arch.network/testnet"
    : "https://explorer.arch.network/mainnet";

  return (
    <>
      <div className="section-title">APL Tokens</div>
      <div className="card">
        {tokens.map((tk) => (
          <div className="asset-row" key={tk.mint} style={{ flexDirection: "column", alignItems: "stretch", gap: 10, padding: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="asset-icon apl" style={{ flexShrink: 0 }}>
                {tk.image ? (
                  <img src={tk.image} alt={tk.symbol} style={{ width: 28, height: 28, borderRadius: "50%" }} />
                ) : (
                  <ArchIcon size={18} color="#7b68ee" />
                )}
              </div>
              <div className="asset-info" style={{ flex: 1, minWidth: 0 }}>
                <div className="asset-name">{tk.name}</div>
                <div className="asset-sub">{tk.symbol}</div>
              </div>
              <div className="asset-balance" style={{ fontWeight: 600, fontSize: 16 }}>{tk.uiAmount}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ opacity: 0.6, flexShrink: 0, width: 52 }}>Mint</span>
                <a
                  href={`${explorerBase}/tokens/${tk.mint}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#7b68ee", textDecoration: "none", wordBreak: "break-all", lineHeight: 1.3 }}
                >
                  {tk.mint}
                </a>
                <CopyButton text={tk.mint} />
              </div>
              {tk.tokenAccount && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ opacity: 0.6, flexShrink: 0, width: 52 }}>Account</span>
                  <a
                    href={`${explorerBase}/accounts/${tk.tokenAccount}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#7b68ee", textDecoration: "none", wordBreak: "break-all", lineHeight: 1.3 }}
                  >
                    {tk.tokenAccount}
                  </a>
                  <CopyButton text={tk.tokenAccount} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
