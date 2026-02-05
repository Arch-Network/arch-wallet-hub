import { useState, useEffect, useCallback } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
// @ts-ignore - sats-connect types
import { request } from "sats-connect";
import { Turnkey } from "@turnkey/sdk-browser";
import type { WalletState, TransactionDetails, TransactionResult } from "../WizardFlow";

interface ReviewStepProps {
  client: WalletHubClient;
  externalUserId: string;
  wallet: WalletState;
  transaction: TransactionDetails;
  signingRequest: any;
  onSigningRequestCreated: (sr: any) => void;
  onComplete: (result: TransactionResult) => void;
  onBack: () => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
}

// Helper functions
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export default function ReviewStep({
  client,
  externalUserId,
  wallet,
  transaction,
  signingRequest,
  onSigningRequestCreated,
  onComplete,
  onBack,
  isLoading,
  setIsLoading,
  error,
  setError,
}: ReviewStepProps) {
  const [localSigningRequest, setLocalSigningRequest] = useState<any>(signingRequest);
  const [readiness, setReadiness] = useState<any>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const [isAirdropping, setIsAirdropping] = useState(false);
  const [airdropSuccess, setAirdropSuccess] = useState(false);

  const isTurnkey = wallet.type === "turnkey";
  const isCustodialTurnkey = isTurnkey && wallet.isCustodial === true;
  const isPasskeyTurnkey = isTurnkey && !wallet.isCustodial;

  // Create signing request on mount
  useEffect(() => {
    if (!localSigningRequest) {
      createSigningRequest();
    }
  }, []);

  // Poll for readiness (only for external wallets, not Turnkey)
  useEffect(() => {
    if (!localSigningRequest?.signingRequestId) return;
    
    // Check if Turnkey already succeeded
    if (localSigningRequest?.status === "succeeded") {
      onComplete({
        success: true,
        signingRequestId: localSigningRequest.signingRequestId,
        txid: localSigningRequest?.result?.txid || localSigningRequest?.result?.txidHex,
      });
      return;
    }

    const pollReadiness = async () => {
      try {
        const sr = await client.getSigningRequest(localSigningRequest.signingRequestId);
        setLocalSigningRequest(sr);
        setReadiness((sr as any)?.readiness);
        onSigningRequestCreated(sr);
        
        // Check if status changed to succeeded (Turnkey server-side signing)
        if ((sr as any)?.status === "succeeded") {
          onComplete({
            success: true,
            signingRequestId: localSigningRequest.signingRequestId,
            txid: (sr as any)?.result?.txid || (sr as any)?.result?.txidHex,
          });
        }
      } catch (e) {
        console.error("Poll error:", e);
      }
    };

    pollReadiness();
    const interval = setInterval(() => {
      setPollCount((c) => c + 1);
      pollReadiness();
    }, 2000);

    return () => clearInterval(interval);
  }, [localSigningRequest?.signingRequestId, client, onSigningRequestCreated]);

  // Sign with Turnkey passkey (non-custodial wallet)
  const signWithPasskey = async (payloadHex: string, signingRequestId: string): Promise<void> => {
    if (!wallet.organizationId) {
      throw new Error("Missing organization ID for passkey wallet");
    }

    // Initialize Turnkey browser SDK
    // The rpId should match the domain where passkeys were created
    const turnkey = new Turnkey({
      apiBaseUrl: "https://api.turnkey.com",
      defaultOrganizationId: wallet.organizationId,
      rpId: window.location.hostname === "localhost" ? "localhost" : window.location.hostname,
    });

    const passkeyClient = turnkey.passkeyClient();

    // Sign the raw payload using the user's passkey
    // This will prompt the user to authenticate with their passkey
    const signResult = await passkeyClient.signRawPayload({
      signWith: wallet.address,
      payload: payloadHex,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    });

    // Construct the 64-byte hex signature (r + s)
    const signature64Hex = `${signResult.r}${signResult.s}`;

    // Submit the signature to the backend
    const submitRes = await client.submitSigningRequest(signingRequestId, {
      externalUserId,
      signature64Hex,
      turnkeyActivityId: signResult.activity?.id,
    });

    console.log("[Passkey] Submit response:", submitRes);

    // Update local state with the response
    setLocalSigningRequest(submitRes);

    const status = (submitRes as any)?.status;
    const txid = (submitRes as any)?.result?.txid || 
                 (submitRes as any)?.result?.txidHex ||
                 (submitRes as any)?.txid ||
                 (submitRes as any)?.txidHex;

    if (status === "succeeded") {
      onComplete({
        success: true,
        signingRequestId,
        txid,
      });
    } else if (status === "failed") {
      throw new Error((submitRes as any)?.result?.status?.message || "Transaction failed");
    } else {
      // For any other status (submitted, pending, etc.), show waiting state
      // The polling will detect when it transitions to "succeeded"
      setIsSubmitted(true);
      console.log(`[Passkey] Transaction status: ${status}, waiting for confirmation...`);
      
      // If there's already a txid, we can complete (some backends return success differently)
      if (txid) {
        console.log(`[Passkey] Found txid: ${txid}, completing...`);
        onComplete({
          success: true,
          signingRequestId,
          txid,
        });
      }
    }
  };

  const createSigningRequest = async () => {
    setIsLoading(true);
    setError(null);

    try {
      let signer: any;
      
      if (isTurnkey) {
        // Turnkey signer - backend will handle signing for custodial, client for passkey
        signer = {
          kind: "turnkey" as const,
          resourceId: wallet.turnkeyResourceId,
        };
      } else {
        // External wallet signer
        signer = {
          kind: "external" as const,
          taprootAddress: wallet.address,
          publicKeyHex: wallet.publicKey || undefined,
        };
      }

      const action =
        transaction.actionType === "arch.transfer"
          ? {
              type: "arch.transfer" as const,
              toAddress: transaction.toAddress!,
              lamports: transaction.lamports!,
            }
          : {
              type: "arch.anchor" as const,
              btcTxid: transaction.btcTxid!,
              vout: transaction.btcVout!,
            };

      const res = await client.createSigningRequest({ externalUserId, signer, action });
      setLocalSigningRequest(res);
      onSigningRequestCreated(res);
      
      // Handle signing based on wallet type
      if (isTurnkey && (res as any)?.signingRequestId) {
        if (isCustodialTurnkey) {
          // Custodial Turnkey wallet - server-side signing
          try {
            const signRes = await client.signWithTurnkey((res as any).signingRequestId, { externalUserId });
            setLocalSigningRequest(signRes);
            
            if (signRes.status === "succeeded") {
              onComplete({
                success: true,
                signingRequestId: signRes.signingRequestId,
                txid: (signRes as any)?.result?.txid || (signRes as any)?.result?.txidHex,
              });
            } else if (signRes.status === "failed") {
              setError((signRes as any)?.result?.status?.message || "Transaction failed");
            }
          } catch (signErr: any) {
            setError(signErr?.message || "Turnkey server signing failed");
          }
        }
        // For passkey wallets, don't auto-sign - wait for user to click Sign button
        // The payloadHex will be extracted from the signing request in handleSign
      }
    } catch (e: any) {
      setError(e?.message || "Failed to create signing request");
    } finally {
      setIsLoading(false);
    }
  };

  const signWithXverse = async (psbtBase64: string): Promise<string> => {
    const response: any = await new Promise((resolve, reject) => {
      request("signPsbt", {
        psbt: psbtBase64,
        signInputs: { [wallet.address]: [0] },
        broadcast: false,
      })
        .then(resolve)
        .catch(reject);
    });

    if (response.status !== "success") {
      throw new Error(response.error?.message || "Xverse signing failed");
    }

    const signedPsbtBase64 = response.result?.psbt;
    if (!signedPsbtBase64) {
      throw new Error("No signed PSBT returned from Xverse");
    }

    // Decode base64 to bytes and extract signature
    const signedPsbtBytes = Uint8Array.from(atob(signedPsbtBase64), (c) => c.charCodeAt(0));
    
    // Find the 64-byte Schnorr signature (tap_key_sig)
    for (let i = 0; i < signedPsbtBytes.length - 64; i++) {
      if (signedPsbtBytes[i] === 0x40) {
        const sigBytes = signedPsbtBytes.slice(i + 1, i + 1 + 64);
        if (sigBytes.length === 64) {
          return bytesToHex(sigBytes);
        }
      }
    }

    throw new Error("Could not extract signature from signed PSBT");
  };

  const signWithUnisat = async (psbtBase64: string): Promise<string> => {
    if (!window.unisat?.signPsbt) {
      throw new Error("Unisat signPsbt not available");
    }

    // Convert base64 to hex for Unisat
    const psbtBytes = Uint8Array.from(atob(psbtBase64), (c) => c.charCodeAt(0));
    const psbtHex = bytesToHex(psbtBytes);

    const signedPsbtHex = await window.unisat.signPsbt(psbtHex, { autoFinalized: false });
    const signedPsbtBytes = hexToBytes(signedPsbtHex);

    // Find the 64-byte Schnorr signature
    for (let i = 0; i < signedPsbtBytes.length - 64; i++) {
      if (signedPsbtBytes[i] === 0x40) {
        const sigBytes = signedPsbtBytes.slice(i + 1, i + 1 + 64);
        if (sigBytes.length === 64) {
          return bytesToHex(sigBytes);
        }
      }
    }

    throw new Error("Could not extract signature from signed PSBT");
  };

  // Handle airdrop request
  const handleAirdrop = useCallback(async () => {
    const archAddress = localSigningRequest?.display?.from?.archAccountAddress;
    if (!archAddress) {
      setError("No Arch account address found for airdrop");
      return;
    }

    setIsAirdropping(true);
    setError(null);

    try {
      await client.airdropArchAccount({ archAccountAddress: archAddress });
      setAirdropSuccess(true);
      // Reset poll count to trigger a fresh readiness check
      setPollCount(0);
    } catch (e: any) {
      setError(`Airdrop failed: ${e?.message || "Unknown error"}`);
    } finally {
      setIsAirdropping(false);
    }
  }, [client, localSigningRequest, setError]);

  const handleSign = useCallback(async () => {
    // For custodial Turnkey, signing is handled server-side, so we just wait
    if (isCustodialTurnkey) {
      setError("Turnkey signing is handled automatically. Please wait...");
      return;
    }

    setIsSigning(true);
    setError(null);

    try {
      // For passkey Turnkey wallets, use client-side passkey signing
      if (isPasskeyTurnkey) {
        const payloadHex = localSigningRequest?.payloadToSign?.payloadHex;
        if (!payloadHex) {
          throw new Error("No payload available for signing");
        }
        await signWithPasskey(payloadHex, localSigningRequest.signingRequestId);
        return;
      }

      // For external wallets (Xverse/Unisat), use PSBT signing
      if (!localSigningRequest?.payloadToSign?.psbtBase64) {
        throw new Error("No PSBT available for signing");
      }

      const psbtBase64 = localSigningRequest.payloadToSign.psbtBase64;
      let signature64Hex: string;

      if (wallet.type === "xverse") {
        signature64Hex = await signWithXverse(psbtBase64);
      } else if (wallet.type === "unisat") {
        signature64Hex = await signWithUnisat(psbtBase64);
      } else {
        throw new Error(`Unsupported wallet type: ${wallet.type}`);
      }

      // Submit signature
      const submitRes = await client.submitSigningRequest(localSigningRequest.signingRequestId, {
        externalUserId,
        signature64Hex,
      });

      onComplete({
        success: true,
        signingRequestId: localSigningRequest.signingRequestId,
        txid: (submitRes as any)?.result?.txid || (submitRes as any)?.result?.txidHex,
      });
    } catch (e: any) {
      setError(e?.message || "Signing failed");
    } finally {
      setIsSigning(false);
    }
  }, [localSigningRequest, wallet, client, externalUserId, onComplete, setError, isCustodialTurnkey, isPasskeyTurnkey]);

  // Extract display data
  const displayData = localSigningRequest?.display ?? {};
  const isAnchor = displayData?.kind === "arch.anchor" || transaction.actionType === "arch.anchor";
  
  const fromAddress = isAnchor
    ? displayData?.account?.archAccountAddress
    : displayData?.from?.archAccountAddress;
  
  const toAddress = isAnchor
    ? displayData?.account?.btcAccountAddress
    : displayData?.to?.archAccountAddress;

  const readinessStatus = readiness?.status ?? "unknown";
  const isReady = readinessStatus === "ready";
  const requestStatus = localSigningRequest?.status;

  // For Turnkey, check if it's processing or already done
  const isTurnkeyProcessing = isCustodialTurnkey && requestStatus === "pending";
  const isTurnkeySucceeded = isTurnkey && requestStatus === "succeeded";
  
  // Passkey wallet needs manual sign trigger, like external wallets
  const needsManualSign = !isCustodialTurnkey;

  const getWalletDisplayName = () => {
    switch (wallet.type) {
      case "turnkey": return "Turnkey";
      case "xverse": return "Xverse";
      case "unisat": return "Unisat";
      default: return wallet.type;
    }
  };

  return (
    <div className="step-container">
      <div className="step-header">
        <h1 className="step-title">Review & Sign</h1>
        <p className="step-description">
          {isCustodialTurnkey
            ? "Your transaction is being signed automatically via Turnkey"
            : isPasskeyTurnkey
            ? "Confirm the transaction details and sign with your Turnkey passkey"
            : "Confirm the transaction details and sign with your wallet"}
        </p>
      </div>

      {/* Turnkey Custodial Auto-Sign Status */}
      {isCustodialTurnkey && (
        <div className={`turnkey-status ${isTurnkeySucceeded ? "success" : "processing"}`}>
          {isTurnkeySucceeded ? (
            <>
              <span className="turnkey-status-icon">✓</span>
              <span>Transaction signed and submitted!</span>
            </>
          ) : (
            <>
              <span className="spinner small"></span>
              <span>Signing via Turnkey (custodial)...</span>
            </>
          )}
        </div>
      )}

      {/* Passkey Turnkey wallet info */}
      {isPasskeyTurnkey && !isTurnkeySucceeded && !isSubmitted && (
        <div className="passkey-info">
          <span className="passkey-info-icon">🔐</span>
          <span>This wallet requires passkey authentication to sign transactions</span>
        </div>
      )}

      {/* Transaction Submitted - Waiting for Confirmation */}
      {isSubmitted && !isTurnkeySucceeded && (
        <div className="turnkey-status processing">
          <span className="spinner small"></span>
          <span>Transaction submitted! Waiting for blockchain confirmation...</span>
        </div>
      )}

      {/* Transaction Summary Card */}
      <div className="review-card">
        <div className="review-card-header">
          <div className="review-card-icon">
            {isAnchor ? "⚓" : "↗"}
          </div>
          <div className="review-card-title">
            {isAnchor ? "Anchor UTXO" : "Transfer"}
          </div>
          <div className={`review-status ${isTurnkeySucceeded ? "ready" : readinessStatus}`}>
            {isTurnkeySucceeded ? "✓ Signed" :
             readinessStatus === "ready" ? "✓ Ready" :
             readinessStatus === "not_ready" ? "⚠️ Not Ready" :
             "⏳ Checking..."}
          </div>
        </div>

        <div className="review-details">
          {/* From/Account */}
          <div className="review-row">
            <span className="review-label">{isAnchor ? "Account" : "From"}</span>
            <span className="review-value mono">
              {fromAddress ? `${fromAddress.slice(0, 12)}...${fromAddress.slice(-8)}` : "—"}
            </span>
          </div>

          {/* To/BTC Address */}
          {toAddress && (
            <div className="review-row">
              <span className="review-label">{isAnchor ? "BTC Address" : "To"}</span>
              <span className="review-value mono">
                {toAddress.slice(0, 12)}...{toAddress.slice(-8)}
              </span>
            </div>
          )}

          {/* Amount (transfer only) */}
          {!isAnchor && transaction.lamports && (
            <div className="review-row">
              <span className="review-label">Amount</span>
              <span className="review-value">
                <strong>{(parseInt(transaction.lamports) / 100000000).toFixed(8)} ARCH</strong>
                <span className="review-value-sub">
                  ({parseInt(transaction.lamports).toLocaleString()} lamports)
                </span>
              </span>
            </div>
          )}

          {/* UTXO (anchor only) */}
          {isAnchor && transaction.btcTxid && (
            <div className="review-row">
              <span className="review-label">Anchoring UTXO</span>
              <span className="review-value mono" style={{ fontSize: 12 }}>
                {transaction.btcTxid}:{transaction.btcVout}
              </span>
            </div>
          )}

          {/* Network */}
          <div className="review-row">
            <span className="review-label">Network</span>
            <span className="review-value">Arch Testnet</span>
          </div>

          {/* Signing Wallet */}
          <div className="review-row">
            <span className="review-label">Signing With</span>
            <span className="review-value">
              <span className={`wallet-badge ${wallet.type}`}>
                {getWalletDisplayName()}
              </span>
            </span>
          </div>
        </div>

        {/* Readiness Message */}
        {readinessStatus === "not_ready" && readiness?.reason && (
          <div className="review-warning">
            <span className="review-warning-icon">⚠️</span>
            <div className="review-warning-content">
              <span>
                {readiness.reason === "NotAnchored"
                  ? "Account has no ARCH balance. Request an airdrop to fund the account."
                  : readiness.reason === "ArchAccountNotFound"
                  ? "Arch account does not exist or has no balance. Request an airdrop to create and fund the account."
                  : readiness.message || readiness.reason}
              </span>
              {(readiness.reason === "ArchAccountNotFound" || readiness.reason === "NotAnchored") && (
                <button
                  className="btn-airdrop"
                  onClick={handleAirdrop}
                  disabled={isAirdropping || airdropSuccess}
                  type="button"
                >
                  {isAirdropping ? (
                    <>
                      <span className="spinner small"></span>
                      Requesting...
                    </>
                  ) : airdropSuccess ? (
                    "✓ Airdrop Requested"
                  ) : (
                    "🪂 Request Airdrop"
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sign Button (for external wallets and passkey Turnkey wallets) */}
      {needsManualSign && !isTurnkeySucceeded && !isSubmitted && (
        <div className="step-actions">
          <button className="btn-secondary" onClick={onBack} type="button" disabled={isSigning}>
            ← Back
          </button>
          <button
            className="btn-primary btn-sign"
            onClick={handleSign}
            disabled={!isReady || isSigning || isLoading}
            type="button"
          >
            {isSigning ? (
              <>
                <span className="spinner small"></span>
                {isPasskeyTurnkey ? "Authenticating..." : "Signing..."}
              </>
            ) : (
              <>
                {isPasskeyTurnkey ? "🔐 Sign with Passkey" : `Sign with ${getWalletDisplayName()}`}
              </>
            )}
          </button>
        </div>
      )}

      {/* Waiting for confirmation - show back button only */}
      {isSubmitted && !isTurnkeySucceeded && (
        <div className="step-actions">
          <button className="btn-secondary" onClick={onBack} type="button" disabled>
            ← Back
          </button>
          <div className="waiting-confirmation">
            <span className="spinner small"></span>
            <span>Confirming...</span>
          </div>
        </div>
      )}

      {/* Back button for custodial Turnkey (no sign button needed - auto-signs) */}
      {isCustodialTurnkey && !isTurnkeySucceeded && (
        <div className="step-actions">
          <button className="btn-secondary" onClick={onBack} type="button">
            ← Back
          </button>
        </div>
      )}

      {/* Loading overlay for request creation */}
      {isLoading && !localSigningRequest && (
        <div className="review-loading">
          <span className="spinner"></span>
          <span>Creating signing request...</span>
        </div>
      )}
    </div>
  );
}
