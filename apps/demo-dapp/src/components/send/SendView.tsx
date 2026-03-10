import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "../../types";
import CopyButton from "../shared/CopyButton";
import { formatArchId } from "../../utils/archFormat";

type AssetType = "btc" | "arch" | "apl";

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

function extractSchnorrSigFromPsbt(psbtBytes: Uint8Array): string {
  // Look for PSBT_IN_TAP_KEY_SIG key type (0x13).
  // PSBT key-value: <keylen=01> <keytype=13> <valuelen> <value>
  // valuelen is 0x40 (64 bytes) or 0x41 (65 bytes with sighash type appended)
  for (let i = 0; i < psbtBytes.length - 67; i++) {
    if (psbtBytes[i] === 0x01 && psbtBytes[i + 1] === 0x13) {
      const valueLen = psbtBytes[i + 2];
      if (valueLen === 0x40 || valueLen === 0x41) {
        const sigBytes = psbtBytes.slice(i + 3, i + 3 + 64);
        return bytesToHex(sigBytes);
      }
    }
  }

  // Fallback: scan for 0x40 length-prefixed 64-byte sequences that look like
  // real signatures (first 32 bytes not all zeros)
  for (let i = 0; i < psbtBytes.length - 64; i++) {
    if (psbtBytes[i] === 0x40) {
      const sigBytes = psbtBytes.slice(i + 1, i + 1 + 64);
      const hasNonZero = sigBytes.slice(0, 32).some((b) => b !== 0);
      if (sigBytes.length === 64 && hasNonZero) {
        return bytesToHex(sigBytes);
      }
    }
  }

  throw new Error("Could not extract Schnorr signature from signed PSBT");
}

type Props = {
  client: WalletHubClient;
  wallet: ConnectedWallet;
  externalUserId: string;
};

const ASSET_META: Record<AssetType, { icon: string; label: string; unit: string }> = {
  btc: { icon: "₿", label: "Send BTC", unit: "sats" },
  arch: { icon: "⟠", label: "Send ARCH", unit: "lamports" },
  apl: { icon: "◈", label: "Send APL Token", unit: "lamports" },
};

const STEP_LABELS = ["Asset", "Details", "Review", "Complete"];

function formatSats(sats: number): string {
  return `${(sats / 1e8).toFixed(8)} BTC`;
}

function formatLamports(lamports: string): string {
  return `${(parseInt(lamports, 10) / 1e9).toFixed(6)} ARCH`;
}

