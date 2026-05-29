/**
 * Send-rune flow.
 *
 * URL: /send-rune/:runeId (rune id is the canonical "block:tx" form)
 *
 * Two-step UI:
 *   Step 1 (Form)    -- recipient, amount; live-validated
 *   Step 2 (Confirm) -- read-only summary of fee, leftover, change;
 *                       "Sign & Send" button
 * Plus terminal states:
 *   Sent  -- success screen with txid + explorer link
 *   Error -- inline banner; user stays on form
 *
 * Visual design intentionally mirrors Send.tsx (BTC/ARCH/APL flow)
 * one-for-one: `send-form-shell` shell, `page-header`, `back-link`
 * chevron, `asset-summary-chip`, `form-field`, `review-card`,
 * `send-success`, `btn btn-primary btn-full`. Reusing existing
 * classes (defined in styles/global.css) keeps a single source of
 * truth for spacing, typography, error/banner styling and gives
 * SendRune the same gloss the rest of the wallet has -- the
 * original version inlined raw styles and looked half-finished
 * next to the BTC flow.
 *
 * Signing path mirrors Send.tsx exactly:
 *   - External wallets (Xverse / UniSat): adapter.signBtcPsbt
 *   - Internal (Turnkey passkey/email): signerForAccount(...).signPsbt
 *
 * The PSBT itself is the same shape both signers expect; only the
 * signer differs.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { signerForAccount } from "../../signers/Signer";
import { getIndexer, type BtcAddressRuneBalance } from "../../utils/indexer";
import { buildUnsignedRunePsbt, type BuildRunePsbtResult } from "../../utils/rune-psbt";
import { finalizeSignedPsbt } from "../../utils/btc-psbt";
import { formatRuneAmount, labelForRune, parseRuneAmount } from "../../utils/runes-format";
import { isExternalAccount } from "../../state/types";
import { getExternalWalletAdapter } from "../../wallets/external-wallets";
import { buildExplorerUrl, notifyTxBroadcast } from "../../utils/notifications";
import { formatBtc } from "../../utils/format";

type Step = "form" | "confirm" | "sent";

export default function SendRune() {
  const { runeId: runeIdParam } = useParams<{ runeId: string }>();
  const navigate = useNavigate();
  const { state, activeAccount } = useWallet();

  const runeId = decodeURIComponent(runeIdParam ?? "");

  // Balance for THIS rune from the active address. We refetch on
  // mount; the dashboard's cached value would be stale on a
  // back-navigate after a confirmed send.
  const [balance, setBalance] = useState<BtcAddressRuneBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string>("");

  const [step, setStep] = useState<Step>("form");
  const [recipient, setRecipient] = useState<string>("");
  const [amountText, setAmountText] = useState<string>("");
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<BuildRunePsbtResult | null>(null);
  const [signing, setSigning] = useState(false);
  const [signStatus, setSignStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [sentTxid, setSentTxid] = useState<string>("");

  // ── Load the rune balance for this address ─────────────────────
  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    setBalanceError("");
    if (!activeAccount?.btcAddress || !runeId) return;
    (async () => {
      try {
        const indexer = await getIndexer();
        const r = await indexer.getBtcAddressRunes(activeAccount.btcAddress);
        if (cancelled) return;
        const match = (r?.balances ?? []).find((b) => b.rune_id === runeId);
        if (!match) {
          setBalanceError("You don't hold this rune");
          return;
        }
        setBalance(match);
      } catch (e: any) {
        if (cancelled) return;
        setBalanceError(e?.message ?? "Failed to load balance");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAccount?.btcAddress, runeId]);

  // ── Form validation ────────────────────────────────────────────
  const amountMinor = useMemo(() => {
    if (!balance) return null;
    return parseRuneAmount(amountText, balance.divisibility);
  }, [amountText, balance]);

  const amountExceedsBalance = useMemo(() => {
    if (!balance || amountMinor === null) return false;
    try {
      return amountMinor > BigInt(balance.amount);
    } catch {
      return false;
    }
  }, [amountMinor, balance]);

  const canContinue =
    !!balance &&
    recipient.trim().length > 0 &&
    amountMinor !== null &&
    amountMinor > 0n &&
    !amountExceedsBalance;

  // ── Step transitions ───────────────────────────────────────────
  const handleContinue = useCallback(async () => {
    if (!activeAccount?.btcAddress || !balance || amountMinor === null) return;
    setPreparing(true);
    setError("");
    try {
      const indexer = await getIndexer();
      const result = await buildUnsignedRunePsbt({
        indexer,
        fromAddress: activeAccount.btcAddress,
        toAddress: recipient.trim(),
        runeId,
        amount: amountMinor,
      });
      setPrepared(result);
      setStep("confirm");
    } catch (err: any) {
      const msg =
        err?.code === "INSUFFICIENT_RUNE_BALANCE"
          ? `Not enough ${balance.spaced_name}: have ${formatRuneAmount(balance.amount, balance.divisibility)}`
          : err?.code === "INSUFFICIENT_BTC_FOR_RUNE_SEND"
          ? "Not enough plain BTC to cover the runestone fees + dust. Send some BTC to this address first."
          : err?.message ?? "Failed to prepare transaction";
      setError(msg);
    } finally {
      setPreparing(false);
    }
  }, [activeAccount?.btcAddress, balance, amountMinor, recipient, runeId]);

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
      const indexer = await getIndexer();
      const txid = await indexer.broadcastBtc(rawTxHex);
      setSentTxid(txid);
      setStep("sent");

      const human = balance
        ? formatRuneAmount(prepared.amount.toString(), balance.divisibility)
        : prepared.amount.toString();
      void notifyTxBroadcast({
        title: "Rune transfer broadcast",
        message: `${human} ${balance?.spaced_name ?? ""} sent`,
        explorerUrl: buildExplorerUrl({ kind: "btc", txid, network: state.network }),
      });
    } catch (err: any) {
      setError(err?.message ?? "Signing or broadcast failed");
    } finally {
      setSigning(false);
      setSignStatus("");
    }
  }, [activeAccount, prepared, balance, state.network]);

  // ── Derived UI values ──────────────────────────────────────────
  const balanceHuman = balance ? formatRuneAmount(balance.amount, balance.divisibility) : "";
  const label = balance ? labelForRune(balance) : "";
  const runeGlyph = balance?.symbol && balance.symbol.trim().length > 0 ? balance.symbol : "\u00A4";
  const networkPlaceholder = state.network === "mainnet" ? "bc1p\u2026" : "tb1p\u2026";
  const explorerUrl = sentTxid
    ? buildExplorerUrl({ kind: "btc", txid: sentTxid, network: state.network })
    : "";

  // ── Early-return states ────────────────────────────────────────
  if (!runeId) {
    return (
      <div className="send-form-shell">
        <div className="page-header">
          <h2 className="page-title">Send Rune</h2>
          <div className="page-subtitle">No rune was specified.</div>
        </div>
        <button className="btn btn-secondary btn-full" onClick={() => navigate("/dashboard")}>
          Back to dashboard
        </button>
      </div>
    );
  }

  if (balanceError) {
    return (
      <div className="send-form-shell">
        <button className="back-link" onClick={() => navigate("/dashboard")}>
          <BackChevron />
          Back
        </button>
        <div className="page-header">
          <h2 className="page-title">Send {labelForRune({ spaced_name: runeId })}</h2>
        </div>
        <div className="error-banner">{balanceError}</div>
        <button className="btn btn-secondary btn-full" onClick={() => navigate("/dashboard")}>
          Back to dashboard
        </button>
      </div>
    );
  }

  if (!balance) {
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
    const sentHuman = prepared
      ? formatRuneAmount(prepared.amount.toString(), balance.divisibility)
      : "";
    return (
      <div className="send-form-shell">
        <div className="send-success">
          <div className="send-success-badge" aria-hidden>✓</div>
          <h2 className="send-success-title">Rune transfer sent</h2>
          <div className="send-success-subtitle">
            {sentHuman} {balance.spaced_name} is broadcasting on the Bitcoin network.
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
        <button className="btn btn-primary btn-full" onClick={() => navigate("/dashboard")}>
          Done
        </button>
      </div>
    );
  }

  // ── Confirm step ───────────────────────────────────────────────
  if (step === "confirm" && prepared) {
    const sendAmountHuman = formatRuneAmount(prepared.amount.toString(), balance.divisibility);
    const leftoverHuman = formatRuneAmount(prepared.leftoverRune.toString(), balance.divisibility);
    return (
      <div className="send-form-shell">
        <button
          className="back-link"
          onClick={() => {
            setStep("form");
            setError("");
          }}
          disabled={signing}
        >
          <BackChevron />
          Back
        </button>
        <div className="page-header">
          <h2 className="page-title">Review</h2>
          <div className="page-subtitle">Double-check the details before signing this transaction.</div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="review-card">
          <div className="review-row">
            <div className="review-row-label">Asset</div>
            <div className="review-row-value">
              <span className="review-row-primary">
                <RuneInlineIcon glyph={runeGlyph} />
                {label}
              </span>
            </div>
          </div>
          <div className="review-row">
            <div className="review-row-label">To</div>
            <div className="review-row-value">
              <span className="review-row-mono">{prepared.toAddress}</span>
            </div>
          </div>
          <div className="review-row">
            <div className="review-row-label">Amount</div>
            <div className="review-row-value">
              <span className="review-row-primary">
                {sendAmountHuman} {balance.spaced_name}
              </span>
            </div>
          </div>
          {prepared.leftoverRune > 0n && (
            <div className="review-row">
              <div className="review-row-label">Leftover</div>
              <div className="review-row-value">
                <span className="review-row-primary">
                  {leftoverHuman} {balance.spaced_name}
                </span>
                <span className="review-row-sub">returned to you</span>
              </div>
            </div>
          )}

          <div className="review-section">
            <div className="review-section-label">Network Fee</div>
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
              <span className="value">
                {prepared.runedInputCount} runed + {prepared.btcInputCount} BTC
              </span>
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
  return (
    <div className="send-form-shell">
      <button className="back-link" onClick={() => navigate("/dashboard")}>
        <BackChevron />
        Back
      </button>
      <div className="page-header">
        <h2 className="page-title">Send {balance.spaced_name}</h2>
        <div className="page-subtitle">Enter the recipient address and the amount to send.</div>
      </div>

      <div className="asset-summary-chip">
        <div className="asset-icon apl" aria-hidden>{runeGlyph}</div>
        <div className="asset-summary-chip-info">
          <div className="asset-summary-chip-name">{balance.spaced_name}</div>
          <div className="asset-summary-chip-sub">Rune</div>
        </div>
        <div className="asset-summary-chip-balance">
          <div className="asset-summary-chip-balance-label">Available</div>
          <div className="asset-summary-chip-balance-value">
            {balanceHuman} {balance.spaced_name}
          </div>
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
      </div>

      <div className="form-field">
        <div className="form-field-header">
          <label className="form-field-label">Amount</label>
          <span className="form-field-meta">
            Available <strong>{balanceHuman}</strong>
          </span>
        </div>
        <div className="form-field-input">
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="0"
          />
          <span className="form-field-suffix">{balance.spaced_name}</span>
          <button
            type="button"
            className="form-field-action"
            onClick={() => setAmountText(balanceHuman)}
          >
            MAX
          </button>
        </div>
        {amountText.length > 0 && amountMinor === null && (
          <div className="form-field-hint" style={{ color: "var(--danger, #ff6b6b)" }}>
            Invalid amount (max {balance.divisibility} decimal places)
          </div>
        )}
        {amountExceedsBalance && (
          <div className="form-field-hint" style={{ color: "var(--danger, #ff6b6b)" }}>
            Exceeds available balance
          </div>
        )}
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

// Small visual primitives kept local to this file -- they're not
// reused elsewhere and inlining keeps the component file readable.

function BackChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function RuneInlineIcon({ glyph }: { glyph: string }) {
  // Matches the BTC/ARCH inline icons used in Send.tsx's review row.
  // We don't have a dedicated rune CSS variant, so reuse `apl` --
  // visually consistent with the dashboard's rune rows.
  return (
    <span
      className="send-inline-icon"
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        marginRight: 6,
      }}
    >
      {glyph}
    </span>
  );
}

// Copy of Send.tsx's helper. Inlined here to avoid a circular
// import; the upcoming consolidation PR can move both into a
// shared utility if it becomes a maintenance burden.
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
