import { useMemo, useState } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import { Turnkey, SessionType } from "@turnkey/sdk-browser";

function safeJson(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

function makeIdempotencyKey() {
  // Wallet Hub requires Idempotency-Key for Turnkey wallet creation.
  // Use crypto.randomUUID when available; fallback to a simple random token.
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

  const [submitSig64Hex, setSubmitSig64Hex] = useState("");
  const [submitActivityId, setSubmitActivityId] = useState("");
  const [submitRes, setSubmitRes] = useState<unknown | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);

  const [signingRequestId, setSigningRequestId] = useState("");
  const [getRes, setGetRes] = useState<unknown | null>(null);
  const [getErr, setGetErr] = useState<string | null>(null);
  const [getLoading, setGetLoading] = useState(false);

  const [turnkeyCreateRes, setTurnkeyCreateRes] = useState<unknown | null>(null);
  const [turnkeyCreateErr, setTurnkeyCreateErr] = useState<string | null>(null);
  const [turnkeyCreateLoading, setTurnkeyCreateLoading] = useState(false);
  const [walletName, setWalletName] = useState("");
  const [turnkeyPasskeyReady, setTurnkeyPasskeyReady] = useState(false);
  const [turnkeyPasskeyErr, setTurnkeyPasskeyErr] = useState<string | null>(null);
  const [turnkeySignLoading, setTurnkeySignLoading] = useState(false);
  const [turnkeySignRes, setTurnkeySignRes] = useState<unknown | null>(null);

  const [turnkeyApiBaseUrl, setTurnkeyApiBaseUrl] = useState(
    defaultEnv("VITE_TURNKEY_API_BASE_URL", "https://api.turnkey.com")
  );
  const [turnkeyParentOrgId, setTurnkeyParentOrgId] = useState(
    defaultEnv("VITE_TURNKEY_PARENT_ORGANIZATION_ID", "")
  );
  const [turnkeyRpId, setTurnkeyRpId] = useState(
    defaultEnv(
      "VITE_TURNKEY_RP_ID",
      window.location.hostname === "127.0.0.1" ? "localhost" : window.location.hostname
    )
  );

  const [polling, setPolling] = useState(false);
  const [pollEveryMs, setPollEveryMs] = useState(2000);

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

  async function onCreateTurnkeyWallet() {
    setTurnkeyCreateLoading(true);
    setTurnkeyCreateErr(null);
    setTurnkeyCreateRes(null);
    try {
      const idempotencyKey = makeIdempotencyKey();
      const res = await client.createTurnkeyWallet({
        idempotencyKey,
        body: {
          externalUserId,
          walletName: walletName || undefined
        }
      });
      setTurnkeyCreateRes(res);
      if (typeof (res as any)?.resourceId === "string") setTurnkeyResourceId((res as any).resourceId);
      const defaultAddr = (res as any)?.defaultAddress as string | null | undefined;
      if (defaultAddr && !portfolioAddress) setPortfolioAddress(defaultAddr);
    } catch (e: any) {
      setTurnkeyCreateErr(String(e?.message ?? e));
    } finally {
      setTurnkeyCreateLoading(false);
    }
  }

  const turnkey = useMemo(() => {
    if (!turnkeyParentOrgId) return null;
    return new Turnkey({
      apiBaseUrl: turnkeyApiBaseUrl,
      defaultOrganizationId: turnkeyParentOrgId,
      rpId: turnkeyRpId
    });
  }, [turnkeyApiBaseUrl, turnkeyParentOrgId, turnkeyRpId]);

  async function onCreatePasskeyWallet() {
    setTurnkeyCreateLoading(true);
    setTurnkeyCreateErr(null);
    setTurnkeyCreateRes(null);
    setTurnkeyPasskeyErr(null);
    setTurnkeyPasskeyReady(false);
    try {
      if (!turnkey) throw new Error("Missing Turnkey config (set VITE_TURNKEY_PARENT_ORGANIZATION_ID)");

      const passkeyClient = turnkey.passkeyClient();
      const { encodedChallenge, attestation } =
        (await passkeyClient.createUserPasskey({
          publicKey: {
            rp: { id: turnkeyRpId, name: "Wallet Hub Demo" },
            user: { name: externalUserId, displayName: externalUserId }
          }
        })) || ({} as any);

      if (!encodedChallenge || !attestation) throw new Error("Failed to create passkey attestation");

      const idempotencyKey = makeIdempotencyKey();
      const res = await client.createTurnkeyPasskeyWallet({
        idempotencyKey,
        body: {
          externalUserId,
          walletName: walletName || undefined,
          passkey: { challenge: encodedChallenge, attestation }
        }
      });

      setTurnkeyCreateRes(res);
      if (typeof (res as any)?.resourceId === "string") setTurnkeyResourceId((res as any).resourceId);
      const defaultAddr = (res as any)?.defaultAddress as string | null | undefined;
      if (defaultAddr && !portfolioAddress) setPortfolioAddress(defaultAddr);
      setTurnkeyPasskeyReady(true);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("NotAllowedError")) {
        // User canceled passkey prompt; avoid stuck state.
        window.location.reload();
        return;
      }
      setTurnkeyCreateErr(msg);
    } finally {
      setTurnkeyCreateLoading(false);
    }
  }

  async function onPasskeyLogin() {
    setTurnkeyPasskeyErr(null);
    setTurnkeyPasskeyReady(false);
    try {
      if (!turnkey) throw new Error("Missing Turnkey config (set VITE_TURNKEY_PARENT_ORGANIZATION_ID)");
      const indexedDbClient = await turnkey.indexedDbClient();
      const passkeyClient = turnkey.passkeyClient();

      await indexedDbClient.resetKeyPair();
      const publicKey = await indexedDbClient.getPublicKey();
      await passkeyClient.loginWithPasskey({ sessionType: SessionType.READ_WRITE, publicKey });
      setTurnkeyPasskeyReady(true);
    } catch (e: any) {
      setTurnkeyPasskeyErr(String(e?.message ?? e));
    }
  }

  async function onTurnkeySignPayloadAndSubmit() {
    setTurnkeySignLoading(true);
    setTurnkeySignRes(null);
    setSubmitErr(null);
    try {
      if (!turnkey) throw new Error("Missing Turnkey config");
      if (!signingRequestId) throw new Error("Missing signingRequestId");
      if (!turnkeyResourceId) throw new Error("Missing Turnkey resourceId");

      // Fetch org id for this wallet resource (sub-org)
      const walletMeta = await client.getTurnkeyWallet({ resourceId: turnkeyResourceId, externalUserId });
      const organizationId = walletMeta.organizationId;

      // Get signing request payload
      const sr = await client.getSigningRequest(signingRequestId);
      const p: any = (sr as any).payloadToSign;
      if (p?.kind !== "taproot_sighash_hex") throw new Error(`Unexpected payloadToSign.kind: ${String(p?.kind)}`);

      const indexedDbClient = await turnkey.indexedDbClient();
      const reqBody = {
        type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        timestampMs: String(Date.now()),
        organizationId,
        parameters: {
          signWith: String(p.signWith),
          payload: String(p.payloadHex),
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP"
        }
      };

      const resp: any = await indexedDbClient.signRawPayload(reqBody);
      const r = resp?.activity?.result?.signRawPayloadResult?.r;
      const s = resp?.activity?.result?.signRawPayloadResult?.s;
      const activityId = resp?.activity?.id ?? null;
      if (!r || !s) throw new Error("Turnkey signRawPayload did not return r/s");

      const signature64Hex = `${r}${s}`;
      setTurnkeySignRes({ activityId, signature64Hex });

      const submit = await client.submitSigningRequest(signingRequestId, {
        externalUserId,
        signature64Hex,
        turnkeyActivityId: activityId ?? undefined
      });
      setSubmitRes(submit);
    } catch (e: any) {
      setSubmitErr(String(e?.message ?? e));
    } finally {
      setTurnkeySignLoading(false);
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

  async function onSubmitSignature() {
    setSubmitLoading(true);
    setSubmitErr(null);
    setSubmitRes(null);
    try {
      const res = await client.submitSigningRequest(signingRequestId, {
        externalUserId,
        signature64Hex: submitSig64Hex || undefined,
        turnkeyActivityId: submitActivityId || undefined
      });
      setSubmitRes(res);
    } catch (e: any) {
      setSubmitErr(String(e?.message ?? e));
    } finally {
      setSubmitLoading(false);
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

  async function onStartPolling() {
    if (!signingRequestId) return;
    setPolling(true);
    setGetErr(null);
    try {
      while (true) {
        const res = await client.getSigningRequest(signingRequestId);
        setGetRes(res);
        const status = String((res as any)?.readiness?.status ?? "");
        if (status === "ready") break;
        await new Promise((r) => setTimeout(r, Math.max(250, pollEveryMs)));
        if (!(globalThis as any).__walletHubPoll) break;
      }
    } catch (e: any) {
      setGetErr(String(e?.message ?? e));
    } finally {
      setPolling(false);
      (globalThis as any).__walletHubPoll = false;
    }
  }

  function onStopPolling() {
    (globalThis as any).__walletHubPoll = false;
    setPolling(false);
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
          <h2>Embedded wallet (Turnkey)</h2>
          <div className="row">
            <label>externalUserId</label>
            <input value={externalUserId} onChange={(e) => setExternalUserId(e.target.value)} />
          </div>
          <div className="row">
            <label>walletName (optional)</label>
            <input value={walletName} onChange={(e) => setWalletName(e.target.value)} placeholder="demo-wallet" />
          </div>
          <div className="actions">
            <button onClick={onCreateTurnkeyWallet} disabled={turnkeyCreateLoading || !apiKey || !externalUserId}>
              {turnkeyCreateLoading ? "Creating..." : "Create Turnkey wallet (custodial demo)"}
            </button>
            <button
              onClick={onCreatePasskeyWallet}
              disabled={turnkeyCreateLoading || !apiKey || !externalUserId || !turnkeyParentOrgId}
            >
              {turnkeyCreateLoading ? "Creating..." : "Create passkey wallet (non-custodial)"}
            </button>
            {turnkeyResourceId ? (
              <div className="pill">
                resourceId: <code>{turnkeyResourceId}</code>
              </div>
            ) : null}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <label>Turnkey API baseUrl</label>
            <input value={turnkeyApiBaseUrl} onChange={(e) => setTurnkeyApiBaseUrl(e.target.value)} />
          </div>
          <div className="row">
            <label>Turnkey parent orgId</label>
            <input value={turnkeyParentOrgId} onChange={(e) => setTurnkeyParentOrgId(e.target.value)} />
          </div>
          <div className="row">
            <label>Passkey RP ID</label>
            <input value={turnkeyRpId} onChange={(e) => setTurnkeyRpId(e.target.value)} />
          </div>
          <div className="actions">
            <button onClick={onPasskeyLogin} disabled={!turnkeyParentOrgId}>
              Passkey login
            </button>
            {turnkeyPasskeyReady ? <div className="pill ok">passkey session: ready</div> : <div className="pill">passkey session: not logged in</div>}
          </div>
          {turnkeyPasskeyErr ? (
            <div className="json">
              <pre className="bad">{turnkeyPasskeyErr}</pre>
            </div>
          ) : null}
          {turnkeyCreateErr ? (
            <div className="json">
              <pre className="bad">{turnkeyCreateErr}</pre>
            </div>
          ) : null}
          {turnkeyCreateRes ? (
            <div className="json">
              <pre>{safeJson(turnkeyCreateRes)}</pre>
            </div>
          ) : null}
        </div>

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
          <h2>Submit user signature (non-custodial)</h2>
          <div className="subtitle" style={{ lineHeight: 1.5 }}>
            Wallet Hub no longer signs server-side. Use Turnkey (passkey) in the client to sign the
            <code>payloadToSign.payloadHex</code> with <code>signWith</code> (the Taproot address), then paste the
            64-byte signature hex (r||s) here.
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <label>signature64Hex</label>
            <input
              value={submitSig64Hex}
              onChange={(e) => setSubmitSig64Hex(e.target.value)}
              placeholder="128 hex chars (r||s)"
            />
          </div>
          <div className="row">
            <label>turnkeyActivityId (optional)</label>
            <input value={submitActivityId} onChange={(e) => setSubmitActivityId(e.target.value)} />
          </div>
          <div className="actions">
            <button
              onClick={onSubmitSignature}
              disabled={submitLoading || !apiKey || !signingRequestId || !externalUserId || submitSig64Hex.length !== 128}
            >
              {submitLoading ? "Submitting..." : "Submit signature"}
            </button>
            <button
              onClick={onTurnkeySignPayloadAndSubmit}
              disabled={
                turnkeySignLoading ||
                !turnkeyPasskeyReady ||
                !turnkeyResourceId ||
                !signingRequestId ||
                !apiKey
              }
            >
              {turnkeySignLoading ? "Signing..." : "Sign with passkey (Turnkey) + submit"}
            </button>
          </div>
          {turnkeySignRes ? (
            <div className="json">
              <pre>{safeJson(turnkeySignRes)}</pre>
            </div>
          ) : null}
          {submitErr ? (
            <div className="json">
              <pre className="bad">{submitErr}</pre>
            </div>
          ) : null}
          {submitRes ? (
            <div className="json">
              <pre>{safeJson(submitRes)}</pre>
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
            <button
              onClick={() => {
                (globalThis as any).__walletHubPoll = true;
                void onStartPolling();
              }}
              disabled={polling || !apiKey || !signingRequestId}
            >
              {polling ? "Polling..." : "Auto-poll until ready"}
            </button>
            <button onClick={onStopPolling} disabled={!polling}>
              Stop
            </button>
            <span className="pill">
              poll ms:{" "}
              <input
                style={{ width: 100, padding: "6px 8px" }}
                type="number"
                min={250}
                value={pollEveryMs}
                onChange={(e) => setPollEveryMs(Number(e.target.value))}
              />
            </span>
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
