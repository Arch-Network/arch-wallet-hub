/**
 * Approve modal for dapp-initiated requests.
 *
 * Phases hardened in this rewrite:
 *   - 1.5  SIGN_PSBT support (decode, render summary, sign).
 *   - 1.6  SIGN_MESSAGE humanization.
 *   - 1.7  Dapp identity strip + per-origin account picker.
 *   - 2.2  Risk banner + balance-after preview hooks (data plumbed
 *           through `useDashboardData`; visual surfaces are minimal
 *           until icons and copy land).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { walletStore } from "../../state/wallet-store";
import { getClient, getExternalUserId, formatWalletHubError } from "../../utils/sdk";
import { truncateAddress, formatArch } from "../../utils/format";
import DappHeader from "../../components/Approve/DappHeader";
import { interpretMessage } from "../../utils/sign-message";
import { summarizePsbt, formatSats, type PsbtSummary } from "../../utils/psbt-summary";
import { signerForAccount } from "../../signers/Signer";
import { isExternalAccount, type NetworkId, type WalletAccount } from "../../state/types";
import { getExternalWalletAdapter } from "../../wallets/external-wallets";

interface RequestDetails {
  type: string;
  origin: string;
  payload?: any;
  dappName?: string;
  dappIconUrl?: string;
  autoApproveAllowed?: boolean;
}

// Returns the raw `result` object from the Hub so callers can pick the field they need
async function signAndSubmitRequest(
  activeAccount: WalletAccount,
  signingRequestId: string,
  payloadToSign: any,
  externalUserId: string,
  network: NetworkId,
): Promise<any> {
  const client = await getClient();

  if (isExternalAccount(activeAccount)) {
    const psbtBase64 = payloadToSign?.psbtBase64;
    if (!psbtBase64) throw new Error("No PSBT available for external wallet signing");
    const adapter = getExternalWalletAdapter(activeAccount.externalProvider);
    const signature64Hex = await adapter.signPsbt({
      address: activeAccount.btcAddress,
      psbtBase64,
      network,
    });
    const submitRes = await client.submitSigningRequest(signingRequestId, {
      externalUserId,
      signature64Hex,
    });
    return (submitRes as any).result ?? submitRes;
  }

  const payloadHex = payloadToSign?.payloadHex;
  if (!payloadHex) throw new Error("No payload available for signing");

  // Both passkey and email wallets sign locally with the
  // session-stamped signer now -- which path bootstrapped the
  // session (WebAuthn vs OTP) is invisible at this layer. The Hub
  // is informed via /submit but never sees signing material.
  const signer = signerForAccount(activeAccount);
  const { signature64Hex } = await signer.signArchPayload({
    signingRequestId,
    payloadHex,
  });
  const submitRes = await client.submitSigningRequest(signingRequestId, {
    externalUserId,
    signature64Hex,
  });
  return (submitRes as any).result ?? submitRes;
}

function extractTxid(result: any, fallbackId: string): string {
  return result?.txid || result?.txidHex || fallbackId;
}

function MessageSummary({ payload, origin }: { payload: any; origin: string }) {
  const messageHex: string = payload?.message ?? "";
  const summary = useMemo(() => interpretMessage(messageHex, origin), [messageHex, origin]);
  const [showHex, setShowHex] = useState(false);

  return (
    <div className="card">
      <div style={{ marginBottom: 8 }}>
        <div className="input-label">Action</div>
        <div style={{ fontWeight: 600 }}>Sign Message</div>
      </div>

      {summary.kind === "binary" && (
        <>
          <div className="approve-risk approve-risk-warn" style={{ marginBottom: 8 }}>
            Binary payload — you are blind-signing raw bytes. {summary.reason}.
          </div>
          <div className="input-label">Hex</div>
          <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
            {summary.hex}
          </div>
        </>
      )}

      {summary.kind === "text" && (
        <>
          <div className="input-label">Message</div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, marginBottom: 8 }}>{summary.text}</div>
          <button className="btn-link" onClick={() => setShowHex((v) => !v)} style={{ background: "none", border: "none", padding: 0, color: "var(--text-muted)", fontSize: 11, textDecoration: "underline" }}>
            {showHex ? "Hide hex" : "Show hex"}
          </button>
          {showHex && (
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 10, marginTop: 6, color: "var(--text-muted)" }}>
              {summary.hex}
            </div>
          )}
        </>
      )}

      {summary.kind === "json" && (
        <>
          <div className="input-label">Structured payload</div>
          <pre style={{ background: "var(--bg-secondary)", padding: 8, borderRadius: 6, fontSize: 11, overflowX: "auto" }}>
            {JSON.stringify(summary.json, null, 2)}
          </pre>
        </>
      )}

      {summary.kind === "structured" && (
        <>
          {summary.domainMismatch && (
            <div className="approve-risk approve-risk-danger" style={{ marginBottom: 8 }}>
              Domain mismatch: this site claims to be <strong>{summary.domainMismatch.expected}</strong> but the message references <strong>{summary.domainMismatch.got}</strong>.
            </div>
          )}
          <div className="input-label">Message</div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{summary.text}</div>
          {summary.url && (
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
              Embedded URL: {summary.url}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Render the approval card for SIGN_ARCH_MESSAGE_HASH.
 *
 * This is always a blind-sign from the wallet's perspective: we hold
 * a 32-byte transaction-message hash with no decoded instructions to
 * preview. The dapp is responsible for showing a human-readable
 * preview in its own UI; the user's job here is to confirm (a) the
 * dapp origin in the header above and (b) that the hash shown here
 * matches what the dapp claims to be signing.
 */
