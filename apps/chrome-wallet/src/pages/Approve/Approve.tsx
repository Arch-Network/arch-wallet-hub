import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Turnkey } from "@turnkey/sdk-browser";
import { useWallet } from "../../hooks/useWallet";
import { getClient, getExternalUserId } from "../../utils/sdk";
import { truncateAddress, formatArch } from "../../utils/format";

interface RequestDetails {
  type: string;
  origin: string;
  payload?: any;
}

async function signAndSubmit(
  activeAccount: { btcAddress: string; organizationId: string; turnkeyResourceId: string; isCustodial: boolean },
  signingRequestId: string,
  payloadToSign: any,
  externalUserId: string,
): Promise<string> {
  const client = await getClient();

  if (activeAccount.isCustodial) {
    const serverResult = await client.signWithTurnkey(signingRequestId, { externalUserId });
    const res = (serverResult as any).result ?? serverResult;
    return res?.txid || res?.txidHex || signingRequestId;
  }

  const payloadHex = payloadToSign?.payloadHex;
  if (!payloadHex) throw new Error("No payload available for signing");

  const tk = new Turnkey({
    apiBaseUrl: "https://api.turnkey.com",
    defaultOrganizationId: activeAccount.organizationId,
    rpId: globalThis.location?.hostname === "localhost" ? "localhost" : globalThis.location?.hostname ?? "localhost",
  });
  const signResult = await tk.passkeyClient().signRawPayload({
    signWith: activeAccount.btcAddress,
    payload: payloadHex,
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP",
  });

  const signature64Hex = `${signResult.r}${signResult.s}`;
  const submitRes = await client.submitSigningRequest(signingRequestId, {
    externalUserId,
    signature64Hex,
  });
  const res = (submitRes as any).result ?? submitRes;
  return res?.txid || res?.txidHex || signingRequestId;
}

export default function Approve() {
  const { requestId } = useParams<{ requestId: string }>();
  const navigate = useNavigate();
  const { activeAccount } = useWallet();
  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!requestId) return;
    chrome.runtime.sendMessage(
      { type: "GET_PENDING_REQUEST", requestId },
      (response) => {
        if (response) {
          setRequest(response);
        }
      }
    );
  }, [requestId]);

  const handleApprove = useCallback(async () => {
    if (!request || !activeAccount || !requestId) return;
    setLoading(true);
    setError(null);

    try {
      const client = await getClient();
      const externalUserId = getExternalUserId();

      if (request.type === "CONNECT") {
        await chrome.runtime.sendMessage({
          type: "APPROVE_CONNECT",
          requestId,
          origin: request.origin,
          account: {
            address: activeAccount.btcAddress,
            publicKey: activeAccount.publicKeyHex,
            archAddress: activeAccount.archAddress,
          },
        });
        setSuccess(true);
        setTimeout(() => window.close(), 1000);
        return;
      }

      if (request.type === "SEND_TRANSFER") {
        const sr = await client.createSigningRequest({
          externalUserId,
          signer: { kind: "turnkey", resourceId: activeAccount.turnkeyResourceId },
          action: {
            type: "arch.transfer",
            toAddress: request.payload.to,
            lamports: request.payload.lamports,
          },
        });

        const txid = await signAndSubmit(activeAccount, sr.signingRequestId, sr.payloadToSign, externalUserId);

        chrome.runtime.sendMessage({
          type: "APPROVE_REQUEST",
          requestId,
          result: { txid },
        });

        setSuccess(true);
        setTimeout(() => window.close(), 1500);
        return;
      }

      if (request.type === "SEND_TOKEN_TRANSFER") {
        const sr = await client.createSigningRequest({
          externalUserId,
          signer: { kind: "turnkey", resourceId: activeAccount.turnkeyResourceId },
          action: {
            type: "arch.token_transfer",
            mintAddress: request.payload.mint,
            toAddress: request.payload.to,
            amount: request.payload.amount,
          },
        });

        const txid = await signAndSubmit(activeAccount, sr.signingRequestId, sr.payloadToSign, externalUserId);

        chrome.runtime.sendMessage({
          type: "APPROVE_REQUEST",
          requestId,
          result: { txid },
        });

        setSuccess(true);
        setTimeout(() => window.close(), 1500);
        return;
      }

      throw new Error(`Unsupported request type: ${request.type}`);
    } catch (e: any) {
      setError(e?.message || "Failed to process request");
    } finally {
      setLoading(false);
    }
  }, [request, activeAccount, requestId]);

  const handleReject = useCallback(() => {
    chrome.runtime.sendMessage({
      type: "REJECT_REQUEST",
      requestId,
    });
    window.close();
  }, [requestId]);

  if (success) {
    return (
      <div className="approve-page">
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 48 }}>✅</div>
          <div style={{ fontWeight: 600 }}>Approved</div>
        </div>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="approve-page">
        <div className="spinner-center">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="approve-page">
      <div className="approve-header">
        <h2 style={{ fontSize: 16 }}>
          {request.type === "CONNECT" ? "Connection Request" : "Transaction Request"}
        </h2>
        <div className="approve-origin">{request.origin}</div>
      </div>

      <div className="approve-body">
        {error && <div className="error-banner">{error}</div>}

        {request.type === "CONNECT" && (
          <div className="card">
            <p style={{ marginBottom: 12 }}>This site wants to connect to your Arch Wallet.</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              It will be able to see your address and request transaction approval.
            </p>
          </div>
        )}

        {request.type === "SEND_TRANSFER" && request.payload && (
          <div className="card">
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Action</div>
              <div style={{ fontWeight: 600 }}>Send ARCH</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">To</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
                {request.payload.to}
              </div>
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
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
                {request.payload.mint}
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">To</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
                {request.payload.to}
              </div>
            </div>
            <div>
              <div className="input-label">Amount</div>
              <div style={{ fontWeight: 600 }}>{request.payload.amount}</div>
            </div>
          </div>
        )}

        {request.type === "SIGN_MESSAGE" && request.payload && (
          <div className="card">
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Action</div>
              <div style={{ fontWeight: 600 }}>Sign Message</div>
            </div>
            <div>
              <div className="input-label">Message</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
                {request.payload.message}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="approve-footer">
        <button className="btn btn-secondary" onClick={handleReject} disabled={loading}>
          Reject
        </button>
        <button className="btn btn-primary" onClick={handleApprove} disabled={loading}>
          {loading ? "Processing..." : "Approve"}
        </button>
      </div>
    </div>
  );
}
