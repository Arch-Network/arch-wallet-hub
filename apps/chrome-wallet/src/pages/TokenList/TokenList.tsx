import { useState, useEffect, useMemo } from "react";
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

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ExplorerLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title="View in explorer" style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
}

export default function TokenList() {
  const { activeAccount, state } = useWallet();
  const [tokens, setTokens] = useState<TokenHolding[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedMint, setExpandedMint] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return tokens;
    const q = searchQuery.toLowerCase();
    return tokens.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.symbol.toLowerCase().includes(q) ||
        t.mint.toLowerCase().includes(q),
    );
  }, [tokens, searchQuery]);

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

  const showSearch = tokens.length >= 5;
  const countLabel = searchQuery.trim()
    ? `${filtered.length} of ${tokens.length} tokens`
    : `${tokens.length} token${tokens.length !== 1 ? "s" : ""}`;

  return (
    <>
      <div className="section-title">APL Tokens</div>
      <div className="token-count">{countLabel}</div>

      {showSearch && (
        <div className="token-search-wrap">
          <span className="token-search-icon"><SearchIcon /></span>
          <input
            className="token-search-input"
            type="text"
            placeholder="Search by name, symbol, or mint…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="token-search-clear" onClick={() => setSearchQuery("")}>
              ✕
            </button>
          )}
        </div>
      )}

      <div className="card">
        {filtered.length === 0 ? (
          <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            No tokens match "{searchQuery}"
          </div>
        ) : (
          filtered.map((tk) => {
            const isExpanded = expandedMint === tk.mint;
            return (
              <div key={tk.mint}>
                <div
                  className="token-row"
                  onClick={() => setExpandedMint(isExpanded ? null : tk.mint)}
                >
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
                  <div className="asset-balance">{tk.uiAmount}</div>
                  <div className={`token-row-chevron${isExpanded ? " expanded" : ""}`}>
                    <ChevronIcon />
                  </div>
                </div>

                <div className={`token-detail-panel${isExpanded ? " open" : ""}`}>
                  <div className="token-detail-row">
                    <span className="token-detail-label">Mint</span>
                    <a
                      className="token-detail-value"
                      href={`${explorerBase}/tokens/${tk.mint}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {truncateAddress(tk.mint, 8)}
                    </a>
                    <CopyButton text={tk.mint} />
                    <ExplorerLink href={`${explorerBase}/tokens/${tk.mint}`} />
                  </div>
                  {tk.tokenAccount && (
                    <div className="token-detail-row">
                      <span className="token-detail-label">Account</span>
                      <a
                        className="token-detail-value"
                        href={`${explorerBase}/accounts/${tk.tokenAccount}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {truncateAddress(tk.tokenAccount, 8)}
                      </a>
                      <CopyButton text={tk.tokenAccount} />
                      <ExplorerLink href={`${explorerBase}/accounts/${tk.tokenAccount}`} />
                    </div>
                  )}
                  <div className="token-detail-row">
                    <span className="token-detail-label">Decimals</span>
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{tk.decimals}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
