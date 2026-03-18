import { useState, useEffect, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useWallet } from "../../hooks/useWallet";
import { getClient } from "../../utils/sdk";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import CopyButton from "../../components/CopyButton";

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
    (async () => {
      try {
        const client = await getClient();
        const overview = await client.getWalletOverview(activeAccount.btcAddress);
        setArchAddress((overview as any)?.archAccountAddress ?? "");
      } catch {
        // fallback
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
          ⟠ ARCH
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
