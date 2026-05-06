import { useState, useEffect, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useWallet } from "../../hooks/useWallet";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { getIndexer } from "../../utils/indexer";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import CopyButton from "../../components/CopyButton";
import ArchIcon from "../../components/ArchIcon";

type Tab = "btc" | "arch";

export default function Receive() {
  const { activeAccount, state } = useWallet();
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
  const label = tab === "btc" ? "Bitcoin Address" : "Arch Address";

  return (
    <>
      <div className="tabs">
        <button className={`tab ${tab === "btc" ? "active" : ""}`} onClick={() => setTab("btc")}>
          ₿ Bitcoin
        </button>
        <button className={`tab ${tab === "arch" ? "active" : ""}`} onClick={() => setTab("arch")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><ArchIcon size={12} color={tab === "arch" ? "#c19a5b" : "#888"} /> ARCH</span>
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <div className="qr-container">
          {address ? (
            <QRCodeSVG value={address} size={180} bgColor="#ffffff" fgColor="#0d0f17" />
          ) : (
            <div className="spinner" />
          )}
        </div>

        <div className="input-label" style={{ textAlign: "center" }}>{label}</div>

        {address ? (
          <div
            className="mono"
            style={{
              wordBreak: "break-all",
              textAlign: "center",
              fontSize: 12,
              padding: "8px 12px",
              background: "var(--bg-card)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-primary)",
              lineHeight: 1.6,
            }}
          >
            {address}
            <CopyButton text={address} />
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
            {tab === "arch" ? "Resolving Arch address..." : "No address available"}
          </div>
        )}

        {tab === "arch" && !archAddress && (
          <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
            Fund this account with an airdrop from the Dashboard to initialize your Arch address.
          </p>
        )}
      </div>
    </>
  );
}
