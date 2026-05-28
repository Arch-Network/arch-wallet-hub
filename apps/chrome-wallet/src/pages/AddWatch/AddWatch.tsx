/**
 * Add a watch-only wallet by pasting a taproot address.
 *
 * The flow is intentionally minimal: label + address, with a strict
 * preview of the resulting Arch identity so the user can verify
 * before saving. There's no scanning support yet (QR code) -- the
 * common case is a user pasting from a hardware wallet's export.
 *
 * Why we don't ship a generic "watch any address" today: the Arch
 * network identifies accounts by their x-only public key, which is
 * recoverable from a taproot address (the bech32m payload IS the
 * key) but not from P2PKH / P2SH / P2WPKH. Building partial-feature
 * watch accounts whose Arch view doesn't work would be worse than
 * refusing up-front.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { walletStore } from "../../state/wallet-store";
import {
  buildWatchAccount,
  InvalidWatchAddressError,
} from "../../utils/watch-account";
import { truncateAddress } from "../../utils/format";

export default function AddWatch() {
  const navigate = useNavigate();
  const { state } = useWallet();
  const [label, setLabel] = useState("");
  const [taprootAddress, setTaprootAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live preview of what gets stored. We compute it on every keystroke;
  // failures surface as `null` here and as a banner on submit.
  const preview = useMemo(() => {
    if (!taprootAddress.trim() || !label.trim()) return null;
    try {
      return buildWatchAccount({
        taprootAddress: taprootAddress.trim(),
        label: label.trim(),
        network: state.network,
      });
    } catch {
      return null;
    }
  }, [taprootAddress, label, state.network]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const account = buildWatchAccount({
        taprootAddress: taprootAddress.trim(),
        label: label.trim(),
        network: state.network,
      });
      // Refuse duplicates: a second watch import of the same address
      // would create a second WalletAccount row with the same id and
      // confuse the active-account selector.
      if (state.accounts.some((a) => a.id === account.id)) {
        throw new InvalidWatchAddressError(
          "This address is already in your wallet.",
        );
      }
      await walletStore.addAccount(account);
      navigate("/dashboard");
    } catch (e: any) {
      setError(
        e instanceof InvalidWatchAddressError
          ? e.reason
          : e?.message || "Could not add watch-only wallet",
      );
    } finally {
      setSubmitting(false);
    }
  }, [taprootAddress, label, state.network, state.accounts, navigate]);

  return (
    <>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <h2 className="page-title">Add Watch-Only Wallet</h2>
        <div className="page-subtitle">
          Monitor a cold-storage address. The wallet can show its balance and
          history but cannot sign transactions for it.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="input-label">Label</div>
        <input
          className="input"
          type="text"
          placeholder="e.g. Trezor cold wallet"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={40}
        />
        <div className="input-label" style={{ marginTop: 12 }}>
          Taproot Address (bc1p… on mainnet, tb1p… on testnet4)
        </div>
        <textarea
          className="input"
          placeholder={state.network === "mainnet" ? "bc1p…" : "tb1p…"}
          value={taprootAddress}
          onChange={(e) => setTaprootAddress(e.target.value)}
          rows={3}
          style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
        <p style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
          Only taproot (P2TR) addresses are supported. Legacy address types
          cannot be added as watch-only because the Arch identity is
          unrecoverable without the public key.
        </p>
      </div>

      {preview && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="input-label">Preview</div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            <div>
              <strong>{preview.label}</strong>
            </div>
            <div className="mono" style={{ marginTop: 4, fontSize: 11 }}>
              BTC: {truncateAddress(preview.btcAddress)}
            </div>
            {preview.archAddress && (
              <div className="mono" style={{ fontSize: 11 }}>
                Arch: {truncateAddress(preview.archAddress)}
              </div>
            )}
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              Network: {state.network === "mainnet" ? "Mainnet" : "Testnet4"} ·
              Watch-only (cannot sign)
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button
          type="button"
          className="btn btn-secondary btn-full"
          onClick={() => navigate(-1)}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary btn-full"
          onClick={handleSubmit}
          disabled={submitting || !preview}
        >
          {submitting ? "Adding…" : "Add wallet"}
        </button>
      </div>
    </>
  );
}
