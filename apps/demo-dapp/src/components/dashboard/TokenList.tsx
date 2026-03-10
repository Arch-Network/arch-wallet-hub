import { useState, useEffect } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { AccountTokenBalance } from "@arch/wallet-hub-sdk";

type TokenListProps = {
  client: WalletHubClient;
  address: string;
};

export default function TokenList({ client, address }: TokenListProps) {
  const [tokens, setTokens] = useState<AccountTokenBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await client.getAccountTokens(address);
        if (!cancelled) setTokens(resp.tokens ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load tokens");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, address]);

  if (loading) {
    return (
      <div className="token-list-section">
        <h3 className="token-list-title">APL Tokens</h3>
        <div className="token-list-loading">
          <span className="spinner small" /> Loading tokens…
        </div>
      </div>
    );
  }

  return (
    <div className="token-list-section">
      <h3 className="token-list-title">APL Tokens</h3>

      {error && <p className="token-list-error">{error}</p>}

      {tokens.length === 0 && !error ? (
        <p className="token-list-empty">No APL tokens found for this account.</p>
      ) : (
        <div className="token-list-grid">
          {tokens.map((t) => (
            <div key={t.token_account_address} className="token-card">
              <div className="token-card-header">
                {t.image && (
                  <img
                    src={t.image}
                    alt={t.symbol ?? t.name ?? "token"}
                    className="token-card-icon"
                  />
                )}
                <div className="token-card-name-group">
                  <span className="token-card-symbol">
                    {t.symbol ?? "Unknown"}
                  </span>
                  {t.name && (
                    <span className="token-card-name">{t.name}</span>
                  )}
                </div>
              </div>
              <div className="token-card-balance">
                <span className="token-card-amount">{t.ui_amount}</span>
                <span className="token-card-raw mono">{t.amount} raw</span>
              </div>
              {t.state === "frozen" && (
                <span className="token-card-frozen-badge">Frozen</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
