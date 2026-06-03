/**
 * Send-inscription flow.
 *
 * URL: /send-inscription/:inscriptionId
 *
 * Two-step UI:
 *   Step 1 (Form)    -- recipient address; live-validated
 *   Step 2 (Confirm) -- read-only summary of postage, fee, change;
 *                       "Sign & Send" button
 * Plus terminal states:
 *   Sent  -- success screen with txid + explorer link
 *   Error -- inline banner; user stays on form
 *
 * Visual design mirrors SendRune.tsx / Send.tsx one-for-one
 * (`send-form-shell`, `page-header`, `back-link`, `asset-summary-chip`,
 * `form-field`, `review-card`, `send-success`, `btn`).
 *
 * Unlike runes there is no amount input: an inscription is a single
 * indivisible asset. The whole inscribed output is moved to the
 * recipient and the fee is paid from plain BTC (see
 * utils/inscription-psbt.ts). Signing path is identical to a plain
 * BTC send (no OP_RETURN), so both external wallets and Turnkey use
 * their standard PSBT signer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { signerForAccount } from "../../signers/Signer";
import {
  getIndexer,
  isIndexerNotFoundError,
  type BtcInscriptionSummary,
  type IndexerClient,
} from "../../utils/indexer";
import {
  buildUnsignedInscriptionPsbt,
  type BuildInscriptionPsbtResult,
} from "../../utils/inscription-psbt";
import { finalizeSignedPsbt } from "../../utils/btc-psbt";
import { isExternalAccount } from "../../state/types";
import { getExternalWalletAdapter } from "../../wallets/external-wallets";
import { buildExplorerUrl, notifyTxBroadcast } from "../../utils/notifications";
import { formatBtc } from "../../utils/format";
import BackBar from "../../components/BackBar";
import { InscriptionThumb } from "../../components/InscriptionThumb";
import {
  clearSendForm,
  loadSendForm,
  saveSendForm,
} from "../../state/send-form-session";

type Step = "form" | "confirm" | "sent";

function inscriptionTitle(insc: BtcInscriptionSummary): string {
  if (typeof insc.number === "number") return `Inscription #${insc.number}`;
  return `${insc.id.slice(0, 10)}\u2026${insc.id.slice(-8)}`;
}

export default function SendInscription() {
  const { inscriptionId: idParam } = useParams<{ inscriptionId: string }>();
  const navigate = useNavigate();
  const { state, activeAccount } = useWallet();

  const inscriptionId = decodeURIComponent(idParam ?? "");

  const [indexer, setIndexer] = useState<IndexerClient | null>(null);
  const [summary, setSummary] = useState<BtcInscriptionSummary | null>(null);
  const [loadError, setLoadError] = useState<string>("");

  const [step, setStep] = useState<Step>("form");
  const [recipient, setRecipient] = useState<string>("");
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<BuildInscriptionPsbtResult | null>(null);
  const [signing, setSigning] = useState(false);
  const [signStatus, setSignStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [sentTxid, setSentTxid] = useState<string>("");

  // ── Load the inscription metadata ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setLoadError("");
    if (!inscriptionId) return;
    (async () => {
      try {
        const ix = await getIndexer();
        if (cancelled) return;
        setIndexer(ix);
        const s = await ix.getBtcInscription(inscriptionId);
        if (cancelled) return;
        setSummary(s);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(
          isIndexerNotFoundError(e)
            ? "This inscription could not be found."
            : e?.message ?? "Failed to load inscription"
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inscriptionId]);

  // ── Form-state persistence (chrome.storage.session) ───────────
  const formRestoredRef = useRef(false);
  useEffect(() => {
    if (formRestoredRef.current) return;
    if (!activeAccount || !inscriptionId) return;
    formRestoredRef.current = true;
    (async () => {
      const ck = await loadSendForm({
        kind: "inscription",
        accountId: activeAccount.id,
        network: state.network,
        inscriptionId,
      });
      if (!ck || ck.form.kind !== "inscription") return;
      setRecipient(ck.form.recipient);
    })();
  }, [activeAccount, inscriptionId, state.network]);

  useEffect(() => {
    if (!activeAccount || !inscriptionId) return;
    if (step !== "form") return;
    if (!recipient) return;
    void saveSendForm({
      form: { kind: "inscription", inscriptionId, recipient },
      accountId: activeAccount.id,
      network: state.network,
    });
  }, [step, recipient, activeAccount, inscriptionId, state.network]);

  useEffect(() => {
    if (step === "sent") {
      void clearSendForm();
    }
  }, [step]);

  // ── Form validation ────────────────────────────────────────────
  const canContinue = !!summary && recipient.trim().length > 0;

  // ── Step transitions ───────────────────────────────────────────
  const handleContinue = useCallback(async () => {
    if (!activeAccount?.btcAddress || !summary) return;
    setPreparing(true);
    setError("");
    try {
      const ix = await getIndexer();
      const result = await buildUnsignedInscriptionPsbt({
        indexer: ix,
        fromAddress: activeAccount.btcAddress,
        toAddress: recipient.trim(),
        inscriptionId,
        satpoint: summary.satpoint,
      });
      setPrepared(result);
      setStep("confirm");
    } catch (err: any) {
      const msg =
        err?.code === "INSCRIPTION_NOT_FOUND"
          ? "This inscription isn't on a UTXO held by this wallet anymore. Refresh your collectibles."
          : err?.code === "INSUFFICIENT_BTC_FOR_INSCRIPTION_SEND"
          ? "Not enough plain BTC to cover the network fee. Send some BTC to this address first."
          : err?.message ?? "Failed to prepare transaction";
      setError(msg);
    } finally {
      setPreparing(false);
    }
  }, [activeAccount?.btcAddress, summary, recipient, inscriptionId]);

  const handleSign = useCallback(async () => {
    if (!activeAccount || !prepared) return;
    setSigning(true);
    setError("");
    setSignStatus("Signing transaction\u2026");
    try {
      let signedPsbtBase64: string;
      if (isExternalAccount(activeAccount)) {
        const adapter = getExternalWalletAdapter(activeAccount.externalProvider);
        setSignStatus(`Waiting for ${adapter.label} to sign\u2026`);
        const signed = await adapter.signBtcPsbt({
          address: activeAccount.btcAddress,
          psbtBase64: prepared.psbt.toBase64(),
          network: state.network,
          inputIndexes: Array.from({ length: prepared.inputCount }, (_, i) => i),
        });
        signedPsbtBase64 = signed.signedPsbtBase64;
      } else {
        if (!activeAccount.organizationId) {
          throw new Error("Missing organization ID for this wallet");
        }
        const { signedPsbtHex } = await signerForAccount(activeAccount).signPsbt({
          psbtHex: prepared.psbt.toHex(),
        });
        signedPsbtBase64 = hexToBase64(signedPsbtHex);
      }

      setSignStatus("Broadcasting transaction\u2026");
      const rawTxHex = finalizeSignedPsbt(signedPsbtBase64, prepared.network);
      const ix = await getIndexer();
      const txid = await ix.broadcastBtc(rawTxHex);
      setSentTxid(txid);
      setStep("sent");

      void notifyTxBroadcast({
        title: "Inscription sent",
        message: `${summary ? inscriptionTitle(summary) : "Inscription"} broadcast`,
        explorerUrl: buildExplorerUrl({ kind: "btc", txid, network: state.network }),
      });
    } catch (err: any) {
      setError(err?.message ?? "Signing or broadcast failed");
    } finally {
      setSigning(false);
      setSignStatus("");
    }
  }, [activeAccount, prepared, summary, state.network]);

  // ── Derived UI values ──────────────────────────────────────────
  const networkPlaceholder = state.network === "mainnet" ? "bc1p\u2026" : "tb1p\u2026";
  const explorerUrl = sentTxid
    ? buildExplorerUrl({ kind: "btc", txid: sentTxid, network: state.network })
    : "";
  const title = useMemo(
    () => (summary ? inscriptionTitle(summary) : "Inscription"),
    [summary]
  );

  // ── Early-return states ────────────────────────────────────────
  if (!inscriptionId) {
    return (
      <div className="send-form-shell">
        <div className="page-header">
          <h2 className="page-title">Send Inscription</h2>
          <div className="page-subtitle">No inscription was specified.</div>
        </div>
        <button className="btn btn-secondary btn-full" onClick={() => navigate("/collectibles")}>
          Back to collectibles
        </button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="send-form-shell">
        <BackBar onBack={() => navigate("/collectibles")} />
        <div className="page-header">
          <h2 className="page-title">Send Inscription</h2>
        </div>
        <div className="error-banner">{loadError}</div>
        <button className="btn btn-secondary btn-full" onClick={() => navigate("/collectibles")}>
          Back to collectibles
        </button>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="send-form-shell">
        <div className="page-header">
          <h2 className="page-title">Loading\u2026</h2>
        </div>
      </div>
    );
  }

  // ── Sent terminal state ────────────────────────────────────────
  if (step === "sent") {
    return (
      <div className="send-form-shell">
        <div className="send-success">
          <div className="send-success-badge" aria-hidden>✓</div>
          <h2 className="send-success-title">Inscription sent</h2>
          <div className="send-success-subtitle">
            {title} is broadcasting on the Bitcoin network.
          </div>
          {sentTxid && <div className="send-success-txid">{sentTxid}</div>}
          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm btn-secondary"
            >
              View on Mempool {"\u2192"}
            </a>
          )}
        </div>
        <button className="btn btn-primary btn-full" onClick={() => navigate("/collectibles")}>
          Done
        </button>
      </div>
    );
  }

  // ── Confirm step ───────────────────────────────────────────────
  if (step === "confirm" && prepared) {
    return (
      <div className="send-form-shell">
        <BackBar
          onBack={() => {
            setStep("form");
            setError("");
          }}
          disabled={signing}
        />
        <div className="page-header">
          <h2 className="page-title">Review</h2>
          <div className="page-subtitle">Double-check the details before signing this transaction.</div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="review-card">
          <div className="review-row">
            <div className="review-row-label">Asset</div>
            <div className="review-row-value">
              <span className="review-row-primary">{title}</span>
              <span className="review-row-sub">{summary.content_type}</span>
            </div>
          </div>
          <div className="review-row">
            <div className="review-row-label">To</div>
            <div className="review-row-value">
              <span className="review-row-mono">{prepared.toAddress}</span>
            </div>
          </div>

          <div className="review-section">
            <div className="review-section-label">Network Fee</div>
            <div className="review-section-row">
              <span className="label">Postage</span>
              <span className="value">{prepared.recipientSats.toLocaleString()} sats</span>
            </div>
            <div className="review-section-row">
              <span className="label">Fee</span>
              <span className="value">
                {prepared.feeSats.toLocaleString()} sats ({formatBtc(prepared.feeSats)} BTC)
              </span>
            </div>
            <div className="review-section-row">
              <span className="label">Fee rate</span>
              <span className="value">{prepared.feeRate.toFixed(1)} sat/vB</span>
            </div>
            <div className="review-section-row">
              <span className="label">Inputs</span>
              <span className="value">1 inscribed + {prepared.btcInputCount} BTC</span>
            </div>
            {prepared.changeSats > 0 && (
              <div className="review-section-row">
                <span className="label">BTC change</span>
                <span className="value">{prepared.changeSats.toLocaleString()} sats</span>
              </div>
            )}
          </div>
        </div>

        {signStatus && (
          <div className="form-field-hint" style={{ marginBottom: 8 }}>
            {signStatus}
          </div>
        )}

        <button
          className="btn btn-primary btn-full"
          onClick={handleSign}
          disabled={signing}
        >
          {signing ? (signStatus || "Signing\u2026") : "Sign & Send"}
        </button>
      </div>
    );
  }

  // ── Form step ──────────────────────────────────────────────────
  const handleCancelToCollectibles = () => {
    void clearSendForm();
    navigate("/collectibles");
  };
  return (
    <div className="send-form-shell">
      <BackBar onBack={handleCancelToCollectibles} />
      <div className="page-header">
        <h2 className="page-title">Send {title}</h2>
        <div className="page-subtitle">Enter the recipient address.</div>
      </div>

      <div className="asset-summary-chip">
        {indexer && (
          <div className="asset-icon" aria-hidden style={{ padding: 0, overflow: "hidden" }}>
            <InscriptionThumb indexer={indexer} summary={summary} size={40} />
          </div>
        )}
        <div className="asset-summary-chip-info">
          <div className="asset-summary-chip-name">{title}</div>
          <div className="asset-summary-chip-sub">Ordinal inscription</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="form-field">
        <div className="form-field-header">
          <label className="form-field-label">Recipient address</label>
        </div>
        <div className="form-field-input">
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={networkPlaceholder}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="form-field-hint">
          The entire inscribed output is sent to the recipient; the network fee is paid from your plain BTC.
        </div>
      </div>

      <button
        className="btn btn-primary btn-full"
        onClick={handleContinue}
        disabled={!canContinue || preparing}
      >
        {preparing ? "Preparing\u2026" : "Review"}
      </button>
    </div>
  );
}

// Copy of SendRune.tsx's helper. Inlined to avoid a circular import;
// a future consolidation PR can move both into a shared utility.
function hexToBase64(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
