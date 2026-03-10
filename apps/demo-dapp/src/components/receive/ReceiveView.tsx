import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "../../types";
import CopyButton from "../shared/CopyButton";
import { formatArchId } from "../../utils/archFormat";

type Props = {
  client: WalletHubClient;
  wallet: ConnectedWallet;
  externalUserId: string;
};

export default function ReceiveView({ client, wallet }: Props) {
  const [archAddress, setArchAddress] = useState(wallet.archAddress || "");
  const [airdropLoading, setAirdropLoading] = useState(false);
  const [airdropResult, setAirdropResult] = useState<string | null>(null);
  const [airdropError, setAirdropError] = useState("");

  useEffect(() => {
    if (archAddress) return;
    client
      .getWalletOverview(wallet.address)
      .then((data) => {
        if (data.archAccountAddress) setArchAddress(data.archAccountAddress);
      })
      .catch(() => {});
  }, [client, wallet.address, archAddress]);

  const handleAirdrop = useCallback(async () => {
    if (!archAddress) {
      setAirdropError("Arch address not resolved yet — please wait for it to load.");
      return;
    }
    setAirdropLoading(true);
    setAirdropError("");
    setAirdropResult(null);
    try {
      const res = await client.requestFaucetAirdrop(archAddress);
      setAirdropResult(formatArchId(res.txid));
    } catch (err: any) {
      setAirdropError(err.message || "Airdrop request failed");
    } finally {
      setAirdropLoading(false);
    }
  }, [client, archAddress]);

  return (
    <div className="receive-view">
      <h1 className="receive-title">Receive</h1>

      <div className="receive-grid">
        <div className="receive-section">
          <h2 className="receive-section-title">Receive BTC</h2>
          <div className="qr-container">
            <QRCodeSVG
              value={wallet.address}
              size={200}
              bgColor="transparent"
              fgColor="#ffffff"
              level="M"
            />
          </div>
          <div className="receive-address">
            <code className="receive-address-text">{wallet.address}</code>
            <CopyButton text={wallet.address} />
          </div>
          {wallet.type === "turnkey" && (
            <p className="receive-note">
              Fund your wallet by sending BTC from another wallet or exchange.
            </p>
          )}
        </div>

        <div className="receive-section">
          <h2 className="receive-section-title">Receive ARCH</h2>
          {archAddress ? (
            <>
              <div className="qr-container">
                <QRCodeSVG
                  value={archAddress}
                  size={200}
                  bgColor="transparent"
                  fgColor="#ffffff"
                  level="M"
                />
              </div>
              <div className="receive-address">
                <code className="receive-address-text">{archAddress}</code>
                <CopyButton text={archAddress} />
              </div>
            </>
          ) : (
            <>
              <p className="receive-note">
                Your Arch account address is derived from your BTC Taproot address.
                Use the airdrop button below to fund it, or send ARCH tokens to:
              </p>
              <div className="receive-address">
                <code className="receive-address-text">{wallet.address}</code>
                <CopyButton text={wallet.address} />
              </div>
            </>
          )}
          <p className="receive-note">
            Use the testnet faucet below to get free ARCH tokens for testing.
          </p>
        </div>
      </div>

      <div className="receive-airdrop">
        <button
          className="btn-primary"
          onClick={handleAirdrop}
          disabled={airdropLoading}
          type="button"
        >
          {airdropLoading ? (
            <>
              <span className="spinner small" /> Requesting…
            </>
          ) : (
            "Request Testnet Airdrop"
          )}
        </button>

        {airdropResult && (
          <div className="statusMessage success">
            <span className="statusIcon">✓</span>
            <span>Airdrop sent! TX: {airdropResult.slice(0, 16)}…</span>
          </div>
        )}

        {airdropError && (
          <div className="statusMessage error">
            <span className="statusIcon">✗</span>
            <span>{airdropError}</span>
          </div>
        )}
      </div>
    </div>
  );
}
