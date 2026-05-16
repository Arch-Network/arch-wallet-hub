import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Turnkey } from "@turnkey/sdk-browser";
import * as bitcoin from "bitcoinjs-lib";
import { useWallet } from "../../hooks/useWallet";
import type { NetworkStatus } from "../../hooks/useApiStatus";
import {
  getClient,
  getExternalUserId,
  deriveArchAccountAddress,
  formatWalletHubError,
  isWalletHubAuthError,
  isWalletHubUnknownResourceError,
  resetHubConfigToDefaults,
} from "../../utils/sdk";
import { getIndexer } from "../../utils/indexer";
import { fetchWalletOverview } from "../../utils/wallet-overview";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { buildUnsignedPsbt, finalizeSignedPsbt } from "../../utils/btc-psbt";
import { formatBtc, formatArch, formatTokenAmount, formatArchId, formatBtcUsd } from "../../utils/format";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import { enrichTokenFromRpc } from "../../utils/arch-rpc";
import { walletStore } from "../../state/wallet-store";
import ArchIcon from "../../components/ArchIcon";

type AssetType = "btc" | "arch" | "apl";

interface TokenHolding {
  mint: string;
  tokenAccount?: string;
  balance: number;
  rawAmount: string;
  decimals: number;
  symbol?: string;
  name?: string;
  uiAmount: string;
}

interface BtcPrepareResult {
  psbtHex: string;
  psbtBase64: string;
  feeSats: number;
  feeRate: number;
  changeSats: number;
  inputCount: number;
}

const ASSET_META: Record<AssetType, { icon: React.ReactNode; label: string; unit: string }> = {
  btc: { icon: "₿", label: "Bitcoin", unit: "BTC" },
  arch: { icon: <ArchIcon size={14} />, label: "ARCH", unit: "ARCH" },
  apl: { icon: <ArchIcon size={14} color="#7b68ee" />, label: "APL Token", unit: "tokens" },
};

interface SendProps {
  networkStatus?: NetworkStatus;
}

function btcUsdSubtitle(sats: number, btcUsd: number | null): string | null {
  if (sats <= 0) return null;
  return formatBtcUsd(sats, btcUsd);
}