export default function SendView({ client, wallet, externalUserId }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [asset, setAsset] = useState<AssetType | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [feeRate, setFeeRate] = useState(0);
  const [feeEstimates, setFeeEstimates] = useState<Record<string, number>>({});
  const [btcBalance, setBtcBalance] = useState<number | null>(null);
  const [archBalance, setArchBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [txResult, setTxResult] = useState<{ txid: string; rawTxid: string } | null>(null);

  useEffect(() => {
    client
      .getBtcAddressSummary(wallet.address)
      .then((s) => {
        const funded = s.chain_stats.funded_txo_sum + s.mempool_stats.funded_txo_sum;
        const spent = s.chain_stats.spent_txo_sum + s.mempool_stats.spent_txo_sum;
        setBtcBalance(funded - spent);
      })
      .catch(() => {});

    if (wallet.archAddress) {
      client
        .getWalletOverview(wallet.archAddress)
        .then((o) => setArchBalance(o.arch?.account?.balance ?? "0"))
        .catch(() => {});
    }
  }, [client, wallet]);

  useEffect(() => {
    if (asset !== "btc") return;
    client
      .getBtcFeeEstimates()
      .then((est) => {
        setFeeEstimates(est);
        const medium = est["6"] || est["3"] || Object.values(est)[0];
        if (medium) setFeeRate(Math.ceil(medium));
      })
      .catch(() => {});
  }, [asset, client]);

  const handleSelectAsset = useCallback((a: AssetType) => {
    setAsset(a);
    setStep(2);
    setError("");
  }, []);

  const handleDetailsNext = useCallback(() => {
    if (!recipient || !amount) {
      setError("Please fill in all fields");
      return;
    }
    setError("");
    setStep(3);
  }, [recipient, amount]);

  const handleBack = useCallback(() => {
    setError("");
    setStep((s) => Math.max(1, s - 1));
  }, []);

  const sendBtcTurnkey = useCallback(async () => {
    const res = await client.sendBitcoin({
      externalUserId,
      turnkeyResourceId: wallet.turnkeyResourceId!,
      toAddress: recipient,
      amountSats: parseInt(amount, 10),
      feeRate: feeRate || undefined,
    });
    return res.txid;
  }, [client, externalUserId, wallet, recipient, amount, feeRate]);

  const sendBtcXverse = useCallback(async () => {
    const { request } = await import("sats-connect");
    const response = await request("sendTransfer", {
      recipients: [{ address: recipient, amount: parseInt(amount, 10) }],
    });
    if (response.status === "success") {
      return (response.result as any).txid as string;
    }
    throw new Error("Transaction cancelled");
  }, [recipient, amount]);

  const sendBtcUnisat = useCallback(async () => {
    const txid = await (window as any).unisat.sendBitcoin(
      recipient,
      parseInt(amount, 10)
    );
    return txid as string;
  }, [recipient, amount]);

  const sendArchTurnkey = useCallback(async () => {
    const sr = await client.createSigningRequest({
      externalUserId,
      signer: { kind: "turnkey", resourceId: wallet.turnkeyResourceId! },
      action: { type: "arch.transfer", toAddress: recipient, lamports: amount },
    });
    const result = await client.signWithTurnkey(sr.signingRequestId, {
      externalUserId,
    });
    const res = result.result as any;
    return res?.txid || res?.txidHex || result.signingRequestId;
  }, [client, externalUserId, wallet, recipient, amount]);

  const sendArchExternal = useCallback(async () => {
    const sr = await client.createSigningRequest({
      externalUserId,
      signer: {
        kind: "external",
        taprootAddress: wallet.address,
        publicKeyHex: wallet.publicKey,
      },
      action: { type: "arch.transfer", toAddress: recipient, lamports: amount },
    });

    const psbtBase64 = (sr.payloadToSign as any)?.psbtBase64;
    if (!psbtBase64) throw new Error("No PSBT available for signing");

    let signature64Hex: string;

    if (wallet.type === "unisat") {
      if (!(window as any).unisat?.signPsbt) throw new Error("Unisat signPsbt not available");
      const psbtHex = bytesToHex(Uint8Array.from(atob(psbtBase64), (c) => c.charCodeAt(0)));
      const signedPsbtHex = await (window as any).unisat.signPsbt(psbtHex, { autoFinalized: false });
      signature64Hex = extractSchnorrSigFromPsbt(hexToBytes(signedPsbtHex));
    } else {
      const { request } = await import("sats-connect");
      const signResp: any = await request("signPsbt", {
        psbt: psbtBase64,
        signInputs: { [wallet.address]: [0] },
        broadcast: false,
      });
      if (signResp.status !== "success") throw new Error(signResp.error?.message || "Xverse signing failed");
      const signedPsbtBase64 = signResp.result?.psbt;
      if (!signedPsbtBase64) throw new Error("No signed PSBT returned from Xverse");
      signature64Hex = extractSchnorrSigFromPsbt(Uint8Array.from(atob(signedPsbtBase64), (c) => c.charCodeAt(0)));
    }

    const result = await client.submitSigningRequest(sr.signingRequestId, {
      externalUserId,
      signature64Hex,
    });
    const res = result.result as any;
    return res?.txid || res?.txidHex || result.signingRequestId;
  }, [client, externalUserId, wallet, recipient, amount]);

  const handleSubmit = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      let txid: string;

      if (asset === "btc") {
        if (wallet.type === "turnkey") txid = await sendBtcTurnkey();
        else if (wallet.type === "xverse") txid = await sendBtcXverse();
        else txid = await sendBtcUnisat();
      } else {
        if (wallet.type === "turnkey") txid = await sendArchTurnkey();
        else txid = await sendArchExternal();
      }

      const displayTxid = asset !== "btc" ? formatArchId(txid) : txid;
      setTxResult({ txid: displayTxid, rawTxid: txid });
      setStep(4);
    } catch (err: any) {
      setError(err.message || "Transaction failed");
    } finally {
      setLoading(false);
    }
  }, [asset, wallet, sendBtcTurnkey, sendBtcXverse, sendBtcUnisat, sendArchTurnkey, sendArchExternal]);

  const resetFlow = useCallback(() => {
    setStep(1);
    setAsset(null);
    setRecipient("");
    setAmount("");
    setFeeRate(0);
    setError("");
    setTxResult(null);
  }, []);

  const isTestnet = wallet.address.startsWith("tb1") || wallet.address.startsWith("bcrt1");
  const explorerUrl =
    asset === "btc"
      ? `https://mempool.space/${isTestnet ? "testnet/" : ""}tx/${txResult?.rawTxid}`
      : `https://explorer.arch.network/${isTestnet ? "testnet" : "mainnet"}/tx/${txResult?.rawTxid}`;

  return (
    <div className="send-view">
      <div className="send-steps-indicator">
        {STEP_LABELS.map((label, i) => (
          <div
            key={label}
            className={`send-step-dot${step === i + 1 ? " active" : ""}${step > i + 1 ? " done" : ""}`}
          >
            <span className="send-step-num">{step > i + 1 ? "✓" : i + 1}</span>
            <span className="send-step-label">{label}</span>
          </div>
        ))}
      </div>

      {error && <div className="send-error">{error}</div>}

      {step === 1 && (
        <div className="send-step">
          <h2 className="send-step-title">Choose Asset</h2>
          <div className="send-asset-grid">
            {(["btc", "arch", "apl"] as AssetType[]).map((a) => (
              <button
                key={a}
                className="send-asset-card"
                onClick={() => handleSelectAsset(a)}
              >
                <span className={`send-asset-icon ${a}`}>
                  {ASSET_META[a].icon}
                </span>
                <span className="send-asset-name">{ASSET_META[a].label}</span>
                <span className="send-asset-balance">
                  {a === "btc" && btcBalance !== null && formatSats(btcBalance)}
                  {a === "btc" && btcBalance === null && "Loading..."}
                  {a === "arch" && archBalance !== null && formatLamports(archBalance)}
                  {a === "arch" && archBalance === null && "Loading..."}
                  {a === "apl" && "Coming soon"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && asset && (
        <div className="send-step">
          <h2 className="send-step-title">{ASSET_META[asset].label}</h2>
          <div className="send-form">
            <div className="form-group">
              <label className="form-label">Recipient Address</label>
              <input
                className="form-input send-input"
                placeholder={asset === "btc" ? "bc1p... or tb1p..." : "arch1..."}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                Amount ({ASSET_META[asset].unit})
              </label>
              <input
                className="form-input send-input"
                type="number"
                min="0"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {asset === "btc" && btcBalance !== null && (
                <span className="form-hint">
                  Available: {formatSats(btcBalance)}
                </span>
              )}
              {asset !== "btc" && archBalance !== null && (
                <span className="form-hint">
                  Available: {formatLamports(archBalance)}
                </span>
              )}
            </div>
            {asset === "btc" && (
              <div className="form-group">
                <label className="form-label">Fee Rate (sat/vB)</label>
                <input
                  className="form-input send-input"
                  type="number"
                  min="1"
                  value={feeRate || ""}
                  onChange={(e) => setFeeRate(parseInt(e.target.value, 10) || 0)}
                />
                {Object.keys(feeEstimates).length > 0 && (
                  <div className="send-fee-hints">
                    {Object.entries(feeEstimates)
                      .slice(0, 3)
                      .map(([blocks, rate]) => (
                        <button
                          key={blocks}
                          className={`send-fee-option${feeRate === Math.ceil(rate) ? " active" : ""}`}
                          onClick={() => setFeeRate(Math.ceil(rate))}
                        >
                          {blocks} blk · {Math.ceil(rate)} sat/vB
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="send-actions">
            <button className="btn-secondary" onClick={handleBack}>
              Back
            </button>
            <button
              className="btn-primary"
              onClick={handleDetailsNext}
              disabled={!recipient || !amount}
            >
              Review
            </button>
          </div>
        </div>
      )}

      {step === 3 && asset && (
        <div className="send-step">
          <h2 className="send-step-title">Review &amp; Confirm</h2>
          <div className="send-review">
            <div className="send-review-row">
              <span className="send-review-label">From</span>
              <span className="send-review-value mono">
                {wallet.address.slice(0, 12)}…{wallet.address.slice(-8)}
              </span>
            </div>
            <div className="send-review-row">
              <span className="send-review-label">To</span>
              <span className="send-review-value mono">
                {recipient.slice(0, 12)}…{recipient.slice(-8)}
              </span>
            </div>
            <div className="send-review-row">
              <span className="send-review-label">Amount</span>
              <span className="send-review-value">
                {amount} {ASSET_META[asset].unit}
              </span>
            </div>
            {asset === "btc" && feeRate > 0 && (
              <div className="send-review-row">
                <span className="send-review-label">Fee Rate</span>
                <span className="send-review-value">{feeRate} sat/vB</span>
              </div>
            )}
            <div className="send-review-row">
              <span className="send-review-label">Wallet</span>
              <span className="send-review-value">
                <span className={`wallet-badge ${wallet.type}`}>
                  {wallet.type}
                </span>
              </span>
            </div>
          </div>
          <div className="send-actions">
            <button className="btn-secondary" onClick={handleBack}>
              Back
            </button>
            <button
              className="btn-primary"
              onClick={handleSubmit}
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="spinner small" /> Sending…
                </>
              ) : (
                "Sign & Submit"
              )}
            </button>
          </div>
        </div>
      )}

      {step === 4 && txResult && (
        <div className="send-step send-complete">
          <div className="complete-icon-wrapper">
            <div className="complete-icon success">✓</div>
          </div>
          <h2 className="send-step-title">Transaction Sent!</h2>
          <p className="send-step-desc">
            Your transaction has been submitted successfully.
          </p>
          <div className="complete-details">
            <div className="complete-detail-row">
              <span className="complete-detail-label">Transaction ID</span>
              <div className="complete-detail-value">
                <code>{txResult.txid}</code>
                <CopyButton text={txResult.txid} />
              </div>
            </div>
          </div>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="explorer-link"
          >
            View on Explorer ↗
          </a>
          <div className="send-actions send-actions-center">
            <button className="btn-secondary" onClick={resetFlow}>
              Send Another
            </button>
            <button className="btn-primary" onClick={() => navigate("/dashboard")}>
              Back to Dashboard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
