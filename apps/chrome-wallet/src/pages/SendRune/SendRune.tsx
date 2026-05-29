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
 *   Error -- inline message; user stays on form
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
    setSignStatus("Signing transaction…");
    try {
      let signedPsbtBase64: string;
      if (isExternalAccount(activeAccount)) {
        const adapter = getExternalWalletAdapter(activeAccount.externalProvider);
        setSignStatus(`Waiting for ${adapter.label} to sign…`);
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

      setSignStatus("Broadcasting transaction…");
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

  // ── Render ─────────────────────────────────────────────────────
  if (!runeId) {
    return (
      <div className="page-content">
        <p>No rune specified.</p>
        <button onClick={() => navigate("/dashboard")}>Back to dashboard</button>
      </div>
    );
  }

  if (balanceError) {
    return (
      <div className="page-content">
        <h2>{labelForRune({ spaced_name: runeId })}</h2>
        <p style={{ color: "var(--danger, #ff6b6b)" }}>{balanceError}</p>
        <button onClick={() => navigate("/dashboard")}>Back to dashboard</button>
      </div>
    );
  }

  if (!balance) {
    return (
      <div className="page-content">
        <p>Loading balance\u2026</p>
      </div>
    );
  }

  const balanceHuman = formatRuneAmount(balance.amount, balance.divisibility);
  const label = labelForRune(balance);

  if (step === "sent") {
    return (
      <div className="page-content">
        <h2>Sent</h2>
        <p>{prepared && formatRuneAmount(prepared.amount.toString(), balance.divisibility)} {balance.spaced_name} broadcast.</p>
        <p style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" }}>
          {sentTxid}
        </p>
        <a
          href={buildExplorerUrl({ kind: "btc", txid: sentTxid, network: state.network })}
          target="_blank"
          rel="noreferrer noopener"
        >
          View on explorer
        </a>
        <div style={{ marginTop: 16 }}>
          <button onClick={() => navigate("/dashboard")}>Done</button>
        </div>
      </div>
    );
  }

  if (step === "confirm" && prepared) {
    return (
      <div className="page-content">
        <h2>Confirm send</h2>
        <ConfirmRow k="Asset" v={label} />
        <ConfirmRow
          k="Amount"
          v={`${formatRuneAmount(prepared.amount.toString(), balance.divisibility)} ${balance.spaced_name}`}
        />
        <ConfirmRow k="To" v={prepared.toAddress} mono />
        <ConfirmRow k="Fee" v={`${formatBtc(prepared.feeSats)} BTC (${prepared.feeRate} sat/vB)`} />
        <ConfirmRow k="Inputs" v={`${prepared.runedInputCount} runed + ${prepared.btcInputCount} BTC`} />
        {prepared.leftoverRune > 0n && (
          <ConfirmRow
            k="Leftover"
            v={`${formatRuneAmount(prepared.leftoverRune.toString(), balance.divisibility)} ${balance.spaced_name} returned to you`}
          />
        )}
        <ConfirmRow k="BTC change" v={`${formatBtc(prepared.changeSats)} BTC`} />

        {error && <p style={{ color: "var(--danger, #ff6b6b)" }}>{error}</p>}
        {signStatus && <p style={{ color: "var(--text-muted)" }}>{signStatus}</p>}

        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              setStep("form");
              setError("");
            }}
            disabled={signing}
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleSign}
            disabled={signing}
            style={{ flex: 1 }}
          >
            {signing ? "Signing\u2026" : "Sign & send"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content">
      <h2>Send {balance.spaced_name}</h2>
      <p style={{ color: "var(--text-muted)" }}>
        Available: {balanceHuman} {balance.spaced_name}
      </p>

      <label style={{ display: "block", marginTop: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Recipient address</div>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder={state.network === "testnet4" ? "tb1p\u2026" : "bc1p\u2026"}
          style={{ width: "100%", marginTop: 4, fontFamily: "monospace" }}
        />
      </label>

      <label style={{ display: "block", marginTop: 12 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Amount ({balance.spaced_name})
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <input
            type="text"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            onClick={() => setAmountText(balanceHuman)}
            disabled={!balance}
          >
            MAX
          </button>
        </div>
        {amountText.length > 0 && amountMinor === null && (
          <div style={{ fontSize: 12, color: "var(--danger, #ff6b6b)", marginTop: 4 }}>
            Invalid amount (max {balance.divisibility} decimal places)
          </div>
        )}
        {amountExceedsBalance && (
          <div style={{ fontSize: 12, color: "var(--danger, #ff6b6b)", marginTop: 4 }}>
            Exceeds available balance
          </div>
        )}
      </label>

      {error && (
        <p style={{ color: "var(--danger, #ff6b6b)", marginTop: 12 }}>{error}</p>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <button type="button" onClick={() => navigate("/dashboard")}>
          Cancel
        </button>
        <button
          type="button"
          onClick={handleContinue}
          disabled={!canContinue || preparing}
          style={{ flex: 1 }}
        >
          {preparing ? "Preparing\u2026" : "Continue"}
        </button>
      </div>
    </div>
  );
}

function ConfirmRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{k}</div>
      <div
        style={{
          fontFamily: mono ? "monospace" : undefined,
          fontSize: mono ? 12 : 14,
          wordBreak: "break-all",
        }}
      >
        {v}
      </div>
    </div>
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

