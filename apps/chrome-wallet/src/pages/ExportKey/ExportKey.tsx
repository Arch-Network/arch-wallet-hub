/**
 * Show a Turnkey wallet's seed phrase or account private key.
 *
 * The secret is decrypted inside https://export.turnkey.com. This page
 * stamps the export with the user's signing session and never reads the
 * plaintext.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { IframeStamper } from "@turnkey/iframe-stamper";
import { useWallet } from "../../hooks/useWallet";
import { sessionManager } from "../../session/SessionManager";
import {
  EmailSessionNeededError,
  ensureSigningSessionForAccount,
} from "../../session/ensure-signing-session";
import SessionBootstrapper from "../../session/SessionBootstrapper";
import BackBar from "../../components/BackBar";
import { isTurnkeyAccount, type WalletAccount } from "../../state/types";
import { isInSidePanel, openWalletPopup } from "../../utils/runtime-context";
import {
  TURNKEY_EXPORT_IFRAME_URL,
  revealAccountKey,
  revealSeedPhrase,
} from "../../crypto/turnkey-key-ops";

type Material = "seed" | "key";

function materialFromParam(value: string | null): Material | null {
  if (value === "seed" || value === "key") return value;
  return null;
}

export default function ExportKey() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const material = materialFromParam(params.get("material"));
  const { activeAccount, state } = useWallet();
  const [acknowledged, setAcknowledged] = useState(false);
  const [phase, setPhase] = useState<"intro" | "working" | "revealed">("intro");
  const [error, setError] = useState<string | null>(null);
  const [otpAccount, setOtpAccount] = useState<WalletAccount | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stamperRef = useRef<IframeStamper | null>(null);
  const revealAgain = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    return () => {
      stamperRef.current?.clear();
      stamperRef.current = null;
    };
  }, []);

  const hide = () => {
    stamperRef.current?.clear();
    stamperRef.current = null;
    setPhase("intro");
  };

  const reveal = async () => {
    if (!activeAccount || !isTurnkeyAccount(activeAccount) || !material) return;
    setError(null);
    setPhase("working");
    const account = activeAccount;
    try {
      const existing = await sessionManager.ensureClient(account.id);
      if (!existing && account.authMethod === "passkey" && isInSidePanel()) {
        await openWalletPopup({
          path: "/export",
          query: { material },
        });
        setPhase("intro");
        setError("Continue in the popup window. The side panel can't show the passkey prompt.");
        return;
      }
      await ensureSigningSessionForAccount(account);
      const client = await sessionManager.ensureClient(account.id);
      if (!client) throw new Error("Signing session didn't open. Unlock the wallet and try again.");
      const container = frameRef.current;
      if (!container) throw new Error("Could not open the secure page.");
      container.hidden = false;
      stamperRef.current?.clear();
      const stamper = new IframeStamper({
        iframeUrl: TURNKEY_EXPORT_IFRAME_URL,
        iframeElementId: "turnkey-export-iframe",
        iframeContainer: container,
      });
      stamperRef.current = stamper;
      const args = {
        organizationId: account.organizationId,
        address: account.btcAddress,
      };
      if (material === "seed") {
        await revealSeedPhrase(client, stamper, args);
      } else {
        await revealAccountKey(client, stamper, { ...args, network: state.network });
      }
      setPhase("revealed");
    } catch (err) {
      stamperRef.current?.clear();
      stamperRef.current = null;
      if (err instanceof EmailSessionNeededError) {
        revealAgain.current = reveal;
        setOtpAccount(account);
        setPhase("intro");
        return;
      }
      setPhase("intro");
      setError(err instanceof Error ? err.message : "Could not export this wallet.");
    }
  };

  if (otpAccount) {
    return (
      <>
        <BackBar onBack={() => setOtpAccount(null)} title="Verify email" />
        <SessionBootstrapper
          account={otpAccount}
          onReady={() => {
            setOtpAccount(null);
            void revealAgain.current?.();
          }}
          onCancel={() => setOtpAccount(null)}
        />
      </>
    );
  }

  if (!activeAccount || !isTurnkeyAccount(activeAccount)) {
    return (
      <>
        <BackBar onBack={() => navigate("/settings")} />
        <div className="page-header" style={{ marginBottom: 16 }}>
          <h2 className="page-title">Export</h2>
          <div className="page-subtitle">
            Passkey and email wallets only. A linked wallet keeps its keys where it was created
          </div>
        </div>
      </>
    );
  }

  const noun = material === "key" ? "private key" : "seed phrase";
  const title = material === "key" ? "Private key" : material === "seed" ? "Seed phrase" : "Export";

  return (
    <>
      <BackBar onBack={() => navigate(material ? "/export" : "/settings")} disabled={phase === "working"} />
      <div className="page-header" style={{ marginBottom: 16 }}>
        <h2 className="page-title">{title}</h2>
        <div className="page-subtitle">
          {material
            ? `Anyone with this ${noun} can spend this address`
            : "Take this wallet to another device"}
        </div>
      </div>

      {!material && (
        <div className="card">
          <button type="button" className="key-material-choice" onClick={() => navigate("/export?material=seed")}>
            Seed phrase
            <span>12 words for the whole wallet</span>
          </button>
          <button type="button" className="key-material-choice" onClick={() => navigate("/export?material=key")}>
            Private key
            <span>WIF for this Taproot address</span>
          </button>
        </div>
      )}

      {material && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="input-label">Address</div>
            <div className="mono" style={{ fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
              {activeAccount.btcAddress}
            </div>
            <label className="key-material-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                disabled={phase === "working"}
              />
              <span>I can spend this wallet with the {noun}, and Arch never sees it</span>
            </label>
            <div ref={frameRef} className="key-material-frame" hidden={phase === "intro"} />
          </div>
          {error && <div className="error-banner">{error}</div>}
          {phase === "revealed" ? (
            <button type="button" className="btn btn-secondary btn-full" onClick={hide}>
              Hide
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-full"
              onClick={() => void reveal()}
              disabled={!acknowledged || phase === "working"}
            >
              {phase === "working" ? "Opening…" : `Show ${noun}`}
            </button>
          )}
        </>
      )}
    </>
  );
}
