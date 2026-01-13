import { useMemo, useState } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";

function safeJson(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

function defaultEnv(key: string, fallback = ""): string {
  return (import.meta as any).env?.[key] ?? fallback;
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(defaultEnv("VITE_WALLET_HUB_BASE_URL", "http://localhost:3005/v1"));
  const [apiKey, setApiKey] = useState(defaultEnv("VITE_WALLET_HUB_API_KEY", ""));

  const client = useMemo(() => new WalletHubClient({ baseUrl, apiKey }), [baseUrl, apiKey]);

  const [portfolioAddress, setPortfolioAddress] = useState(defaultEnv("VITE_DEFAULT_PORTFOLIO_ADDRESS", ""));
  const [portfolioRes, setPortfolioRes] = useState<unknown | null>(null);
  const [portfolioErr, setPortfolioErr] = useState<string | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  const [externalUserId, setExternalUserId] = useState(defaultEnv("VITE_DEFAULT_EXTERNAL_USER_ID", "demo-user-1"));
  const [signerKind, setSignerKind] = useState<"turnkey" | "external">("turnkey");
  const [turnkeyResourceId, setTurnkeyResourceId] = useState(defaultEnv("VITE_DEFAULT_TURNKEY_RESOURCE_ID", ""));
  const [externalTaprootAddress, setExternalTaprootAddress] = useState("");

  const [actionType, setActionType] = useState<"arch.transfer" | "arch.anchor">("arch.transfer");
  const [toAddress, setToAddress] = useState(defaultEnv("VITE_DEFAULT_ARCH_TO_ADDRESS", ""));
  const [lamports, setLamports] = useState("1");
  const [btcTxid, setBtcTxid] = useState("");
  const [btcVout, setBtcVout] = useState(0);

  const [createRes, setCreateRes] = useState<unknown | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  const [signingRequestId, setSigningRequestId] = useState("");
  const [getRes, setGetRes] = useState<unknown | null>(null);
  const [getErr, setGetErr] = useState<string | null>(null);
  const [getLoading, setGetLoading] = useState(false);

  async function onFetchPortfolio() {
    setPortfolioLoading(true);
    setPortfolioErr(null);
    setPortfolioRes(null);
    try {
      const res = await client.getPortfolio(portfolioAddress);
      setPortfolioRes(res);
    } catch (e: any) {
      setPortfolioErr(String(e?.message ?? e));
    } finally {
      setPortfolioLoading(false);
    }
  }

  async function onCreateSigningRequest() {
    setCreateLoading(true);
    setCreateErr(null);
    setCreateRes(null);
    try {
      const signer =
        signerKind === "turnkey"
          ? { kind: "turnkey" as const, resourceId: turnkeyResourceId }
          : { kind: "external" as const, taprootAddress: externalTaprootAddress };

      const action =
        actionType === "arch.transfer"
          ? { type: "arch.transfer" as const, toAddress, lamports }
          : { type: "arch.anchor" as const, btcTxid, vout: btcVout };

      const res = await client.createSigningRequest({ externalUserId, signer, action });
      setCreateRes(res);
      const id = (res as any)?.signingRequestId;
      if (typeof id === "string") setSigningRequestId(id);
    } catch (e: any) {
      setCreateErr(String(e?.message ?? e));
    } finally {
      setCreateLoading(false);
    }
  }

  async function onGetSigningRequest() {
    setGetLoading(true);
    setGetErr(null);
    setGetRes(null);
    try {
      const res = await client.getSigningRequest(signingRequestId);
      setGetRes(res);
    } catch (e: any) {
      setGetErr(String(e?.message ?? e));
    } finally {
      setGetLoading(false);
    }
  }

  const readiness = (getRes as any)?.readiness as any;
  const readinessStatus = String(readiness?.status ?? "");
  const readinessClass =
    readinessStatus === "ready" ? "ok" : readinessStatus === "not_ready" ? "warn" : readinessStatus ? "bad" : "";

  return (
    <div className="container">
      <div className="header">
        <div className="title">Wallet Hub Demo Dapp</div>
        <div className="subtitle">
          Basic consumer app that hits Wallet Hub with a platform API key (no internal imports from the platform).
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Client config</h2>
        <div className="row">
          <label>Base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3005/v1" />
        </div>
        <div className="row">
          <label>X-API-Key</label>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="w_..." />
        </div>
        <div className="pill">
          <span>Using:</span> <code>{baseUrl}</code>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Portfolio</h2>
          <div className="row">
            <label>Address</label>
            <input
              value={portfolioAddress}
              onChange={(e) => setPortfolioAddress(e.target.value)}
              placeholder="tb1p... or Arch base58"
            />
          </div>
          <div className="actions">
            <button onClick={onFetchPortfolio} disabled={portfolioLoading || !portfolioAddress || !apiKey}>
              {portfolioLoading ? "Loading..." : "Fetch portfolio"}
            </button>
          </div>
          {portfolioErr ? (
            <div className="json">
              <pre className="bad">{portfolioErr}</pre>
            </div>
          ) : null}
          {portfolioRes ? (
            <div className="json">
              <pre>{safeJson(portfolioRes)}</pre>
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>Create signing request</h2>
          <div className="row">
            <label>externalUserId</label>
            <input value={externalUserId} onChange={(e) => setExternalUserId(e.target.value)} />
          </div>
          <div className="row">
            <label>Signer kind</label>
            <select value={signerKind} onChange={(e) => setSignerKind(e.target.value as any)}>
              <option value="turnkey">turnkey</option>
              <option value="external">external</option>
            </select>
          </div>
          {signerKind === "turnkey" ? (
            <div className="row">
              <label>Turnkey resourceId</label>
              <input value={turnkeyResourceId} onChange={(e) => setTurnkeyResourceId(e.target.value)} />
            </div>
          ) : (
            <div className="row">
              <label>Taproot address</label>
              <input
                value={externalTaprootAddress}
                onChange={(e) => setExternalTaprootAddress(e.target.value)}
                placeholder="tb1p..."
              />
            </div>
          )}

          <div className="row">
            <label>Action</label>
            <select value={actionType} onChange={(e) => setActionType(e.target.value as any)}>
              <option value="arch.transfer">arch.transfer</option>
              <option value="arch.anchor">arch.anchor</option>
            </select>
          </div>

          {actionType === "arch.transfer" ? (
            <>
              <div className="row">
                <label>toAddress (Arch)</label>
                <input value={toAddress} onChange={(e) => setToAddress(e.target.value)} placeholder="base58 pubkey" />
              </div>
              <div className="row">
                <label>lamports</label>
                <input value={lamports} onChange={(e) => setLamports(e.target.value)} />
              </div>
            </>
          ) : (
            <>
              <div className="row">
                <label>btcTxid</label>
                <input value={btcTxid} onChange={(e) => setBtcTxid(e.target.value)} placeholder="64-hex txid" />
              </div>
              <div className="row">
                <label>vout</label>
                <input
                  type="number"
                  value={btcVout}
                  onChange={(e) => setBtcVout(Number(e.target.value))}
                  min={0}
                />
              </div>
            </>
          )}

          <div className="actions">
            <button
              onClick={onCreateSigningRequest}
              disabled={
                createLoading ||
                !apiKey ||
                !externalUserId ||
                (signerKind === "turnkey" ? !turnkeyResourceId : !externalTaprootAddress) ||
                (actionType === "arch.transfer" ? !toAddress || !lamports : !btcTxid)
              }
            >
              {createLoading ? "Creating..." : "Create signing request"}
            </button>
          </div>

          {createErr ? (
            <div className="json">
              <pre className="bad">{createErr}</pre>
            </div>
          ) : null}
          {createRes ? (
            <div className="json">
              <pre>{safeJson(createRes)}</pre>
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>Poll signing request status</h2>
          <div className="row">
            <label>signingRequestId</label>
            <input value={signingRequestId} onChange={(e) => setSigningRequestId(e.target.value)} />
          </div>
          <div className="actions">
            <button onClick={onGetSigningRequest} disabled={getLoading || !apiKey || !signingRequestId}>
              {getLoading ? "Loading..." : "Fetch status"}
            </button>
            {readinessStatus ? (
              <div className={`pill ${readinessClass}`}>
                readiness: <strong>{readinessStatus}</strong>
                {readiness?.reason ? <span>({String(readiness.reason)})</span> : null}
              </div>
            ) : null}
          </div>

          {getErr ? (
            <div className="json">
              <pre className="bad">{getErr}</pre>
            </div>
          ) : null}
          {getRes ? (
            <div className="json">
              <pre>{safeJson(getRes)}</pre>
            </div>
          ) : null}
        </div>

        <div className="card">
          <h2>Notes</h2>
          <div className="subtitle" style={{ lineHeight: 1.5 }}>
            This app is intentionally “dumb”: it just demonstrates the platform contract. In a real dapp you’d wrap these
            calls in your own state machine and render the Wallet Hub signing preview UI.
          </div>
          <div className="subtitle" style={{ marginTop: 10, lineHeight: 1.5 }}>
            For Turnkey signing requests, you’ll typically create/select a Turnkey embedded wallet first, then pass its
            <code>resourceId</code> here.
          </div>
        </div>
      </div>
    </div>
  );
}

