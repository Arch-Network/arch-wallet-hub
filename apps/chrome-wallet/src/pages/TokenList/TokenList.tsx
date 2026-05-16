import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { getIndexer } from "../../utils/indexer";
import { formatTokenAmount, truncateAddress } from "../../utils/format";
import { enrichTokenFromRpc } from "../../utils/arch-rpc";
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

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

export default function TokenList() {
  const navigate = useNavigate();
  const { activeAccount, state } = useWallet();
  const [tokens, setTokens] = useState<TokenHolding[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!activeAccount) return;
    (async () => {
      setLoading(true);
      try {
        const indexer = await getIndexer();
        const tokenAddr = activeAccount.archAddress || activeAccount.btcAddress;
        const res = await indexer.getAccountTokens(tokenAddr);
        const rawTokens = res?.tokens ?? [];
        const enriched = await Promise.all(
          rawTokens.map(async (t) => {
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
              const rpc = await enrichTokenFromRpc(indexer, t);
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
  }, [activeAccount, state.network]);

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
      <>
        <div className="token-list-header">
          <button className="back-btn" onClick={() => navigate("/dashboard")}>
            <BackArrow />
            <span>Home</span>
          </button>
          <div className="section-title" style={{ margin: 0 }}>APL Tokens</div>
          <div style={{ width: 60 }} />
        </div>
        <div className="spinner-center">
          <div className="spinner" />
        </div>
      </>
    );
  }

  if (tokens.length === 0) {
    return (
      <>
        <div className="token-list-header">
          <button className="back-btn" onClick={() => navigate("/dashboard")}>
            <BackArrow />
            <span>Home</span>
          </button>
          <div className="section-title" style={{ margin: 0 }}>APL Tokens</div>
          <div style={{ width: 60 }} />
        </div>
        <div className="empty-state">
          <div className="empty-state-icon"><ArchIcon size={32} color="#7b68ee" /></div>
          <div>No APL tokens found</div>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Tokens on the Arch network will appear here once you receive them.
          </p>
        </div>
      </>
    );
  }

  const showSearch = tokens.length >= 5;
  const countLabel = searchQuery.trim()
    ? `${filtered.length} of ${tokens.length} tokens`
    : `${tokens.length} token${tokens.length !== 1 ? "s" : ""}`;

  return (
    <>
      <div className="token-list-header">
        <button className="back-btn" onClick={() => navigate("/dashboard")}>
          <BackArrow />
          <span>Home</span>
        </button>
        <div className="section-title" style={{ margin: 0 }}>APL Tokens</div>
        <div style={{ width: 60 }} />
      </div>
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
          filtered.map((tk) => (
            <div
              key={tk.mint}
              className="token-row"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/tokens/${encodeURIComponent(tk.mint)}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`/tokens/${encodeURIComponent(tk.mint)}`);
                }
              }}
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
              <div className="token-row-chevron">
                <ChevronIcon />
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