export default function Send({ networkStatus }: SendProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAccount, state } = useWallet();
  const { price: btcUsd } = useBtcUsdPrice();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [asset, setAsset] = useState<AssetType | null>(null);
  const [selectedToken, setSelectedToken] = useState<TokenHolding | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const presetMint = searchParams.get("mint");
  const presetAsset = searchParams.get("asset");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [txResult, setTxResult] = useState<{ txid: string; rawTxid: string } | null>(null);

  const [btcConfirmed, setBtcConfirmed] = useState<number>(0);
  const [btcPending, setBtcPending] = useState<number>(0);
  const [btcLoaded, setBtcLoaded] = useState(false);
  const [archBalance, setArchBalance] = useState<string | null>(null);
  const [tokensHeld, setTokensHeld] = useState<TokenHolding[]>([]);

  const [btcPrepare, setBtcPrepare] = useState<BtcPrepareResult | null>(null);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (!activeAccount) return;
    const timeout = setTimeout(() => {
      if (!btcLoaded) setBtcLoaded(true);
      setArchBalance((prev) => prev ?? "0");
    }, 8000);

    const loadBalances = async () => {
      const indexer = await getIndexer();
      const archAddr =
        activeAccount.archAddress ||
        (activeAccount.publicKeyHex ? deriveArchAccountAddress(activeAccount.publicKeyHex) : "");
      const btcAddr = reEncodeTaprootAddress(activeAccount.btcAddress, state.network);

      try {
        const o = await fetchWalletOverview(indexer, {
          inputAddress: activeAccount.btcAddress,
          archAccountAddress: archAddr,
          btcAddress: btcAddr,
        });
        const btcSummary = o.btc.summary as any;
        let confirmed = 0;
        let pending = 0;

        if (btcSummary?.chain_stats) {
          confirmed = (btcSummary.chain_stats.funded_txo_sum ?? 0) - (btcSummary.chain_stats.spent_txo_sum ?? 0);
          pending = (btcSummary.mempool_stats?.funded_txo_sum ?? 0) - (btcSummary.mempool_stats?.spent_txo_sum ?? 0);
        } else if (Array.isArray(btcSummary?.outputs)) {
          for (const utxo of btcSummary.outputs) {
            const val = Number(utxo.value ?? 0);
            if (utxo.spent?.spent) continue;
            if (utxo.status?.confirmed) {
              confirmed += val;
            } else {
              pending += val;
            }
          }
        } else if (typeof btcSummary?.value === "number") {
          confirmed = btcSummary.value;
        }

        setBtcConfirmed(confirmed);
        setBtcPending(pending);
        setBtcLoaded(true);

        const lamports = o.arch.account?.lamports_balance ?? 0;
        setArchBalance(String(lamports));
      } catch {
        setBtcLoaded(true);
        setArchBalance("0");
      }

      try {
        const tokenAddr = archAddr || activeAccount.btcAddress;
        const tokens = await indexer.getAccountTokens(tokenAddr);
        const rawTokens = tokens?.tokens ?? [];
        const enriched = await Promise.all(
          rawTokens.map(async (t) => {
            const base = {
              mint: t.mint_address as string,
              tokenAccount: t.token_account_address as string | undefined,
              balance: Number(t.amount) || 0,
              rawAmount: String(t.amount ?? "0"),
              decimals: t.decimals ?? 0,
              symbol: t.symbol as string | undefined,
              name: (t.name || "APL Token") as string,
              uiAmount: t.ui_amount || formatTokenAmount(Number(t.amount) || 0, t.decimals ?? 0),
            };
            const needsEnrich = !t.name || !t.symbol || (!t.decimals && t.decimals !== undefined);
            if (!needsEnrich) return base;
            try {
              const rpc = await enrichTokenFromRpc(indexer, t);
              if (rpc.name) base.name = rpc.name;
              if (rpc.symbol) base.symbol = rpc.symbol;
              if (rpc.decimals != null) base.decimals = rpc.decimals;
              if (rpc.uiAmount) base.uiAmount = rpc.uiAmount;
            } catch { /* best-effort */ }
            return base;
          }),
        );
        setTokensHeld(enriched);
      } catch {
        setTokensHeld([]);
      }
    };
    loadBalances();
    return () => clearTimeout(timeout);
  }, [activeAccount, state.network]);

  // Apply preset asset/mint once (deep link from Token Detail). Only triggers
  // on step 1 so we don't yank the user out of a flow they started.
  useEffect(() => {
    if (step !== 1 || !presetAsset) return;
    if (presetAsset === "apl" && presetMint) {
      const match = tokensHeld.find((t) => t.mint === presetMint);
      if (!match) return;
      setSelectedToken(match);
      setAsset("apl");
      setStep(2);
      setSearchParams({}, { replace: true });
    } else if (presetAsset === "arch") {
      setAsset("arch");
      setStep(2);
      setSearchParams({}, { replace: true });
    } else if (presetAsset === "btc") {
      setAsset("btc");
      setStep(2);
      setSearchParams({}, { replace: true });
    }
  }, [step, presetAsset, presetMint, tokensHeld, setSearchParams]);

  const signWithPasskey = useCallback(
    async (signingRequestId: string, payloadHex: string): Promise<string> => {
      if (!activeAccount?.organizationId)
        throw new Error("Missing organization ID for passkey wallet");
      const tk = new Turnkey({
        apiBaseUrl: "https://api.turnkey.com",
        defaultOrganizationId: activeAccount.organizationId,
        rpId: globalThis.location?.hostname === "localhost" ? "localhost" : globalThis.location?.hostname ?? "localhost",
      });
      const pc = tk.passkeyClient();
      const signResult = await pc.signRawPayload({
        signWith: activeAccount.btcAddress,
        payload: payloadHex,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP",
      });
      const signature64Hex = `${signResult.r}${signResult.s}`;
      const client = await getClient();
      const externalUserId = getExternalUserId();
      const submitRes = await client.submitSigningRequest(signingRequestId, {
        externalUserId,
        signature64Hex,
      });
      const res = (submitRes as any).result ?? submitRes;
      return res?.txid || res?.txidHex || signingRequestId;
    },
    [activeAccount]
  );

  const handlePrepareBtc = useCallback(async () => {
    if (!activeAccount || !recipient || !amount) return;
    setPreparing(true);
    setError("");
    setBtcPrepare(null);
    try {
      const amountSats = Math.round((Number(amount) || 0) * 1e8);
      if (amountSats < 546) throw new Error("Amount too small (minimum 546 sats)");

      const fromAddress = reEncodeTaprootAddress(activeAccount.btcAddress, state.network);

      if (activeAccount.isCustodial) {
        // Custodial sends are still server-built (Turnkey signs server-side and
        // broadcasts via the Hub), so we just compute a local fee estimate to
        // show the user. We don't need an actual PSBT here.
        const indexer = await getIndexer();
        let feeRate = 5;
        try {
          const est = await indexer.getBtcFeeEstimates();
          feeRate = est["6"] ?? est["3"] ?? 5;
        } catch { /* fallback */ }
        const utxos = await indexer.getBtcAddressUtxos(fromAddress);
        if (!utxos?.length) throw new Error("No UTXOs available for this address");
        const feeSats = Math.ceil((10.5 + 1 * 57.5 + 2 * 43) * feeRate);
        setBtcPrepare({
          psbtHex: "",
          psbtBase64: "",
          feeSats,
          feeRate,
          changeSats: 0,
          inputCount: 1,
        });
      } else {
        const indexer = await getIndexer();
        const built = await buildUnsignedPsbt({
          indexer,
          fromAddress,
          toAddress: recipient,
          amountSats,
        });
        setBtcPrepare({
          psbtHex: built.psbt.toHex(),
          psbtBase64: built.psbt.toBase64(),
          feeSats: built.feeSats,
          feeRate: built.feeRate,
          changeSats: built.changeSats,
          inputCount: built.inputCount,
        });
      }
      setStep(3);
    } catch (err: any) {
      setError(err.message || "Failed to prepare transaction");
    } finally {
      setPreparing(false);
    }
  }, [activeAccount, recipient, amount, state.network]);

  const handleBtcSign = useCallback(async () => {
    if (!activeAccount || !btcPrepare) return;
    setLoading(true);
    setError("");
    try {
      const externalUserId = getExternalUserId();
      const amountSats = Math.round((Number(amount) || 0) * 1e8);

      if (activeAccount.isCustodial) {
        const client = await getClient();
        const result = await client.sendBitcoin({
          externalUserId,
          turnkeyResourceId: activeAccount.turnkeyResourceId,
          toAddress: recipient,
          amountSats,
          feeRate: btcPrepare.feeRate,
        });
        setTxResult({ txid: result.txid, rawTxid: result.txid });
      } else {
        if (!activeAccount.organizationId)
          throw new Error("Missing organization ID for passkey wallet");

        const fromAddress = reEncodeTaprootAddress(activeAccount.btcAddress, state.network);
        const tk = new Turnkey({
          apiBaseUrl: "https://api.turnkey.com",
          defaultOrganizationId: activeAccount.organizationId,
          rpId: globalThis.location?.hostname === "localhost" ? "localhost" : globalThis.location?.hostname ?? "localhost",
        });
        const signResult = await tk.passkeyClient().signTransaction({
          signWith: fromAddress,
          unsignedTransaction: btcPrepare.psbtHex,
          type: "TRANSACTION_TYPE_BITCOIN",
        });

        const signedPsbtHex = (signResult as any)?.signedTransaction;
        if (!signedPsbtHex) throw new Error("Turnkey did not return a signed transaction");

        const isTestnet = state.network === "testnet4";
        const network = isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
        const rawTxHex = finalizeSignedPsbt(hexToBase64(signedPsbtHex), network);

        const indexer = await getIndexer();
        const txid = await indexer.broadcastBtc(rawTxHex);
        setTxResult({ txid, rawTxid: txid });
      }

      setStep(4);
    } catch (err: any) {
      setError(activeAccount?.isCustodial ? formatWalletHubError(err, "Transaction signing failed") : err.message || "Transaction signing failed");
    } finally {
      setLoading(false);
    }
  }, [activeAccount, btcPrepare, state.network, amount, recipient]);

  const handleSubmit = useCallback(async () => {
    if (!activeAccount) return;

    if (asset === "btc") {
      return handleBtcSign();
    }

    setLoading(true);
    setError("");
    try {
      const archLamports = String(Math.round((Number(amount) || 0) * 1e9));
      const aplRawAmount =
        asset === "apl" && selectedToken
          ? parseTokenDisplayAmountToRaw(amount, selectedToken.decimals)
          : null;
      if (asset === "apl" && selectedToken && aplRawAmount) {
        const availableRaw = parseRawTokenAmount(selectedToken.rawAmount);
        if (aplRawAmount > availableRaw) throw new Error("Insufficient token balance");
      }

      const submitViaHub = async (): Promise<string> => {
        const client = await getClient();
        const externalUserId = getExternalUserId();
        const action =
          asset === "apl" && selectedToken
            ? {
                type: "arch.token_transfer" as const,
                mintAddress: selectedToken.mint,
                toAddress: recipient,
                amount: aplRawAmount!.toString(),
                sourceTokenAccount: selectedToken.tokenAccount,
                decimals: selectedToken.decimals,
              }
            : {
                type: "arch.transfer" as const,
                toAddress: recipient,
                lamports: archLamports,
              };

        const sr = await client.createSigningRequest({
          externalUserId,
          signer: { kind: "turnkey", resourceId: activeAccount.turnkeyResourceId },
          action,
        });

        if (activeAccount.isCustodial) {
          const serverResult = await client.signWithTurnkey(sr.signingRequestId, { externalUserId });
          const res = (serverResult as any).result ?? serverResult;
          return res?.txid || res?.txidHex || sr.signingRequestId;
        }

        const payloadHex = (sr.payloadToSign as any)?.payloadHex;
        if (!payloadHex) throw new Error("No payload available for signing");
        return await signWithPasskey(sr.signingRequestId, payloadHex);
      };

      let txid: string;
      try {
        txid = await submitViaHub();
      } catch (err) {
        if (isWalletHubAuthError(err)) {
          await resetHubConfigToDefaults();
        } else if (isWalletHubUnknownResourceError(err) && !activeAccount.isCustodial) {
          const client = await getClient();
          const registered = await client.registerExistingPasskeyWallet({
            externalUserId: getExternalUserId(),
            organizationId: activeAccount.organizationId,
            defaultAddress: activeAccount.btcAddress,
            defaultPublicKeyHex: activeAccount.publicKeyHex,
            label: activeAccount.label,
          });
          await walletStore.updateAccount(activeAccount.id, {
            id: registered.resourceId,
            turnkeyResourceId: registered.resourceId,
            organizationId: registered.organizationId,
          });
          activeAccount.id = registered.resourceId;
          activeAccount.turnkeyResourceId = registered.resourceId;
          activeAccount.organizationId = registered.organizationId;
        } else {
          throw err;
        }
        txid = await submitViaHub();
      }

      const displayTxid = formatArchId(txid);
      setTxResult({ txid: displayTxid, rawTxid: txid });
      setStep(4);
    } catch (err: any) {
      setError(formatWalletHubError(err, "Transaction failed"));
    } finally {
      setLoading(false);
    }
  }, [activeAccount, asset, selectedToken, recipient, amount, signWithPasskey, handleBtcSign]);

  const resetFlow = useCallback(() => {
    setStep(1);
    setAsset(null);
    setSelectedToken(null);
    setRecipient("");
    setAmount("");
    setError("");
    setTxResult(null);
    setBtcPrepare(null);
  }, []);

  const isTestnet = state.network === "testnet4";
  const archExplorerBase = isTestnet
    ? "https://explorer.arch.network/testnet/tx/"
    : "https://explorer.arch.network/mainnet/tx/";
  const btcExplorerBase = isTestnet
    ? "https://mempool.space/testnet4/tx/"
    : "https://mempool.space/tx/";

  // Step 1: Choose asset
  if (step === 1) {
    return (
      <>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Choose Asset</h2>
        {error && <div className="error-banner">{error}</div>}
        <div className="send-asset-list">
          <button className="card send-asset-card" onClick={() => { setAsset("btc"); setStep(2); }}>
            <div className="asset-row send-asset-row">
              <div className="asset-icon btc">₿</div>
              <div className="asset-info">
                <div className="asset-name">Bitcoin</div>
                <div className="asset-sub">BTC</div>
              </div>
              <div className="send-asset-balance-wrap">
                <div className="send-asset-balance-label">Available</div>
                <div className="send-asset-balance">
                  {btcLoaded
                    ? formatBtc(btcConfirmed + btcPending)
                    : "Loading..."}
                </div>
                {btcLoaded && btcUsdSubtitle(btcConfirmed + btcPending, btcUsd) && (
                  <div className="send-asset-usd">
                    {btcUsdSubtitle(btcConfirmed + btcPending, btcUsd)}
                  </div>
                )}
                {btcLoaded && btcPending !== 0 && (
                  <div className={`send-asset-pending ${btcPending > 0 ? "incoming" : "outgoing"}`}>
                    {btcPending > 0 ? "+" : ""}{(btcPending / 1e8).toFixed(8)} pending
                  </div>
                )}
              </div>
            </div>
          </button>
          <button className="card send-asset-card" onClick={() => { setAsset("arch"); setStep(2); }}>
            <div className="asset-row send-asset-row">
              <div className="asset-icon arch"><ArchIcon size={18} /></div>
              <div className="asset-info">
                <div className="asset-name">ARCH</div>
                <div className="asset-sub">Native gas token</div>
              </div>
              <div className="send-asset-balance-wrap">
                <div className="send-asset-balance-label">Available</div>
                <div className="send-asset-balance">{archBalance !== null ? formatArch(archBalance) : "Loading..."}</div>
              </div>
            </div>
          </button>
          {tokensHeld.map((tk) => (
            <button
              key={tk.mint}
              className="card send-asset-card"
              onClick={() => { setSelectedToken(tk); setAsset("apl"); setStep(2); }}
            >
              <div className="asset-row send-asset-row">
                <div className="asset-icon apl"><ArchIcon size={18} color="#7b68ee" /></div>
                <div className="asset-info">
                  <div className="asset-name">{tk.name || "APL Token"}</div>
                  <div className="asset-sub">{tk.symbol || "APL Token"}</div>
                </div>
                <div className="send-asset-balance-wrap">
                  <div className="send-asset-balance-label">Available</div>
                  <div className="send-asset-balance">{tk.uiAmount} {tk.symbol ? tk.symbol : ""}</div>
                </div>
              </div>
            </button>
          ))}
          {tokensHeld.length === 0 && (
            <div className="card send-asset-card send-asset-card-disabled">
              <div className="asset-row send-asset-row">
                <div className="asset-icon apl"><ArchIcon size={18} color="#7b68ee" /></div>
                <div className="asset-info">
                  <div className="asset-name">APL Tokens</div>
                  <div className="asset-sub">No tokens held</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  // Step 2: Enter details
  if (step === 2) {
    const meta = asset ? ASSET_META[asset] : ASSET_META.arch;
    const handleReview = () => {
      setError("");
      if (asset === "btc") {
        handlePrepareBtc();
      } else if (asset === "apl" && selectedToken) {
        try {
          const rawAmount = parseTokenDisplayAmountToRaw(amount, selectedToken.decimals);
          const availableRaw = parseRawTokenAmount(selectedToken.rawAmount);
          if (rawAmount > availableRaw) throw new Error("Insufficient token balance");
          setStep(3);
        } catch (err: any) {
          setError(err.message || "Enter a valid token amount");
        }
      } else {
        setStep(3);
      }
    };

    return (
      <>
        <button className="btn btn-sm btn-secondary" onClick={() => setStep(1)} style={{ marginBottom: 12 }}>
          ← Back
        </button>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Send {meta.label}</h2>
        {error && <div className="error-banner">{error}</div>}
        <div className="input-group">
          <label className="input-label">Recipient Address</label>
          <input
            className="input-field mono"
            placeholder={asset === "btc" ? "tb1p..." : "Base58 address"}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
        </div>
        <div className="input-group">
          <label className="input-label">
            Amount ({meta.unit})
            {asset === "arch" && archBalance && (
              <span style={{ float: "right", color: "var(--text-muted)" }}>
                Available: {formatArch(archBalance)}
              </span>
            )}
            {asset === "btc" && btcLoaded && (
              <span style={{ float: "right", color: "var(--text-muted)" }}>
                Available: {((btcConfirmed + btcPending) / 1e8).toFixed(8)} BTC
              </span>
            )}
            {asset === "apl" && selectedToken && (
              <span style={{ float: "right", color: "var(--text-muted)" }}>
                Available: {selectedToken.uiAmount}
              </span>
            )}
          </label>
          <div style={{ position: "relative" }}>
            <input
              className="input-field mono"
              type="number"
              step={asset === "btc" ? "0.00000001" : asset === "arch" ? "0.0001" : tokenInputStep(selectedToken?.decimals ?? 0)}
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ paddingRight: 50 }}
            />
            {asset === "btc" && btcLoaded && (btcConfirmed + btcPending) > 0 && (
              <button
                type="button"
                onClick={() => setAmount(((btcConfirmed + btcPending) / 1e8).toFixed(8))}
                style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "rgba(193,154,91,0.15)", border: "1px solid rgba(193,154,91,0.3)",
                  borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700,
                  color: "var(--accent)", cursor: "pointer",
                }}
              >
                MAX
              </button>
            )}
            {asset === "arch" && archBalance && Number(archBalance) > 0 && (
              <button
                type="button"
                onClick={() => setAmount((Number(archBalance) / 1e9).toFixed(4))}
                style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "rgba(193,154,91,0.15)", border: "1px solid rgba(193,154,91,0.3)",
                  borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700,
                  color: "var(--accent)", cursor: "pointer",
                }}
              >
                MAX
              </button>
            )}
          </div>
          {asset === "btc" && Number(amount) > 0 && (() => {
            const sats = Math.round(Number(amount) * 1e8);
            const usd = btcUsdSubtitle(sats, btcUsd);
            return usd ? (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                {"\u2248"} {usd}
              </div>
            ) : null;
          })()}
        </div>
        {asset === "btc" && btcPending !== 0 && (
          <div style={{
            fontSize: 11,
            color: "var(--text-muted)",
            background: "rgba(193, 154, 91, 0.06)",
            border: "1px solid rgba(193, 154, 91, 0.12)",
            borderRadius: 8,
            padding: "8px 10px",
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}>
            <span style={{ color: "var(--warning)", fontSize: 14 }}>⏳</span>
            <span>
              Includes <strong style={{ color: "var(--success)" }}>{(btcPending / 1e8).toFixed(8)} BTC</strong> unconfirmed.
            </span>
          </div>
        )}
        <button
          className="btn btn-primary btn-full"
          disabled={!recipient || !amount || preparing}
          onClick={handleReview}
        >
          {preparing ? "Preparing..." : "Review"}
        </button>
      </>
    );
  }

  // Step 3: Review & confirm
  if (step === 3) {
    const meta = asset ? ASSET_META[asset] : ASSET_META.arch;
    const amountSats = asset === "btc" ? Math.round((Number(amount) || 0) * 1e8) : 0;
    const aplRawAmount =
      asset === "apl" && selectedToken
        ? tryParseTokenDisplayAmountToRaw(amount, selectedToken.decimals)
        : null;

    return (
      <>
        <button className="btn btn-sm btn-secondary" onClick={() => { setStep(2); setBtcPrepare(null); }} style={{ marginBottom: 12 }}>
          ← Back
        </button>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Review Transaction</h2>
        {networkStatus?.api === "disconnected" && asset !== "btc" && (
          <div className="warning-banner">
            This {asset === "apl" ? "APL token" : "ARCH"} send uses Wallet Hub for signing orchestration. Check Wallet Hub API in Settings if signing fails.
          </div>
        )}
        {networkStatus?.api === "disconnected" && asset === "btc" && activeAccount?.isCustodial && (
          <div className="warning-banner">
            Custodial BTC sends use Wallet Hub for server-side signing. Check Wallet Hub API in Settings if signing fails.
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">Asset</div>
            <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>{meta.icon} {meta.label}</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">To</div>
            <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{recipient}</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="input-label">Amount</div>
            <div style={{ fontWeight: 600 }}>
              {asset === "btc" ? `${Number(amount) || 0} BTC`
                : asset === "arch" ? `${Number(amount) || 0} ARCH`
                : selectedToken ? `${amount} ${selectedToken.symbol || "APL"}`
                : amount}
            </div>
            {asset === "arch" && Number(amount) > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                {Math.round((Number(amount) || 0) * 1e9).toLocaleString()} lamports
              </div>
            )}
            {asset === "btc" && amountSats > 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                {amountSats.toLocaleString()} sats
              </div>
            )}
            {asset === "apl" && aplRawAmount !== null && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                {aplRawAmount.toLocaleString()} raw units
              </div>
            )}
          </div>
          {asset === "apl" && selectedToken && (
            <div>
              <div className="input-label">Token Mint</div>
              <div className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>{selectedToken.mint}</div>
            </div>
          )}

          {asset === "btc" && btcPrepare && (
            <div style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid rgba(193,154,91,0.12)",
            }}>
              <div className="input-label" style={{ marginBottom: 6 }}>Network Fee</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: "var(--text-muted)" }}>Fee</span>
                <span className="mono" style={{ color: "var(--text-primary)" }}>
                  {btcPrepare.feeSats.toLocaleString()} sats ({(btcPrepare.feeSats / 1e8).toFixed(8)} BTC)
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: "var(--text-muted)" }}>Fee Rate</span>
                <span className="mono" style={{ color: "var(--text-primary)" }}>
                  {btcPrepare.feeRate.toFixed(1)} sat/vB
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: "var(--text-muted)" }}>Inputs</span>
                <span className="mono" style={{ color: "var(--text-primary)" }}>{btcPrepare.inputCount}</span>
              </div>
              {btcPrepare.changeSats > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--text-muted)" }}>Change</span>
                  <span className="mono" style={{ color: "var(--text-primary)" }}>
                    {btcPrepare.changeSats.toLocaleString()} sats
                  </span>
                </div>
              )}
              <div style={{
                display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700,
                marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(193,154,91,0.12)",
              }}>
                <span style={{ color: "var(--accent)" }}>Total</span>
                <span className="mono" style={{ color: "var(--accent)" }}>
                  {((amountSats + btcPrepare.feeSats) / 1e8).toFixed(8)} BTC
                </span>
              </div>
            </div>
          )}
        </div>

        <button
          className="btn btn-primary btn-full"
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? "Signing..." : "Confirm & Sign"}
        </button>
      </>
    );
  }

  // Step 4: Complete
  const explorerUrl = asset === "btc"
    ? `${btcExplorerBase}${txResult?.rawTxid}`
    : `${archExplorerBase}${txResult?.rawTxid}`;

  return (
    <>
      <div style={{ textAlign: "center", padding: "24px 0" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Transaction Sent!</h2>
        <div className="mono" style={{ wordBreak: "break-all", fontSize: 11, marginBottom: 16 }}>
          {txResult?.txid}
        </div>
        {txResult?.rawTxid && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm btn-secondary"
            style={{ marginBottom: 8, display: "inline-block" }}
          >
            View on {asset === "btc" ? "Mempool" : "Explorer"} →
          </a>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-secondary btn-full" onClick={resetFlow}>
          Send Another
        </button>
        <button className="btn btn-primary btn-full" onClick={() => navigate("/dashboard")}>
          Done
        </button>
      </div>
    </>
  );
}

function hexToBase64(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function tokenInputStep(decimals: number): string {
  if (decimals <= 0) return "1";
  return `0.${"0".repeat(Math.max(decimals - 1, 0))}1`;
}

function parseRawTokenAmount(rawAmount: string): bigint {
  const normalized = rawAmount.trim();
  if (!/^\d+$/.test(normalized)) return 0n;
  return BigInt(normalized);
}

function tryParseTokenDisplayAmountToRaw(input: string, decimals: number): bigint | null {
  try {
    return parseTokenDisplayAmountToRaw(input, decimals);
  } catch {
    return null;
  }
}

function parseTokenDisplayAmountToRaw(input: string, decimals: number): bigint {
  const normalized = input.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Enter a valid token amount");
  }

  const [wholePart, fractionalPart = ""] = normalized.split(".");
  if (fractionalPart.length > decimals) {
    throw new Error(`Amount supports up to ${decimals} decimal places`);
  }

  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholePart || "0") * scale;
  const fractional =
    decimals > 0
      ? BigInt((fractionalPart || "").padEnd(decimals, "0") || "0")
      : 0n;
  const raw = whole + fractional;
  if (raw <= 0n) throw new Error("Amount must be greater than zero");
  return raw;
}