function ArchMessageHashSummary({ payload }: { payload: any }) {
  const messageHashHex: string = payload?.messageHashHex ?? "";
  return (
    <div className="card">
      <div style={{ marginBottom: 8 }}>
        <div className="input-label">Action</div>
        <div style={{ fontWeight: 600 }}>Sign Arch transaction</div>
      </div>

      <div className="approve-risk approve-risk-warn" style={{ marginBottom: 8 }}>
        Blind sign — the wallet cannot decode this transaction's effects.
        Verify the hash matches the preview shown by the dapp before approving.
      </div>

      <div>
        <div className="input-label">Transaction message hash</div>
        <div
          className="mono"
          style={{ wordBreak: "break-all", fontSize: 11, lineHeight: 1.4 }}
        >
          {messageHashHex}
        </div>
      </div>
    </div>
  );
}

function PsbtSummaryCard({ payload, myAddresses }: { payload: any; myAddresses: string[] }) {
  const [summary, setSummary] = useState<PsbtSummary | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const psbtPayload: string = payload?.psbt;
      if (!psbtPayload) throw new Error("Missing PSBT payload");
      setSummary(summarizePsbt(psbtPayload, myAddresses));
      setDecodeError(null);
    } catch (e: any) {
      setDecodeError(e?.message || "Could not decode PSBT");
    }
  }, [payload, myAddresses]);

  if (decodeError) {
    return (
      <div className="card">
        <div className="approve-risk approve-risk-danger" style={{ marginBottom: 8 }}>
          Could not decode this PSBT: {decodeError}. We will not let you sign it.
        </div>
      </div>
    );
  }

  if (!summary) {
    return <div className="card"><div className="spinner" style={{ width: 16, height: 16 }} /></div>;
  }

  const isOutflow = summary.netUserSats < 0;

  return (
    <div className="card">
      <div style={{ marginBottom: 8 }}>
        <div className="input-label">Action</div>
        <div style={{ fontWeight: 600 }}>Sign Bitcoin Transaction (PSBT)</div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="input-label">Net change for your wallet</div>
        <div
          style={{
            fontWeight: 700,
            fontSize: 18,
            color: isOutflow ? "var(--danger)" : "var(--success)",
          }}
        >
          {isOutflow ? "" : "+"}{formatSats(summary.netUserSats)}
        </div>
      </div>

      {summary.exactFee && (
        <div style={{ marginBottom: 10 }}>
          <div className="input-label">Network fee</div>
          <div>{formatSats(summary.feeSats)}</div>
        </div>
      )}

      <details>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
          Inputs ({summary.inputs.length}) and outputs ({summary.outputs.length})
        </summary>
        <div style={{ marginTop: 6 }}>
          <div className="input-label" style={{ marginBottom: 4 }}>Inputs</div>
          {summary.inputs.map((i, idx) => (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
              <span className="mono">{i.address ? truncateAddress(i.address, 10) : `${i.txid.slice(0, 8)}...:${i.vout}`}</span>
              <span style={{ color: i.isMine ? "var(--text-primary)" : "var(--text-muted)" }}>
                {i.isMine ? "you" : ""} {formatSats(i.valueSats)}
              </span>
            </div>
          ))}
          <div className="input-label" style={{ marginTop: 8, marginBottom: 4 }}>Outputs</div>
          {summary.outputs.map((o, idx) => (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 2 }}>
              <span className="mono">{o.address ? truncateAddress(o.address, 10) : "(non-standard)"}</span>
              <span style={{ color: o.isMine ? "var(--text-primary)" : "var(--text-muted)" }}>
                {o.isChange ? "change" : o.isMine ? "you" : ""} {formatSats(o.valueSats)}
              </span>
            </div>
          ))}
        </div>
      </details>

      {!summary.exactFee && (
        <div className="approve-risk approve-risk-warn" style={{ marginTop: 8 }}>
          Some inputs are missing prevout amounts. Fee is unknown — proceed with caution.
        </div>
      )}
    </div>
  );
}

