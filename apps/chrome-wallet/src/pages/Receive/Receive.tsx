import { useState, useEffect, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useWallet } from "../../hooks/useWallet";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import { useWideMode } from "../../hooks/useWideMode";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { getIndexer } from "../../utils/indexer";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { formatUsd } from "../../utils/format";
import CopyButton from "../../components/CopyButton";
import ArchIcon from "../../components/ArchIcon";

type Tab = "btc" | "arch";

const ASSETS: Record<Tab, { label: string; symbol: string; chain: string }> = {
  btc: { label: "Bitcoin", symbol: "BTC", chain: "Bitcoin" },
  arch: { label: "Arch", symbol: "ARCH", chain: "Arch Network" },
};

export default function Receive() {
  const { activeAccount, state } = useWallet();
  const { price: btcUsd } = useBtcUsdPrice();
  const wide = useWideMode(720);
  const [tab, setTab] = useState<Tab>("btc");
  const [archAddress, setArchAddress] = useState<string>("");

  const btcAddress = useMemo(
    () => activeAccount ? reEncodeTaprootAddress(activeAccount.btcAddress, state.network) : "",
    [activeAccount, state.network]
  );

  useEffect(() => {
    if (!activeAccount) return;
    // Prefer the locally derived Arch address (always available offline) and
    // confirm against the indexer's view if possible.
    const local =
      activeAccount.archAddress ||
      (activeAccount.publicKeyHex ? deriveArchAccountAddress(activeAccount.publicKeyHex) : "");
    if (local) setArchAddress(local);

    (async () => {
      try {
        const indexer = await getIndexer();
        if (!local) return;
        const summary = await indexer.getAccountSummary(local);
        const remote = summary?.address ?? local;
        setArchAddress(remote);
      } catch {
        // Indexer may 404 if the account hasn't been seen yet; the local
        // derivation is fine for receive-side display.
      }
    })();
  }, [activeAccount]);

  if (!activeAccount) return null;

  const address = tab === "btc" ? btcAddress : archAddress;
  const meta = ASSETS[tab];
  const networkLabel = tab === "btc"
    ? (state.network === "testnet4" ? "Bitcoin Testnet4" : "Bitcoin Mainnet")
    : (state.network === "testnet4" ? "Arch Testnet" : "Arch Mainnet");

  return (
    <div className="receive-page">
      <div className="receive-header">
        <h2 className="receive-title">Receive</h2>
        <div className="receive-subtitle">
          Share this address or QR code to receive {meta.label.toLowerCase()}.
        </div>
      </div>

      <div className="receive-segmented" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "btc"}
          className={`receive-segment ${tab === "btc" ? "active" : ""}`}
          onClick={() => setTab("btc")}
        >
          <span className="receive-segment-icon" aria-hidden>₿</span>
          <span>Bitcoin</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "arch"}
          className={`receive-segment ${tab === "arch" ? "active" : ""}`}
          onClick={() => setTab("arch")}
        >
          <span className="receive-segment-icon" aria-hidden>
            <ArchIcon size={12} color={tab === "arch" ? "#c19a5b" : "#777"} />
          </span>
          <span>Arch</span>
        </button>
      </div>

      <div className="receive-card">
        <div className="receive-qr-frame">
          {address ? (
            <QRCodeSVG
              value={address}
              size={wide ? 220 : 188}
              bgColor="#ffffff"
              fgColor="#0d0f17"
              level="M"
              marginSize={2}
            />
          ) : (
            <div className="receive-qr-skeleton" aria-hidden>
              <div className="spinner" />
            </div>
          )}
        </div>

        <div className="receive-meta">
          <div className="receive-meta-label">{meta.label} address</div>
          <div className="receive-meta-network">{networkLabel}</div>
        </div>

        {address ? (
          <div className="receive-address-card" title={address}>
            <code className="receive-address-text mono">{address}</code>
            <CopyButton text={address} className="receive-address-copy" />
          </div>
        ) : (
          <div className="receive-empty">
            {tab === "arch" ? "Resolving Arch address..." : "No address available"}
          </div>
        )}

        {tab === "btc" && btcUsd && (
          <div className="receive-price">
            <span className="receive-price-label">1 BTC</span>
            <span className="receive-price-sep">{"\u2248"}</span>
            <span className="receive-price-value">{formatUsd(btcUsd)}</span>
          </div>
        )}
      </div>

      <div className={`receive-warning ${tab === "btc" ? "warning-btc" : "warning-arch"}`}>
        <span className="receive-warning-icon" aria-hidden>!</span>
        <span>
          Only send <strong>{meta.symbol}</strong> on <strong>{networkLabel}</strong> to this address.
          Sending any other asset may result in lost funds.
        </span>
      </div>

      {tab === "arch" && !archAddress && (
        <div className="receive-hint">
          Fund this account with an airdrop from the Dashboard to initialize your Arch address.
        </div>
      )}
    </div>
  );
}
