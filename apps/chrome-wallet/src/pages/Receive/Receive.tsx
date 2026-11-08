import { useState, useEffect, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useWallet } from "../../hooks/useWallet";
import { useWideMode } from "../../hooks/useWideMode";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { getIndexer } from "../../utils/indexer";
import { resolveAccountAddresses } from "../../state/account-addresses";
import { signerInfo } from "../../wallets/capabilities";
import { isAnsEnabledForNetwork, openAnsManager, resolvePrimaryName } from "../../utils/name-service";
import CopyButton from "../../components/CopyButton";
import ArchIcon from "../../components/ArchIcon";
import { AddressGapNotice } from "../../components/AddressGapNotice";
import { receiveDestinations, type ReceiveTab } from "./receive-destinations";

export default function Receive() {
  const { activeAccount, state } = useWallet();
  const wide = useWideMode(720);
  const [tab, setTab] = useState<ReceiveTab>("btc");
  const [archAddress, setArchAddress] = useState<string>("");
  const [primaryName, setPrimaryName] = useState<string | null>(null);

  const destinations = useMemo(
    () =>
      activeAccount
        ? receiveDestinations(
            resolveAccountAddresses(activeAccount, state.network),
            archAddress,
            state.network,
            signerInfo(activeAccount).label,
          )
        : [],
    [activeAccount, state.network, archAddress]
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
  }, [activeAccount?.id, activeAccount?.archAddress, activeAccount?.publicKeyHex, state.network]);

  useEffect(() => {
    let cancelled = false;
    setPrimaryName(null);
    if (!archAddress) return;
    void resolvePrimaryName(archAddress, { network: state.network }).then((name) => {
      if (!cancelled) setPrimaryName(name);
    });
    return () => {
      cancelled = true;
    };
  }, [archAddress, state.network]);

  if (!activeAccount) return null;

  const current = destinations.find((d) => d.id === tab) ?? destinations[0];
  if (!current) return null;
  const { address } = current;

  return (
    <div className="receive-page">
      <div className="receive-header">
        <h2 className="receive-title">Receive</h2>
        <div className="receive-subtitle">Choose what you're receiving to get the right address.</div>
      </div>

      <div className="receive-segmented" role="tablist">
        {destinations.map((d) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={current.id === d.id}
            className={`receive-segment ${current.id === d.id ? "active" : ""}`}
            onClick={() => setTab(d.id)}
          >
            <span className="receive-segment-icon" aria-hidden>
              {d.id === "arch" ? (
                <ArchIcon size={12} color={current.id === "arch" ? "var(--color-primary)" : "var(--text-muted)"} />
              ) : d.id === "ordinals" ? (
                "◈"
              ) : (
                "₿"
              )}
            </span>
            <span>{d.tabLabel}</span>
          </button>
        ))}
      </div>

      <div className="receive-card">
        <div className="receive-meta">
          <div className="receive-meta-label">{current.title}</div>
          <div className="receive-meta-network">{current.network}</div>
          {current.id === "arch" && primaryName && (
            <button
              type="button"
              className="receive-meta-network receive-meta-link"
              title={`View ${primaryName} on ANS`}
              onClick={() => void openAnsManager({ view: primaryName })}
            >
              {primaryName}
            </button>
          )}
          {current.id === "arch" && isAnsEnabledForNetwork(state.network) && !primaryName && (
            <button
              type="button"
              className="receive-meta-network receive-meta-link"
              onClick={() => void openAnsManager("register")}
            >
              Get a .arch name
            </button>
          )}
        </div>

        {address ? (
          <>
            <div className="receive-qr-frame">
              <QRCodeSVG
                value={address}
                size={wide ? 176 : 148}
                bgColor="#ffffff"
                fgColor="#0d0f17"
                level="M"
                marginSize={2}
              />
            </div>
            <code className="receive-address-text mono" title={address}>{address}</code>
            <CopyButton text={address} className="receive-copy-full" label="Copy address" />
            <div className="receive-accepts">
              Only send <strong>{current.accepts}</strong> on <strong>{current.network}</strong>.
            </div>
          </>
        ) : current.id === "arch" ? (
          <div className="receive-empty">Resolving Arch address…</div>
        ) : resolveAccountAddresses(activeAccount, state.network).gap ? (
          <div className="receive-missing">
            <AddressGapNotice account={activeAccount} network={state.network} />
          </div>
        ) : (
          <div className="receive-empty">This account has no verified address for this on {current.network}.</div>
        )}
      </div>

      {current.note && <div className="receive-hint">{current.note}</div>}
    </div>
  );
}
