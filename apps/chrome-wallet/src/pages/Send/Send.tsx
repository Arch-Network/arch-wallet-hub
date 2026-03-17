import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Turnkey } from "@turnkey/sdk-browser";
import { useWallet } from "../../hooks/useWallet";
import { getClient, getExternalUserId } from "../../utils/sdk";
import { formatBtc, formatArch, formatTokenAmount, formatArchId } from "../../utils/format";

type AssetType = "btc" | "arch" | "apl";

interface TokenHolding {
  mint: string;
  balance: number;
  decimals: number;
  symbol?: string;
  name?: string;
}

const ASSET_META: Record<AssetType, { icon: string; label: string; unit: string }> = {
  btc: { icon: "₿", label: "Bitcoin", unit: "BTC" },
  arch: { icon: "⟠", label: "ARCH", unit: "lamports" },
  apl: { icon: "◈", label: "APL Token", unit: "tokens" },
};

export default function Send() {
  const navigate = useNavigate();
  const { activeAccount, state } = useWallet();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [asset, setAsset] = useState<AssetType | null>(null);
  const [selectedToken, setSelectedToken] = useState<TokenHolding | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [txResult, setTxResult] = useState<{ txid: string; rawTxid: string } | null>(null);

  const [btcConfirmed, setBtcConfirmed] = useState<number>(0);
  const [btcPending, setBtcPending] = useState<number>(0);
  const [btcLoaded, setBtcLoaded] = useState(false);
  const [archBalance, setArchBalance] = useState<string | null>(null);
  const [tokensHeld, setTokensHeld] = useState<TokenHolding[]>([]);

  useEffect(() => {
    if (!activeAccount) return;
    const timeout = setTimeout(() => {
      if (!btcLoaded) setBtcLoaded(true);
      setArchBalance((prev) => prev ?? "0");
    }, 8000);

    const loadBalances = async () => {
      const client = await getClient();

      try {
        const o = await client.getWalletOverview(activeAccount.btcAddress);
        const btcSummary = (o as any)?.btc?.summary;
        let confirmed = 0;
        let pending = 0;

        if (btcSummary?.chain_stats) {
          confirmed = (btcSummary.chain_stats.funded_txo_sum ?? 0) - (btcSummary.chain_stats.spent_txo_sum ?? 0);
          pending = (btcSummary.mempool_stats?.funded_txo_sum ?? 0) - (btcSummary.mempool_stats?.spent_txo_sum ?? 0);
        } else if (Array.isArray(btcSummary?.outputs)) {
          for (const utxo of btcSummary.outputs) {
            const val = Number(utxo.value ?? 0);
            if (utxo.spent?.spent) continue;
            if (utxo.status?.confirmed) {
              confirmed += val;
            } else {
              pending += val;
            }
          }
        } else if (typeof btcSummary?.value === "number") {
          confirmed = btcSummary.value;
        }

        setBtcConfirmed(confirmed);
        setBtcPending(pending);
        setBtcLoaded(true);

        const lamports = (o as any)?.arch?.account?.lamports_balance ?? 0;
        setArchBalance(String(lamports));
      } catch {
        setBtcLoaded(true);
        setArchBalance("0");
      }

      try {
        const tokens = await client.getAccountTokens(activeAccount.btcAddress);
        setTokensHeld(
          ((tokens as any)?.tokens ?? []).map((t: any) => ({
            mint: t.mint_address,
            balance: t.amount ?? 0,
            decimals: t.decimals ?? 0,
            symbol: t.symbol,
            name: t.name,
          }))
        );
      } catch {
        setTokensHeld([]);
      }
    };
    loadBalances();
    return () => clearTimeout(timeout);
  }, [activeAccount]);

  const signWithPasskey = useCallback(
    async (signingRequestId: string, payloadHex: string): Promise<string> => {
      if (!activeAccount?.organizationId)
        throw new Error("Missing organization ID for passkey wallet");
      const tk = new Turnkey({
        apiBaseUrl: "https://api.turnkey.com",
        defaultOrganizationId: activeAccount.organizationId,
        rpId: globalThis.location?.hostname === "localhost" ? "localhost" : globalThis.location?.hostname ?? "localhost",
      });
      const pc = tk.passkeyClient();
      const signResult = await pc.signRawPayload({
        signWith: activeAccount.btcAddress,
        payload: payloadHex,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP",
      });
      const signature64Hex = `${signResult.r}${signResult.s}`;
      const client = await getClient();
      const externalUserId = getExternalUserId();
      const submitRes = await client.submitSigningRequest(signingRequestId, {
        externalUserId,
        signature64Hex,
      });
      const res = (submitRes as any).result ?? submitRes;
      return res?.txid || res?.txidHex || signingRequestId;
    },
    [activeAccount]
  );

  const handleSubmit = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    setError("");
    try {
      const client = await getClient();
      const externalUserId = getExternalUserId();
      let txid: string;

      if (asset === "arch" || asset === "apl") {
        const action =
          asset === "apl" && selectedToken
            ? {
                type: "arch.token_transfer" as const,
                mintAddress: selectedToken.mint,
                toAddress: recipient,
                amount,
                decimals: selectedToken.decimals,
              }
            : {
                type: "arch.transfer" as const,
                toAddress: recipient,
                lamports: amount,
              };

        const sr = await client.createSigningRequest({
          externalUserId,
          signer: { kind: "turnkey", resourceId: activeAccount.turnkeyResourceId },
          action,
        });

        const payloadHex = (sr.payloadToSign as any)?.payloadHex;
        if (!payloadHex) throw new Error("No payload available for signing");
        txid = await signWithPasskey(sr.signingRequestId, payloadHex);
      } else {
        throw new Error("BTC sending from Chrome extension requires server-side PSBT construction (coming soon).");
      }

      const displayTxid = asset !== "btc" ? formatArchId(txid) : txid;
      setTxResult({ txid: displayTxid, rawTxid: txid });
      setStep(4);
    } catch (err: any) {
      setError(err.message || "Transaction failed");
    } finally {
      setLoading(false);
    }
  }, [activeAccount, asset, selectedToken, recipient, amount, signWithPasskey]);

  const resetFlow = useCallback(() => {
    setStep(1);
    setAsset(null);
    setSelectedToken(null);
    setRecipient("");
    setAmount("");
    setError("");
    setTxResult(null);
  }, []);

  const isTestnet = state.network === "testnet4";
  const explorerBase = isTestnet
    ? "https://explorer.arch.network/testnet/tx/"
    : "https://explorer.arch.network/mainnet/tx/";

  // Step 1: Choose asset
  if (step === 1) {
    return (
      <>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Choose Asset</h2>
        {error && <div className="error-banner">{error}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button className="card" style={{ cursor: "pointer", textAlign: "left" }} onClick={() => { setAsset("btc"); setStep(2); }}>
            <div className="asset-row" style={{ border: "none", padding: 0 }}>
              <div className="asset-icon btc">₿</div>
              <div className="asset-info">
                <div className="asset-name">Bitcoin</div>
                <div className="asset-sub">
                  {btcLoaded
                    ? formatBtc(btcConfirmed + btcPending)
                    : "Loading..."}
                  {btcLoaded && btcPending !== 0 && (
                    <span style={{ color: "var(--success)", fontSize: 10, marginLeft: 6 }}>
                      ({(btcPending / 1e8).toFixed(8)} pending)
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
          <button className="card" style={{ cursor: "pointer", textAlign: "left" }} onClick={() => { setAsset("arch"); setStep(2); }}>
            <div className="asset-row" style={{ border: "none", padding: 0 }}>
              <div className="asset-icon arch">⟠</div>
              <div className="asset-info">
                <div className="asset-name">ARCH</div>
                <div className="asset-sub">{archBalance !== null ? formatArch(archBalance) : "Loading..."}</div>
              </div>
            </div>
          </button>
          {tokensHeld.map((tk) => (
            <button
              key={tk.mint}
              className="card"
              style={{ cursor: "pointer", textAlign: "left" }}
              onClick={() => { setSelectedToken(tk); setAsset("apl"); setStep(2); }}
            >
              <div className="asset-row" style={{ border: "none", padding: 0 }}>
                <div className="asset-icon apl">◈</div>
                <div className="asset-info">
                  <div className="asset-name">{tk.symbol || "APL Token"}</div>
                  <div className="asset-sub">{formatTokenAmount(tk.balance, tk.decimals)}</div>
                </div>
              </div>
            </button>
          ))}
          {tokensHeld.length === 0 && (
            <div className="card" style={{ opacity: 0.5 }}>
              <div className="asset-row" style={{ border: "none", padding: 0 }}>
                <div className="asset-icon apl">◈</div>
                <div className="asset-info">
                  <div className="asset-name">APL Tokens</div>
                  <div className="asset-sub">No tokens held</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  // Step 2: Enter details
  if (step === 2) {
    const meta = asset ? ASSET_META[asset] : ASSET_META.arch;
    return (
      <>
        <button className="btn btn-sm btn-secondary" onClick={() => setStep(1)} style={{ marginBottom: 12 }}>
          ← Back
        </button>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Send {meta.label}</h2>
        {error && <div className="error-banner">{error}</div>}
        <div className="input-group">
          <label className="input-label">Recipient Address</label>
          <input
            className="input-field mono"
            placeholder={asset === "btc" ? "tb1p..." : "Base58 address"}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
        </div>
        <div className="input-group">
          <label className="input-label">
            Amount ({meta.unit})
            {asset === "arch" && archBalance && (
              <span style={{ float: "right", color: "var(--text-muted)" }}>
                Available: {formatArch(archBalance)}
              </span>
            )}
            {asset === "btc" && btcLoaded && (
              <span style={{ float: "right", color: "var(--text-muted)" }}>
                Available: {((btcConfirmed + btcPending) / 1e8).toFixed(8)} BTC
              </span>
            )}
            {asset === "apl" && selectedToken && (
              <span style={{ float: "right", color: "var(--text-muted)" }}>
                Available: {formatTokenAmount(selectedToken.balance, selectedToken.decimals)}
              </span>
            )}
          </label>
          <div style={{ position: "relative" }}>
            <input
              className="input-field mono"
              type="number"
              step={asset === "btc" ? "0.00000001" : "1"}
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ paddingRight: 50 }}
            />
            {asset === "btc" && btcLoaded && (btcConfirmed + btcPending) > 0 && (
              <button
                type="button"
                onClick={() => setAmount(((btcConfirmed + btcPending) / 1e8).toFixed(8))}
                style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "rgba(193,154,91,0.15)", border: "1px solid rgba(193,154,91,0.3)",
                  borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700,
                  color: "var(--accent)", cursor: "pointer",
                }}
              >
                MAX
              </button>
            )}
          </div>
        </div>
        {asset === "btc" && btcPending !== 0 && (
          <div style={{
            fontSize: 11,
            color: "var(--text-muted)",
            background: "rgba(193, 154, 91, 0.06)",
            border: "1px solid rgba(193, 154, 91, 0.12)",
            borderRadius: 8,
            padding: "8px 10px",
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}>
            <span style={{ color: "var(--warning)", fontSize: 14 }}>⏳</span>
            <span>
              Includes <strong style={{ color: "var(--success)" }}>{(btcPending / 1e8).toFixed(8)} BTC</strong> unconfirmed.
              Spending unconfirmed funds is supported.
            </span>
          </div>
        )}
        <button
          className="btn btn-primary btn-full"
          disabled={!recipient || !amount}
          onClick={() => { setError(""); setStep(3); }}
        >
          Review
        </button>
      </>
    );
  }

  // Step 3: Review & confirm
  if (step === 3) {
    const meta = asset ? ASSET_META[asset] : ASSET_META.arch;
    return (
      <>
        <button className="btn btn-sm btn-secondary" onClick={() => setStep(2)} style={{ marginBottom: 12 }}>
          ← Back
        </button>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Review Transaction</h2>
        {error && <div className="error-banner">{error}</div>}
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">Asset</div>
            <div style={{ fontWeight: 600 }}>{meta.icon} {meta.label}</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">To</div>
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{recipient}</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">Amount</div>
            <div style={{ fontWeight: 600 }}>
              {asset === "btc" ? `${Number(amount) || 0} BTC`
                : asset === "arch" ? formatArch(amount)
                : selectedToken ? `${formatTokenAmount(Number(amount) || 0, selectedToken.decimals)} ${selectedToken.symbol || "APL"}`
                : amount}
            </div>
            {asset === "btc" && Number(amount) > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                {Math.round((Number(amount) || 0) * 1e8).toLocaleString()} sats
              </div>
            )}
          </div>
          {asset === "apl" && selectedToken && (
            <div>
              <div className="input-label">Token Mint</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{selectedToken.mint}</div>
            </div>
          )}
        </div>
        {asset === "btc" ? (
          <div style={{
            fontSize: 12,
            color: "var(--warning)",
            background: "rgba(230,168,23,0.08)",
            border: "1px solid rgba(230,168,23,0.2)",
            borderRadius: 8,
            padding: "10px 12px",
            textAlign: "center",
          }}>
            Native BTC sending requires PSBT construction and is coming soon.
            You can send ARCH and APL tokens now.
          </div>
        ) : (
          <button
            className="btn btn-primary btn-full"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? "Signing..." : "🔑 Confirm & Sign"}
          </button>
        )}
      </>
    );
  }

  // Step 4: Complete
  return (
    <>
      <div style={{ textAlign: "center", padding: "24px 0" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Transaction Sent!</h2>
        <div className="mono" style={{ wordBreak: "break-all", fontSize: 11, marginBottom: 16 }}>
          {txResult?.txid}
        </div>
        {asset !== "btc" && txResult?.rawTxid && (
          <a
            href={`${explorerBase}${txResult.rawTxid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm btn-secondary"
            style={{ marginBottom: 8, display: "inline-block" }}
          >
            View on Explorer →
          </a>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-secondary btn-full" onClick={resetFlow}>
          Send Another
        </button>
        <button className="btn btn-primary btn-full" onClick={() => navigate("/dashboard")}>
          Done
        </button>
      </div>
    </>
  );
}
