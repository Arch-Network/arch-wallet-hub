/**
 * Import a BIP39 seed into the user's existing Turnkey wallet.
 *
 * The words are typed into https://import.turnkey.com. This page receives
 * only the ciphertext Turnkey's enclave can open, then registers the
 * resulting Taproot address as another Arch account approved with the
 * same passkey or email.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IframeStamper } from "@turnkey/iframe-stamper";
import { useWallet } from "../../hooks/useWallet";
import { walletStore } from "../../state/wallet-store";
import { sessionManager } from "../../session/SessionManager";
import {
  EmailSessionNeededError,
  ensureSigningSessionForAccount,
} from "../../session/ensure-signing-session";
import SessionBootstrapper from "../../session/SessionBootstrapper";
import BackBar from "../../components/BackBar";
import { isTurnkeyAccount, type WalletAccount } from "../../state/types";
import { importHostAccount, bitcoinTaprootAccount } from "../../crypto/turnkey-material";
import {
  TURNKEY_IMPORT_IFRAME_URL,
  finishSeedImport,
  prepareSeedImport,
} from "../../crypto/turnkey-key-ops";
import { deriveArchAccountAddress, getClient, getExternalUserId } from "../../utils/sdk";
import { ensureHubSession } from "../../utils/hub-session";
import { readHubToken } from "../../utils/hub-session-store";
import { isInSidePanel, openWalletPopup } from "../../utils/runtime-context";

interface ImportedKey {
  address: string;
  publicKeyHex: string;
}

function frameStyles(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    width: "100%",
    color: value("--text-primary", "#111111"),
    backgroundColor: value("--surface-card", "#ffffff"),
    borderColor: value("--border-field", "#cccccc"),
    borderRadius: "8px",
    fontSize: "14px",
    padding: "8px",
  };
}

export default function ImportWallet() {
  const navigate = useNavigate();
  const { state } = useWallet();
  const host = useMemo(
    () => importHostAccount(state.accounts, state.activeAccountId),
    [state.accounts, state.activeAccountId],
  );
  const [label, setLabel] = useState("Imported wallet");
  const [acknowledged, setAcknowledged] = useState(false);
  const [phase, setPhase] = useState<"intro" | "preparing" | "ready" | "saving">("intro");
  const [error, setError] = useState<string | null>(null);
  const [otpAccount, setOtpAccount] = useState<WalletAccount | null>(null);
  const [pending, setPending] = useState<ImportedKey | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const stamperRef = useRef<IframeStamper | null>(null);
  const userIdRef = useRef<string | null>(null);
  const resumeRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    return () => {
      stamperRef.current?.clear();
      stamperRef.current = null;
    };
  }, []);

  const spec = bitcoinTaprootAccount(state.network);
  const authLabel = host?.authMethod === "email" ? "email code" : "passkey";

  const save = async (imported: ImportedKey, target: WalletAccount) => {
    if (state.accounts.some((account) => account.btcAddress === imported.address)) {
      throw new Error("That address is already in this wallet.");
    }
    const trimmed = label.trim();
    if (!trimmed) throw new Error("Name the wallet before importing.");
    const authMethod = target.authMethod === "email" ? "email" : "passkey";
    await ensureHubSession(target, state.network);
    const client = await getClient();
    const token = await readHubToken(await getExternalUserId(), target.id);
    if (token) client.setSessionToken(token);
    const registered = await client.registerExistingPasskeyWallet({
      externalUserId: await getExternalUserId(),
      organizationId: target.organizationId,
      defaultAddress: imported.address,
      defaultPublicKeyHex: imported.publicKeyHex,
      label: trimmed,
      authMethod,
      derivationPath: spec.path,
      addressFormat: spec.addressFormat,
    });
    await walletStore.addAccount({
      id: registered.resourceId,
      label: trimmed,
      btcAddress: imported.address,
      publicKeyHex: imported.publicKeyHex,
      archAddress: deriveArchAccountAddress(imported.publicKeyHex),
      kind: "turnkey",
      turnkeyResourceId: registered.resourceId,
      organizationId: registered.organizationId,
      authMethod,
      passkeyCredentialId: target.passkeyCredentialId,
      recoveryEmail: target.recoveryEmail,
      createdAt: Date.now(),
    });
    navigate("/dashboard");
  };

  const openFrame = async () => {
    if (!host || !isTurnkeyAccount(host)) return;
    setError(null);
    setPending(null);
    const target = host;
    try {
      const existing = await sessionManager.ensureClient(target.id);
      if (!existing && target.authMethod === "passkey" && isInSidePanel()) {
        await openWalletPopup({ path: "/import" });
        setError("Continue in the popup window. The side panel can't show the passkey prompt.");
        return;
      }
      await ensureSigningSessionForAccount(target);
      const client = await sessionManager.ensureClient(target.id);
      if (!client) throw new Error("Signing session didn't open. Unlock the wallet and try again.");
      const container = frameRef.current;
      if (!container) throw new Error("Could not open the secure page.");
      container.hidden = false;
      stamperRef.current?.clear();
      const stamper = new IframeStamper({
        iframeUrl: TURNKEY_IMPORT_IFRAME_URL,
        iframeElementId: "turnkey-import-iframe",
        iframeContainer: container,
      });
      stamperRef.current = stamper;
      setPhase("preparing");
      userIdRef.current = await prepareSeedImport(client, stamper, {
        organizationId: target.organizationId,
        styles: frameStyles(),
      });
      setPhase("ready");
    } catch (err) {
      stamperRef.current?.clear();
      stamperRef.current = null;
      userIdRef.current = null;
      setPhase("intro");
      if (err instanceof EmailSessionNeededError) {
        resumeRef.current = openFrame;
        setOtpAccount(target);
        return;
      }
      setError(err instanceof Error ? err.message : "Could not start the import.");
    }
  };

  const commit = async () => {
    if (!host || !stamperRef.current || !userIdRef.current) return;
    setError(null);
    setPhase("saving");
    const target = host;
    try {
      const client = await sessionManager.ensureClient(target.id);
      if (!client) throw new Error("Signing session expired. Start the import again.");
      const imported = pending ?? await finishSeedImport(client, stamperRef.current, {
        organizationId: target.organizationId,
        userId: userIdRef.current,
        walletName: `arch-import-${Date.now().toString(36)}`,
        network: state.network,
      });
      setPending(imported);
      await save(imported, target);
    } catch (err) {
      setPhase("ready");
      setError(err instanceof Error ? err.message : "Could not import this wallet.");
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
            void resumeRef.current?.();
          }}
          onCancel={() => setOtpAccount(null)}
        />
      </>
    );
  }

  if (!host) {
    return (
      <>
        <BackBar onBack={() => navigate("/settings")} />
        <div className="page-header" style={{ marginBottom: 16 }}>
          <h2 className="page-title">Import a seed</h2>
          <div className="page-subtitle">
            A seed is stored in a passkey or email wallet. Create one of those first
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-full" onClick={() => navigate("/add-wallet")}>
          Create a wallet
        </button>
      </>
    );
  }

  const networkLabel = state.network === "mainnet" ? "mainnet" : "testnet4";

  return (
    <>
      <BackBar onBack={() => navigate("/settings")} disabled={phase === "saving"} />
      <div className="page-header" style={{ marginBottom: 16 }}>
        <h2 className="page-title">Import a seed</h2>
        <div className="page-subtitle">
          First Taproot address at {spec.path} on {networkLabel}. Approved with the {authLabel} on {host.label}
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <label className="input-label" htmlFor="import-label">Name</label>
        <input
          id="import-label"
          className="input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={phase === "saving"}
          maxLength={40}
        />
        <label className="key-material-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            disabled={phase === "saving"}
          />
          <span>The phrase stays in Turnkey. Arch does not read it</span>
        </label>
        <div
          ref={frameRef}
          className="key-material-frame key-material-frame-import"
          hidden={phase === "intro"}
        />
      </div>
      {error && <div className="error-banner">{error}</div>}
      {phase === "intro" ? (
        <button
          type="button"
          className="btn btn-primary btn-full"
          onClick={() => void openFrame()}
          disabled={!acknowledged || label.trim().length === 0}
        >
          Continue
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-full"
          onClick={() => void commit()}
          disabled={phase === "preparing" || phase === "saving"}
        >
          {phase === "preparing" ? "Opening…" : phase === "saving" ? "Importing…" : pending ? "Save wallet" : "Import"}
        </button>
      )}
    </>
  );
}