function AccountPicker({
  accounts,
  selectedId,
  onSelect,
}: {
  accounts: WalletAccount[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (accounts.length <= 1) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="input-label">Connect with</div>
      <select
        className="input"
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box" }}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label} ({truncateAddress(a.btcAddress, 8)})
          </option>
        ))}
      </select>
    </div>
  );
}

export default function Approve() {
  const { requestId } = useParams<{ requestId: string }>();
  const { state, activeAccount } = useWallet();
  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [isReturning, setIsReturning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  const myAddresses = useMemo(
    () => state.accounts.map((a) => a.btcAddress).filter(Boolean),
    [state.accounts],
  );

  const selectedAccount = useMemo(
    () => state.accounts.find((a) => a.id === selectedAccountId) ?? activeAccount,
    [state.accounts, selectedAccountId, activeAccount],
  );

  useEffect(() => {
    if (!requestId) return;
    chrome.runtime.sendMessage({ type: "GET_PENDING_REQUEST", requestId }, (response) => {
      if (response) {
        setRequest(response);
        if (response.origin) {
          walletStore.isSiteConnected(response.origin).then(setIsReturning).catch(() => setIsReturning(false));
        }
      }
    });
  }, [requestId]);

  useEffect(() => {
    if (activeAccount && !selectedAccountId) {
      setSelectedAccountId(activeAccount.id);
    }
  }, [activeAccount, selectedAccountId]);

  const sendApproved = useCallback(
    (result: unknown) => {
      chrome.runtime.sendMessage({ type: "APPROVE_REQUEST", requestId, result });
      setSuccess(true);
      setTimeout(() => window.close(), 1500);
    },
    [requestId],
  );

  const signPsbtLocally = useCallback(
    async (psbtHex: string): Promise<string> => {
      if (!selectedAccount) throw new Error("No account selected");
      // The session-stamped signer covers both passkey and email
      // wallets transparently -- it uses whichever IndexedDB key was
      // registered at unlock-time. No Hub round-trip for signing.
      const { signedPsbtHex } = await signerForAccount(selectedAccount).signPsbt(
        { psbtHex },
      );
      return signedPsbtHex;
    },
    [selectedAccount],
  );

  const handleApprove = useCallback(async () => {
    if (!request || !selectedAccount || !requestId) return;
    setLoading(true);
    setError(null);
    try {
      const client = await getClient();
      const externalUserId = await getExternalUserId();

      if (request.type === "CONNECT") {
        await chrome.runtime.sendMessage({
          type: "APPROVE_CONNECT",
          requestId,
          origin: request.origin,
          dappName: request.dappName,
          iconUrl: request.dappIconUrl,
          account: {
            address: selectedAccount.btcAddress,
            publicKey: selectedAccount.publicKeyHex,
            archAddress: selectedAccount.archAddress,
          },
        });
        sendApproved({
          address: selectedAccount.btcAddress,
          publicKey: selectedAccount.publicKeyHex,
          archAddress: selectedAccount.archAddress,
        });
        return;
      }

      if (request.type === "SEND_TRANSFER" || request.type === "SEND_TOKEN_TRANSFER") {
        const action =
          request.type === "SEND_TRANSFER"
            ? {
                type: "arch.transfer" as const,
                toAddress: request.payload.to,
                lamports: request.payload.lamports,
              }
            : {
                type: "arch.token_transfer" as const,
                mintAddress: request.payload.mint,
                toAddress: request.payload.to,
                amount: request.payload.amount,
              };
        const sr = await client.createSigningRequest({
          externalUserId,
          signer: isExternalAccount(selectedAccount)
            ? {
                kind: "external",
                taprootAddress: selectedAccount.btcAddress,
                publicKeyHex: selectedAccount.publicKeyHex || undefined,
              }
            : { kind: "turnkey", resourceId: selectedAccount.turnkeyResourceId },
          action,
        });
        const submitResult = await signAndSubmitRequest(selectedAccount, sr.signingRequestId, sr.payloadToSign, externalUserId, state.network);
        const txid = extractTxid(submitResult, sr.signingRequestId);
        sendApproved({ txid });
        return;
      }

      if (request.type === "SIGN_MESSAGE") {
        const messageHex: string = request.payload?.message;
        if (!messageHex) throw new Error("SIGN_MESSAGE missing payload.message");
        const sr = await client.createSigningRequest({
          externalUserId,
          signer: isExternalAccount(selectedAccount)
            ? {
                kind: "external",
                taprootAddress: selectedAccount.btcAddress,
                publicKeyHex: selectedAccount.publicKeyHex || undefined,
              }
            : { kind: "turnkey", resourceId: selectedAccount.turnkeyResourceId },
          action: { type: "arch.sign_message", messageHex },
        });
        const submitResult = await signAndSubmitRequest(selectedAccount, sr.signingRequestId, sr.payloadToSign, externalUserId, state.network);
        const signature = submitResult?.signature64Hex || submitResult?.signature;
        if (!signature) throw new Error("Hub did not return a signature");
        sendApproved({ signature });
        return;
      }

      if (request.type === "SIGN_ARCH_MESSAGE_HASH") {
        const messageHashHex: string = request.payload?.messageHashHex;
        if (!messageHashHex) {
          throw new Error("SIGN_ARCH_MESSAGE_HASH missing payload.messageHashHex");
        }
        if (isExternalAccount(selectedAccount)) {
          // Linked external wallets (Xverse / UniSat) don't expose a
          // raw-hash signing path -- they'd have to BIP-322-sign the
          // hash as a message string, which would produce a different
          // sighash than the to-sign-taproot wrapper our session
          // signer uses. Refuse cleanly rather than silently produce
          // an invalid signature.
          throw new Error(
            "Raw Arch message-hash signing is not yet supported for linked external wallets. Use a Turnkey account.",
          );
        }
        const signer = signerForAccount(selectedAccount);
        const { signature64Hex } = await signer.signArchMessageHash({
          messageHashHex,
        });
        sendApproved({ signature64Hex });
        return;
      }

      if (request.type === "SIGN_PSBT") {
        const psbtPayload: string = request.payload?.psbt;
        if (!psbtPayload) throw new Error("SIGN_PSBT missing payload.psbt");
        if (isExternalAccount(selectedAccount)) {
          throw new Error("Raw PSBT signing is not supported for linked external wallets yet. Open the source wallet directly.");
        }

        // Same path for both auth methods now: the session-stamped
        // signer signs locally regardless of how the session was
        // bootstrapped. No more server-side PSBT signing.
        const signedHex = await signPsbtLocally(psbtPayload);
        sendApproved({ psbt: signedHex });
        return;
      }

      throw new Error(`Unsupported request type: ${request.type}`);
    } catch (e: any) {
      setError(formatWalletHubError(e, "Failed to process request"));
    } finally {
      setLoading(false);
    }
  }, [request, selectedAccount, requestId, sendApproved, signPsbtLocally, state.network]);

  const handleReject = useCallback(() => {
    chrome.runtime.sendMessage({ type: "REJECT_REQUEST", requestId });
    window.close();
  }, [requestId]);

  if (success) {
    return (
      <div className="approve-page">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: "var(--success)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 28 }}>
            ?
          </div>
          <div style={{ fontWeight: 600 }}>Approved</div>
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="approve-page">
        <div className="spinner-center"><div className="spinner" /></div>
      </div>
    );
  }

  // Phase 2.2 risk hint: warn on first-touch sites that are immediately
  // asking to sign something instead of just connect.
  const risk =
    request.type !== "CONNECT" && !isReturning
      ? { level: "warn" as const, label: "New site requesting a signature. Verify the URL above." }
      : undefined;

  return (
    <div className="approve-page" data-network={state.network}>
      <DappHeader
        origin={request.origin}
        dappName={request.dappName}
        iconUrl={request.dappIconUrl}
        isReturning={isReturning}
        risk={risk}
      />

      <div className="approve-body">
        {error && <div className="error-banner">{error}</div>}

        {request.type === "CONNECT" && (
          <>
            <AccountPicker
              accounts={state.accounts}
              selectedId={selectedAccountId || activeAccount?.id || ""}
              onSelect={setSelectedAccountId}
            />
            <div className="card">
              <p style={{ marginBottom: 12 }}>This site wants to connect to your Arch Wallet.</p>
              <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
                It will see your selected address and may request transaction approval.
              </p>
            </div>
          </>
        )}

        {request.type === "SEND_TRANSFER" && request.payload && (
          <div className="card">
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Action</div>
              <div style={{ fontWeight: 600 }}>Send ARCH</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">To</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{request.payload.to}</div>
            </div>
            <div>
              <div className="input-label">Amount</div>
              <div style={{ fontWeight: 600 }}>{formatArch(request.payload.lamports)}</div>
            </div>
          </div>
        )}

        {request.type === "SEND_TOKEN_TRANSFER" && request.payload && (
          <div className="card">
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Action</div>
              <div style={{ fontWeight: 600 }}>Send APL Token</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Token Mint</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{request.payload.mint}</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">To</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{request.payload.to}</div>
            </div>
            <div>
              <div className="input-label">Amount</div>
              <div style={{ fontWeight: 600 }}>{request.payload.amount}</div>
            </div>
          </div>
        )}

        {request.type === "SIGN_MESSAGE" && request.payload && (
          <MessageSummary payload={request.payload} origin={request.origin} />
        )}

        {request.type === "SIGN_ARCH_MESSAGE_HASH" && request.payload && (
          <ArchMessageHashSummary payload={request.payload} />
        )}

        {request.type === "SIGN_PSBT" && request.payload && (
          <PsbtSummaryCard payload={request.payload} myAddresses={myAddresses} />
        )}
      </div>

      <div className="approve-footer">
        <button className="btn btn-secondary" onClick={handleReject} disabled={loading}>
          Reject
        </button>
        <button className="btn btn-primary" onClick={handleApprove} disabled={loading || !selectedAccount}>
          {loading ? "Processing..." : "Approve"}
        </button>
      </div>
    </div>
  );
}
