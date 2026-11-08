import { useState } from "react";
import type { NetworkId, WalletAccount } from "../state/types";
import { resolveAccountAddresses } from "../state/account-addresses";
import { signerInfo } from "../wallets/capabilities";
import type { BridgeResponse } from "../wallets/bridge/protocol";

const NETWORK_NAME: Record<NetworkId, string> = { mainnet: "Mainnet", testnet4: "Testnet4" };

/**
 * Explains a linked account whose addresses are incomplete on `network`,
 * so missing balances don't read as zero. Renders nothing otherwise.
 */
export function AddressGapNotice({ account, network }: { account: WalletAccount; network: NetworkId }) {
  const [status, setStatus] = useState<"idle" | "waiting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const { gap } = resolveAccountAddresses(account, network);
  if (!gap) return null;
  const { label } = signerInfo(account);

  if (gap === "network-not-linked") {
    return (
      <div className="warning-banner gap-notice" role="status">
        This {label} account has no address on {NETWORK_NAME[network]}. Switch networks, or connect {label} on{" "}
        {NETWORK_NAME[network]} as a separate account.
      </div>
    );
  }

  const reconnect = async () => {
    setStatus("waiting");
    setError(null);
    const response: BridgeResponse | undefined = await chrome.runtime
      .sendMessage({ type: "RELINK_EXTERNAL_ADDRESSES", accountId: account.id })
      .catch((err: unknown) => ({ success: false as const, code: "PROVIDER_ERROR" as const, error: String(err) }));
    // Success re-renders without a gap via the storage listener.
    if (response?.success) return;
    setStatus("error");
    setError(response?.error ?? "Couldn't reconnect. Try again.");
  };

  return (
    <div className="warning-banner gap-notice" role="status">
      <div>
        Your {label} payment address isn't linked yet, so BTC held there isn't shown. Reconnect {label} to add it.
      </div>
      {error && <div className="gap-notice-error">{error}</div>}
      <button className="gap-notice-action" onClick={reconnect} disabled={status === "waiting"}>
        {status === "waiting" ? `Continue in ${label}…` : `Reconnect ${label}`}
      </button>
    </div>
  );
}
