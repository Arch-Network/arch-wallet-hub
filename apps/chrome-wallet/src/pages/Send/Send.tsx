import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as bitcoin from "bitcoinjs-lib";
import { signerForAccount } from "../../signers/Signer";
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
import { reEncodeTaprootAddress, isWrongNetworkAddress, detectBtcNetwork } from "../../utils/addressNetwork";
import QrScanner from "../../components/QrScanner";
import BackBar from "../../components/BackBar";
import { buildUnsignedPsbt, finalizeSignedPsbt } from "../../utils/btc-psbt";
import { dustThresholdForAddress } from "../../utils/btc-dust";
import {
  buildExplorerUrl,
  notifyTxBroadcast,
  notifyTxFailed,
} from "../../utils/notifications";
import {
  buildFeeTiers,
  DEFAULT_FEE_TIER_ID,
  tierById,
  type FeeTier,
  type FeeTierId,
} from "../../utils/btc-fee-tiers";
import BtcFeeTierPicker from "../../components/BtcFeeTierPicker";
import { formatBtc, formatArch, formatTokenAmount, formatArchId, formatBtcUsd, truncateAddress } from "../../utils/format";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import { enrichIndexerTokens } from "../../utils/enrich-token";
import { walletStore } from "../../state/wallet-store";
import {
  clearSendForm,
  loadSendForm,
  saveSendForm,
} from "../../state/send-form-session";
import { isExternalAccount, isWatchAccount, type WalletAccount } from "../../state/types";
import { getExternalWalletAdapter } from "../../wallets/external-wallets";
import ArchIcon from "../../components/ArchIcon";
import { TokenIcon } from "../../components/TokenIcon";
import { buildSessionSigner, ensureHubSession } from "../../utils/hub-session";
import {
  EmailSessionNeededError,
  ensureSigningSessionForAccount,
} from "../../session/ensure-signing-session";
import SessionBootstrapper from "../../session/SessionBootstrapper";
import {
  btcInputToUsd,
  rawTokenAmountToInput,
  usdInputToBtc,
} from "../../utils/send-amounts";

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
  image?: string;
}

/**
 * Single source of truth for the asset chip rendered in every Send step.
 *
 * Keeps the native-asset glyphs (BTC `₿`, ARCH letter mark) intact while
 * routing APL tokens through `TokenIcon` so registry-supplied images
 * (USDC, USDT, aBTC, etc.) match what Dashboard / Tokens / Token Detail
 * already render. Previously the Send flow hardcoded the generic Arch
 * glyph for every APL token, which made USDC/aBTC look "generic" only
 * here — a visible inconsistency the user flagged.
 *
 * The `inline` variant returns a compact 20px chip with no surrounding
 * circle for the review row, where the larger `.asset-icon` (36px)
 * would dominate the value column.
 */
function renderAssetIcon(
  asset: AssetType | null,
  token: TokenHolding | null,
  options?: { inline?: boolean }
): React.ReactNode {
  if (options?.inline) {
    if (asset === "btc") {
      return <span className="send-inline-icon btc" aria-hidden>₿</span>;
    }
    if (asset === "arch") {
      return (
        <span className="send-inline-icon arch" aria-hidden>
          <ArchIcon size={14} />
        </span>
      );
    }
    return (
      <TokenIcon
        image={token?.image}
        symbol={token?.symbol || "APL"}
        size={20}
      />
    );
  }
  if (asset === "btc") {
    return <div className="asset-icon btc">₿</div>;
  }
  if (asset === "arch") {
    return <div className="asset-icon arch"><ArchIcon size={18} /></div>;
  }
  return (
    <TokenIcon
      image={token?.image}
      symbol={token?.symbol || "APL"}
      size={28}
      wrapperClassName="asset-icon apl"
    />
  );
}

interface BtcPrepareResult {
  psbtHex: string;
  psbtBase64: string;
  feeSats: number;
  feeRate: number;
  changeSats: number;
  inputCount: number;
}

const ASSET_META: Record<AssetType, { label: string; unit: string }> = {
  btc: { label: "Bitcoin", unit: "BTC" },
  arch: { label: "ARCH", unit: "ARCH" },
  apl: { label: "APL Token", unit: "tokens" },
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
  const { activeAccount, state, addRecentRecipient, removeRecentRecipient } = useWallet();
  const { price: btcUsd } = useBtcUsdPrice();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [asset, setAsset] = useState<AssetType | null>(null);
  const [selectedToken, setSelectedToken] = useState<TokenHolding | null>(null);
  const [recipient, setRecipient] = useState("");
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [amount, setAmount] = useState("");
  const presetMint = searchParams.get("mint");
  const presetAsset = searchParams.get("asset");
  const [loading, setLoading] = useState(false);
  // Phase hint shown on the primary button while a signing flow is
  // in-flight. External-wallet flows hop through several async stages
  // (wallet popup → Hub submit → broadcast); without per-phase copy
  // the spinner reads as "frozen" and users assume it's hung.
  const [signStatus, setSignStatus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [txResult, setTxResult] = useState<{ txid: string; rawTxid: string } | null>(null);
  const [otpAccount, setOtpAccount] = useState<WalletAccount | null>(null);
  const [btcAmountMode, setBtcAmountMode] = useState<"btc" | "usd">("btc");
  const [btcUsdAmount, setBtcUsdAmount] = useState("");

  const [btcConfirmed, setBtcConfirmed] = useState<number>(0);
  const [btcPending, setBtcPending] = useState<number>(0);
  // Sats locked in inscription / rune outputs. Drives the MAX button
  // (caps at spendable, not total) and the asset-row subtitle. Stays
  // 0 on mainnet during sync since the indexer omits the field.
  const [btcProtected, setBtcProtected] = useState<number>(0);
  const [btcLoaded, setBtcLoaded] = useState(false);
  const [archBalance, setArchBalance] = useState<string | null>(null);
  const [tokensHeld, setTokensHeld] = useState<TokenHolding[]>([]);

  const [btcPrepare, setBtcPrepare] = useState<BtcPrepareResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [feeTiers, setFeeTiers] = useState<FeeTier[]>(() => buildFeeTiers(null));
  const [feeTierId, setFeeTierId] = useState<FeeTierId>(DEFAULT_FEE_TIER_ID);

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
        setBtcProtected(
          typeof btcSummary?.protected_value === "number"
            ? btcSummary.protected_value
            : 0
        );
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
        // Route through the shared enrichment pipeline so the wallet's
        // known-mints registry (e.g. wrapped BTC → "aBTC") wins over
        // raw indexer fields. This keeps the asset picker, send form,
        // and confirmation step consistent with the Tokens/Dashboard
        // pages.
        const enriched = await enrichIndexerTokens(rawTokens, state.network, indexer);
        const held: TokenHolding[] = enriched.map((e) => ({
          mint: e.mint,
          tokenAccount: e.tokenAccount || undefined,
          balance: e.balance,
          rawAmount: String(e.balance),
          decimals: e.decimals,
          symbol: e.symbol,
          name: e.name,
          uiAmount: e.uiAmount,
          image: e.image,
        }));
        setTokensHeld(held);
      } catch {
        setTokensHeld([]);
      }
    };
    loadBalances();
    return () => clearTimeout(timeout);
  }, [activeAccount, state.network]);

  // ── Form-state persistence (chrome.storage.session) ───────────
  //
  // MV3 popups unmount on focus loss; without persistence the user
  // loses every keystroke when they click out to grab a recipient
  // address from another app. Restore once on mount when there's
  // no explicit deep-link / preset URL param taking priority.
  const formRestoredRef = useRef(false);
  useEffect(() => {
    if (formRestoredRef.current) return;
    if (!activeAccount) return;
    // Explicit deep-links win -- the user just clicked a "Send
    // ARCH" link from Token Detail, that intent supersedes a parked
    // form.
    if (presetAsset) return;
    formRestoredRef.current = true;
    (async () => {
      const ck = await loadSendForm({
        kind: "btc-arch-apl",
        accountId: activeAccount.id,
        network: state.network,
      });
      if (!ck || ck.form.kind !== "btc-arch-apl") return;
      const f = ck.form;
      // Validate the persisted asset before applying -- defensive
      // against schema drift / future asset additions.
      if (f.asset === "btc" || f.asset === "arch" || f.asset === "apl") {
        setAsset(f.asset as AssetType);
        setRecipient(f.recipient);
        setAmount(f.amount);
        // APL token selection is two-phase: stash the mint here,
        // a separate effect (below) resolves it against tokensHeld
        // once that list finishes loading.
        pendingTokenMintRef.current = f.asset === "apl" ? f.selectedTokenMint : null;
        setStep(2);
      }
    })();
  }, [activeAccount, presetAsset, state.network]);

  // Phase 2 of the restore: tokensHeld loads async; once it does,
  // resolve the persisted APL mint to its TokenHolding so the form
  // shows the right token chip + balance.
  const pendingTokenMintRef = useRef<string | null>(null);
  useEffect(() => {
    const mint = pendingTokenMintRef.current;
    if (!mint || !tokensHeld.length) return;
    const match = tokensHeld.find((t) => t.mint === mint);
    if (match) setSelectedToken(match);
    pendingTokenMintRef.current = null;
  }, [tokensHeld]);

  // Save the form whenever its restorable fields change. We only
  // persist during the data-entry step (2) -- saving while on the
  // asset-picker (step 1) would store an empty form, and saving on
  // Review (3) / Complete (4) risks restoring to a state with a
  // stale prepared PSBT.
  useEffect(() => {
    if (!activeAccount) return;
    if (step !== 2) return;
    // Empty form isn't worth persisting -- avoids stomping a
    // legitimate parked form when the user briefly bounces to /send
    // and back.
    if (!asset && !recipient && !amount) return;
    void saveSendForm({
      form: {
        kind: "btc-arch-apl",
        asset: asset ?? null,
        selectedTokenMint: selectedToken?.mint ?? null,
        recipient,
        amount,
      },
      accountId: activeAccount.id,
      network: state.network,
    });
  }, [step, asset, selectedToken, recipient, amount, activeAccount, state.network]);

  // Drop the parked form once a transaction broadcasts. We don't
  // want a successful send to leave its inputs lingering and
  // auto-fill them into the next send.
  useEffect(() => {
    if (step === 4) {
      void clearSendForm();
    }
  }, [step]);

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
      // Route through the session-stamped signer so the prompt the
      // user already accepted at unlock covers this signature too.
      // The signer's IndexedDbStamper signs the payload locally; we
      // hand the resulting (r||s) to the Hub which broadcasts the
      // server-side signing request.
      const signer = signerForAccount(activeAccount);
      const { signature64Hex } = await signer.signArchPayload({
        signingRequestId,
        payloadHex,
      });
      const client = await getClient();
      const externalUserId = await getExternalUserId();
      const submitRes = await client.submitSigningRequest(signingRequestId, {
        externalUserId,
        signature64Hex,
      });
      const res = (submitRes as any).result ?? submitRes;
      return res?.txid || res?.txidHex || signingRequestId;
    },
    [activeAccount]
  );

  const signWithExternalWallet = useCallback(
    async (signingRequestId: string, psbtBase64: string): Promise<string> => {
      if (!isExternalAccount(activeAccount)) {
        throw new Error("Active account is not an external wallet");
      }
      const adapter = getExternalWalletAdapter(activeAccount.externalProvider);
      setSignStatus(`Waiting for ${adapter.label} to sign…`);
      const signature64Hex = await adapter.signPsbt({
        address: activeAccount.btcAddress,
        psbtBase64,
        network: state.network,
      });
      setSignStatus("Submitting to Wallet Hub…");
      const client = await getClient();
      const externalUserId = await getExternalUserId();
      const submitRes = await client.submitSigningRequest(signingRequestId, {
        externalUserId,
        signature64Hex,
      });
      const res = (submitRes as any).result ?? submitRes;
      return res?.txid || res?.txidHex || signingRequestId;
    },
    [activeAccount, state.network],
  );

  const handlePrepareBtc = useCallback(
    async (
      opts?: {
        /** Override the fee tier to prepare against. Defaults to the
         *  picker's current selection. */
        feeTier?: FeeTierId;
        /** When true, leaves the existing review screen visible. */
        keepStep?: boolean;
      },
    ) => {
      if (!activeAccount || !recipient || !amount) return;
      setPreparing(true);
      setError("");
      if (!opts?.keepStep) setBtcPrepare(null);
      try {
        const amountSats = Math.round((Number(amount) || 0) * 1e8);
        // Dust threshold depends on the recipient's script type:
        // P2WPKH=294, P2TR/P2WSH=330, P2SH=540, P2PKH=546. The old
        // hardcoded 546 blocked legitimately-relayable small sends
        // to SegWit/Taproot recipients (which most modern wallets
        // are). dustThresholdForAddress() returns the canonical
        // post-segwit value matching Bitcoin Core's policy.
        const recipientDust = dustThresholdForAddress(recipient.trim());
        if (amountSats < recipientDust) {
          throw new Error(`Amount too small (minimum ${recipientDust} sats for this address type)`);
        }

        const fromAddress = reEncodeTaprootAddress(activeAccount.btcAddress, state.network);

        const indexer = await getIndexer();

        // Refresh the tier model alongside the prepare. The indexer
        // typically caches fee estimates for a few seconds, so this
        // is cheap even when called more than once per Send flow. We
        // use the freshly-fetched tiers to derive the rate so the
        // picker UI and the actual PSBT never disagree.
        let nextTiers = feeTiers;
        try {
          const estimates = await indexer.getBtcFeeEstimates();
          nextTiers = buildFeeTiers(estimates);
          setFeeTiers(nextTiers);
        } catch {
          /* fall back to previously-resolved tiers */
        }

        const activeTierId = opts?.feeTier ?? feeTierId;
        const feeRate = tierById(nextTiers, activeTierId).satPerVbyte;

        const built = await buildUnsignedPsbt({
          indexer,
          fromAddress,
          toAddress: recipient,
          amountSats,
          feeRate,
        });
        setBtcPrepare({
          psbtHex: built.psbt.toHex(),
          psbtBase64: built.psbt.toBase64(),
          feeSats: built.feeSats,
          feeRate: built.feeRate,
          changeSats: built.changeSats,
          inputCount: built.inputCount,
        });
        if (!opts?.keepStep) setStep(3);
      } catch (err: any) {
        setError(err.message || "Failed to prepare transaction");
      } finally {
        setPreparing(false);
      }
    },
    [activeAccount, recipient, amount, state.network, feeTiers, feeTierId],
  );

  /**
   * User picked a different fee priority on the review screen.
   * Re-prepare the PSBT at the new rate without flipping the step or
   * blanking the existing preview, so the user sees the new fee
   * appear in place. UTXO selection runs again because a higher rate
   * can require an additional input.
   */
  const handleSelectFeeTier = useCallback(
    (next: FeeTierId) => {
      setFeeTierId(next);
      void handlePrepareBtc({ feeTier: next, keepStep: true });
    },
    [handlePrepareBtc],
  );

  const handleBtcSign = useCallback(async () => {
    if (!activeAccount || !btcPrepare) return;
    setLoading(true);
    setError("");
    try {
      const isTestnet = state.network === "testnet4";
      const network = isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

      // Two signing paths: external (Xverse / UniSat)
      // and internal (Turnkey passkey / email session). The PSBT we
      // built locally is the same for both; only the signer differs.
      // We always finalize and broadcast through our indexer so our
      // own pending-UTXO view stays in sync regardless of who signed.
      let signedPsbtBase64: string;
      if (isExternalAccount(activeAccount)) {
        const adapter = getExternalWalletAdapter(activeAccount.externalProvider);
        setSignStatus(`Waiting for ${adapter.label} to sign…`);
        const inputIndexes = Array.from({ length: btcPrepare.inputCount }, (_, i) => i);
        const signed = await adapter.signBtcPsbt({
          address: activeAccount.btcAddress,
          psbtBase64: btcPrepare.psbtBase64,
          network: state.network,
          inputIndexes,
        });
        signedPsbtBase64 = signed.signedPsbtBase64;
      } else {
        if (!activeAccount.organizationId)
          throw new Error("Missing organization ID for this wallet");
        setSignStatus("Signing transaction…");
        // Locally-built PSBT, session-stamped signer. The signer
        // figures out whether the active session was bootstrapped via
        // WebAuthn (passkey) or OTP (email); the call site doesn't
        // need to care.
        const { signedPsbtHex } = await signerForAccount(activeAccount).signPsbt({
          psbtHex: btcPrepare.psbtHex,
        });
        signedPsbtBase64 = hexToBase64(signedPsbtHex);
      }

      setSignStatus("Broadcasting transaction…");
      const rawTxHex = finalizeSignedPsbt(signedPsbtBase64, network);

      const indexer = await getIndexer();
      const txid = await indexer.broadcastBtc(rawTxHex);
      setTxResult({ txid, rawTxid: txid });
      void addRecentRecipient({ address: recipient.trim(), asset: "btc", network: state.network });

      // Fire a system notification so users see the outcome even
      // after closing the popup. Click opens the mempool.space
      // explorer for this tx. Amount-only message; no recipient.
      void notifyTxBroadcast({
        title: "Bitcoin transfer broadcast",
        message: `${formatBtc(Math.round((Number(amount) || 0) * 1e8))} BTC sent`,
        explorerUrl: buildExplorerUrl({ kind: "btc", txid, network: state.network }),
      });

      setStep(4);
    } catch (err: any) {
      setError(err.message || "Transaction signing failed");
      void notifyTxFailed({
        title: "Bitcoin transfer failed",
        message: err?.message ? String(err.message).slice(0, 200) : "Broadcast failed",
      });
    } finally {
      setLoading(false);
      setSignStatus(null);
    }
  }, [activeAccount, btcPrepare, state.network, recipient, amount, addRecentRecipient]);

  const handleSubmit = useCallback(async () => {
    if (!activeAccount) return;

    if (asset === "btc") {
      return handleBtcSign();
    }

    setLoading(true);
    setError("");
    setSignStatus("Preparing signing request…");
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

      // Money/signing routes require a per-user Wallet Hub session.
      // Direct sends previously relied on the unlock-time best-effort
      // mint, so this path could reach Review successfully and then
      // fail with a missing-session 401. Prepare the signing session
      // and await the Hub token immediately before the enforced calls.
      await ensureSigningSessionForAccount(activeAccount);
      const client = await getClient();
      const externalUserId = await getExternalUserId();
      client.setSessionSigner(
        buildSessionSigner(activeAccount, externalUserId, state.network),
      );
      await ensureHubSession(activeAccount, state.network);

      const submitViaHub = async (): Promise<string> => {
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
          signer: isExternalAccount(activeAccount)
            ? {
                kind: "external",
                taprootAddress: activeAccount.btcAddress,
                publicKeyHex: activeAccount.publicKeyHex || undefined,
              }
            : { kind: "turnkey", resourceId: activeAccount.turnkeyResourceId },
          action,
        });

        if (isExternalAccount(activeAccount)) {
          const psbtBase64 = (sr.payloadToSign as any)?.psbtBase64;
          if (!psbtBase64) throw new Error("No PSBT available for external wallet signing");
          return await signWithExternalWallet(sr.signingRequestId, psbtBase64);
        }

        // Unified local-sign path for both passkey and email wallets.
        // The session-stamped signer takes care of whichever bootstrap
        // (WebAuthn or OTP) opened the IndexedDB session; the Hub
        // never sees the signing key.
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
        } else if (
          isWalletHubUnknownResourceError(err) &&
          !isExternalAccount(activeAccount) &&
          activeAccount.authMethod !== "email"
        ) {
          const client = await getClient();
          const registered = await client.registerExistingPasskeyWallet({
            externalUserId: await getExternalUserId(),
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
      if (asset === "apl" || asset === "arch") {
        void addRecentRecipient({
          address: recipient.trim(),
          asset,
          network: state.network,
          mint: asset === "apl" ? selectedToken?.mint : undefined,
        });
      }

      // Amount-formatting matches the on-screen success card: ARCH
      // amounts use formatArch on the raw lamports we just submitted,
      // and APL amounts reuse the token's display formatter so the
      // notification matches what History will show on next sync.
      const notifMessage =
        asset === "apl" && selectedToken
          ? `${formatTokenAmount(Number(aplRawAmount!), selectedToken.decimals)} ${selectedToken.symbol || "APL"} sent`
          : `${formatArch(archLamports)} ARCH sent`;
      void notifyTxBroadcast({
        title: asset === "apl" ? "Token transfer broadcast" : "ARCH transfer broadcast",
        message: notifMessage,
        explorerUrl: buildExplorerUrl({ kind: "arch", txid, network: state.network }),
      });

      setStep(4);
    } catch (err: any) {
      if (err instanceof EmailSessionNeededError) {
        setError("");
        setOtpAccount(err.account);
        return;
      }
      setError(formatWalletHubError(err, "Transaction failed"));
      void notifyTxFailed({
        title: asset === "apl" ? "Token transfer failed" : "ARCH transfer failed",
        message: err?.message ? String(err.message).slice(0, 200) : "Broadcast failed",
      });
    } finally {
      setLoading(false);
      setSignStatus(null);
    }
  }, [activeAccount, asset, selectedToken, recipient, amount, signWithPasskey, signWithExternalWallet, handleBtcSign, addRecentRecipient, state.network]);

  const handleOtpReady = useCallback(() => {
    setOtpAccount(null);
    void handleSubmit();
  }, [handleSubmit]);

  const resetFlow = useCallback(() => {
    setStep(1);
    setAsset(null);
    setSelectedToken(null);
    setRecipient("");
    setAmount("");
    setError("");
    setTxResult(null);
    setBtcPrepare(null);
    setBtcAmountMode("btc");
    setBtcUsdAmount("");
    // The form has been intentionally reset -- drop any parked
    // checkpoint so reopening the popup lands on the asset-picker
    // instead of restoring stale fields.
    void clearSendForm();
  }, []);

  const isTestnet = state.network === "testnet4";
  const archExplorerBase = isTestnet
    ? "https://explorer.arch.network/testnet/tx/"
    : "https://explorer.arch.network/mainnet/tx/";
  const btcExplorerBase = isTestnet
    ? "https://mempool.space/testnet4/tx/"
    : "https://mempool.space/tx/";

  if (otpAccount) {
    return (
      <div className="send-form-shell">
        <SessionBootstrapper
          account={otpAccount}
          onReady={handleOtpReady}
          onCancel={() => setOtpAccount(null)}
        />
      </div>
    );
  }

  // Watch-only accounts cannot sign or broadcast. Refuse at the
  // page level so the user never gets a partially-filled form they
  // can't actually submit.
  if (activeAccount && isWatchAccount(activeAccount)) {
    return (
      <>
        <div className="page-header" style={{ marginBottom: 18 }}>
          <h2 className="page-title">Send</h2>
          <div className="page-subtitle">This wallet is read-only.</div>
        </div>
        <div className="card">
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <strong>{activeAccount.label}</strong> is a watch-only address. The
            wallet can see its balance and history but cannot sign transactions.
            <br />
            <br />
            To send funds from this address, switch to a wallet that holds the
            signing key (a passkey, email, or linked external wallet).
          </div>
        </div>
        <button
          className="btn btn-secondary btn-full"
          style={{ marginTop: 16 }}
          onClick={() => navigate("/dashboard")}
        >
          Back to dashboard
        </button>
      </>
    );
  }

  // Step 1: Choose asset
  if (step === 1) {
    return (
      <>
        <div className="page-header" style={{ marginBottom: 18 }}>
          <h2 className="page-title">Send</h2>
          <div className="page-subtitle">Choose which asset you want to send.</div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="send-asset-list">
          <button
            className="card send-asset-card"
            onClick={() => {
              setAsset("btc");
              setStep(2);
            }}
          >
            <div className="asset-row send-asset-row">
              {renderAssetIcon("btc", null)}
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
              {renderAssetIcon("arch", null)}
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
                {renderAssetIcon("apl", tk)}
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
                {renderAssetIcon("apl", null)}
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

    const assetLabel = asset === "apl" && selectedToken
      ? (selectedToken.symbol || selectedToken.name || "APL Token")
      : meta.label;
    const assetSub = asset === "btc"
      ? "Bitcoin"
      : asset === "arch"
        ? "Native gas token"
        : selectedToken?.name || "APL token";
    // Effective max for a BTC send is `confirmed - protected` (sats
    // locked in inscriptions/runes can't be moved by a plain send).
    // Pending is excluded too -- prepareBtcSend only walks confirmed
    // UTXOs, so a MAX based on pending would always fail.
    const btcSpendableSats = Math.max(0, btcConfirmed - btcProtected);
    // Show spendable as the headline figure for BTC. If protected
    // sats exist, append a "+0.001 BTC locked" tail so the user
    // understands the gap between this number and their dashboard
    // balance.
    const availableValue = asset === "btc" && btcLoaded
      ? (btcProtected > 0
          ? `${(btcSpendableSats / 1e8).toFixed(8)} BTC spendable (+${(btcProtected / 1e8).toFixed(8)} locked in inscriptions/runes)`
          : `${((btcConfirmed + btcPending) / 1e8).toFixed(8)} BTC`)
      : asset === "arch" && archBalance
        ? formatArch(archBalance)
        : asset === "apl" && selectedToken
          ? `${selectedToken.uiAmount} ${selectedToken.symbol || ""}`.trim()
          : "—";
    const showMax = (asset === "btc" && btcLoaded && btcSpendableSats > 0)
      || (asset === "arch" && archBalance && Number(archBalance) > 0)
      || (
        asset === "apl"
        && selectedToken !== null
        && parseRawTokenAmount(selectedToken.rawAmount) > 0n
      );
    const handleMax = () => {
      if (asset === "btc") {
        const maxBtc = (btcSpendableSats / 1e8).toFixed(8);
        setAmount(maxBtc);
        if (btcAmountMode === "usd") {
          setBtcUsdAmount(btcInputToUsd(maxBtc, btcUsd));
        }
      } else if (asset === "arch" && archBalance) {
        setAmount((Number(archBalance) / 1e9).toFixed(4));
      } else if (asset === "apl" && selectedToken) {
        setAmount(
          rawTokenAmountToInput(selectedToken.rawAmount, selectedToken.decimals),
        );
      }
    };
    const btcUsdLine = asset === "btc" && Number(amount) > 0
      ? btcUsdSubtitle(Math.round(Number(amount) * 1e8), btcUsd)
      : null;
    const amountInputValue =
      asset === "btc" && btcAmountMode === "usd" ? btcUsdAmount : amount;
    const handleAmountChange = (value: string) => {
      if (asset === "btc" && btcAmountMode === "usd") {
        setBtcUsdAmount(value);
        setAmount(usdInputToBtc(value, btcUsd));
        return;
      }
      setAmount(value);
    };
    const toggleBtcAmountMode = () => {
      if (btcAmountMode === "btc") {
        setBtcUsdAmount(btcInputToUsd(amount, btcUsd));
        setBtcAmountMode("usd");
      } else {
        setBtcAmountMode("btc");
      }
    };
    const btcAmountHint =
      asset !== "btc" || Number(amount) <= 0
        ? null
        : btcAmountMode === "usd"
          ? `≈ ${amount} BTC`
          : btcUsdLine
            ? `≈ ${btcUsdLine}`
            : null;

    // Recent recipients for the current asset / network / mint context.
    // The store keeps them MRU-sorted; we cap to 6 here to keep the chip
    // strip from overflowing the form column.
    const recentMatches = (state.recentRecipients || [])
      .filter((r) => {
        if (r.network !== state.network) return false;
        if (asset === "btc") return r.asset === "btc";
        if (asset === "arch") return r.asset === "arch";
        if (asset === "apl") {
          return r.asset === "apl" && r.mint === selectedToken?.mint;
        }
        return false;
      })
      .slice(0, 6);

    return (
      <div className="send-form-shell">
        <BackBar onBack={() => setStep(1)} />
        <div className="page-header">
          <h2 className="page-title">Send {assetLabel}</h2>
          <div className="page-subtitle">Enter the recipient address and the amount to send.</div>
        </div>

        <div className="asset-summary-chip">
          {renderAssetIcon(asset, asset === "apl" ? selectedToken : null)}
          <div className="asset-summary-chip-info">
            <div className="asset-summary-chip-name">{assetLabel}</div>
            <div className="asset-summary-chip-sub">{assetSub}</div>
          </div>
          <div className="asset-summary-chip-balance">
            <div className="asset-summary-chip-balance-label">Available</div>
            <div className="asset-summary-chip-balance-value">{availableValue}</div>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="form-field">
          <div className="form-field-header">
            <label className="form-field-label">Recipient address</label>
            {recentMatches.length > 0 && (
              <span className="form-field-meta">{recentMatches.length} recent</span>
            )}
          </div>
          <div className="form-field-input">
            <input
              placeholder={asset === "btc" ? "tb1p…" : "Base58 address"}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="qr-scan-btn"
              onClick={() => setShowQrScanner(true)}
              title="Scan QR code"
              aria-label="Scan QR code"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="6" height="6" rx="1" />
                <rect x="15" y="3" width="6" height="6" rx="1" />
                <rect x="3" y="15" width="6" height="6" rx="1" />
                <path d="M15 15h2v2h-2zM19 19h2v2h-2zM15 19h2v2h-2zM19 15h2v2h-2z" />
              </svg>
            </button>
          </div>
          {showQrScanner && (
            <QrScanner
              onResult={(text) => {
                setRecipient(text);
                setShowQrScanner(false);
              }}
              onClose={() => setShowQrScanner(false)}
            />
          )}
          {asset === "btc" && recipient.trim() && isWrongNetworkAddress(recipient.trim(), state.network) && (
            <div className="approve-risk approve-risk-danger" style={{ marginTop: 6 }}>
              This address looks like {detectBtcNetwork(recipient.trim()) === "mainnet" ? "Mainnet" : "Testnet"} but you are on {state.network === "mainnet" ? "Mainnet" : "Testnet"}. Sending will fail or burn funds.
            </div>
          )}
          {recentMatches.length > 0 && (
            <div className="recent-recipients" role="list" aria-label="Recent recipients">
              {recentMatches.map((r) => {
                const selected = recipient.trim() === r.address;
                return (
                  <div
                    key={`${r.address}-${r.mint || ""}`}
                    className={`recent-chip${selected ? " selected" : ""}`}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="recent-chip-fill"
                      onClick={() => setRecipient(r.address)}
                      title={`${r.address}\nUsed ${r.useCount}x • ${new Date(r.lastUsedAt).toLocaleDateString()}`}
                    >
                      <span className="recent-chip-address mono">
                        {truncateAddress(r.address, 6)}
                      </span>
                      {r.useCount > 1 && (
                        <span className="recent-chip-count">×{r.useCount}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="recent-chip-remove"
                      aria-label="Remove from recents"
                      title="Remove from recents"
                      onClick={() => void removeRecentRecipient({
                        address: r.address,
                        asset: r.asset,
                        network: r.network,
                        mint: r.mint,
                      })}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="form-field">
          <div className="form-field-header">
            <label className="form-field-label">Amount</label>
            <span className="form-field-meta">
              Available <strong>{availableValue}</strong>
            </span>
          </div>
          <div className="form-field-input form-field-input--amount">
            <input
              type="number"
              step={
                asset === "btc" && btcAmountMode === "usd"
                  ? "0.01"
                  : asset === "btc"
                    ? "0.00000001"
                    : asset === "arch"
                      ? "0.0001"
                      : tokenInputStep(selectedToken?.decimals ?? 0)
              }
              placeholder="0.00"
              value={amountInputValue}
              onChange={(e) => handleAmountChange(e.target.value)}
              inputMode="decimal"
            />
            <span className="form-field-suffix">
              {asset === "btc" && btcAmountMode === "usd" ? "USD" : meta.unit}
            </span>
            {asset === "btc" && btcUsd !== null && (
              <button
                type="button"
                className="form-field-action"
                onClick={toggleBtcAmountMode}
                aria-label={
                  btcAmountMode === "btc"
                    ? "Enter amount in US dollars"
                    : "Enter amount in bitcoin"
                }
                title={
                  btcAmountMode === "btc"
                    ? "Enter amount in US dollars"
                    : "Enter amount in bitcoin"
                }
              >
                {btcAmountMode === "btc" ? "$ USD" : "₿ BTC"}
              </button>
            )}
            {showMax && (
              <button type="button" className="form-field-action" onClick={handleMax}>
                MAX
              </button>
            )}
          </div>
          {btcAmountHint && (
            <div className="form-field-hint">{btcAmountHint}</div>
          )}
        </div>

        {asset === "btc" && btcPending !== 0 && (
          <div className="form-field-pending">
            <span style={{ color: "var(--warning)", fontSize: 14 }}>⏳</span>
            <span>
              Includes <strong>{(btcPending / 1e8).toFixed(8)} BTC</strong> unconfirmed.
            </span>
          </div>
        )}

        <button
          className="btn btn-primary btn-full"
          disabled={!recipient || !amount || preparing}
          onClick={handleReview}
        >
          {preparing ? "Preparing…" : "Review"}
        </button>
      </div>
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

    const reviewAssetLabel = asset === "apl" && selectedToken
      ? (selectedToken.symbol || selectedToken.name || "APL")
      : meta.label;
    const amountPrimary = asset === "btc"
      ? `${Number(amount) || 0} BTC`
      : asset === "arch"
        ? `${Number(amount) || 0} ARCH`
        : selectedToken
          ? `${amount} ${selectedToken.symbol || "APL"}`
          : amount;
    const amountSubline = asset === "arch" && Number(amount) > 0
      ? `${Math.round((Number(amount) || 0) * 1e9).toLocaleString()} lamports`
      : asset === "btc" && amountSats > 0
        ? `${amountSats.toLocaleString()} sats`
        : asset === "apl" && aplRawAmount !== null
          ? `${aplRawAmount.toLocaleString()} raw units`
          : null;

    return (
      <div className="send-form-shell">
        <BackBar onBack={() => { setStep(2); setBtcPrepare(null); }} />
        <div className="page-header">
          <h2 className="page-title">Review</h2>
          <div className="page-subtitle">Double-check the details before signing this transaction.</div>
        </div>
        {networkStatus?.api === "disconnected" && asset !== "btc" && (
          <div className="warning-banner">
            This {asset === "apl" ? "APL token" : "ARCH"} send uses Wallet Hub for signing orchestration. Check Wallet Hub API in Settings if signing fails.
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}

        <div className="review-card">
          <div className="review-row">
            <div className="review-row-label">Asset</div>
            <div className="review-row-value">
              <span className="review-row-primary">
                <span style={{ display: "inline-flex", alignItems: "center", marginRight: 6 }}>
                  {renderAssetIcon(asset, asset === "apl" ? selectedToken : null, { inline: true })}
                </span>
                {reviewAssetLabel}
              </span>
            </div>
          </div>
          <div className="review-row">
            <div className="review-row-label">To</div>
            <div className="review-row-value">
              <span className="review-row-mono">{recipient}</span>
            </div>
          </div>
          <div className="review-row">
            <div className="review-row-label">Amount</div>
            <div className="review-row-value">
              <span className="review-row-primary">{amountPrimary}</span>
              {amountSubline && <span className="review-row-sub">{amountSubline}</span>}
            </div>
          </div>
          {asset === "apl" && selectedToken && (
            <div className="review-row">
              <div className="review-row-label">Mint</div>
              <div className="review-row-value">
                <span className="review-row-mono">{selectedToken.mint}</span>
              </div>
            </div>
          )}
          {asset === "btc" && btcPrepare && (
            <div className="review-section">
              <div className="review-section-label">Network Fee</div>
              <div style={{ marginBottom: 10 }}>
                <BtcFeeTierPicker
                  tiers={feeTiers}
                  selectedId={feeTierId}
                  vsize={
                    btcPrepare.feeRate > 0
                      ? Math.max(1, Math.round(btcPrepare.feeSats / btcPrepare.feeRate))
                      : 0
                  }
                  btcUsd={btcUsd}
                  onSelect={handleSelectFeeTier}
                  disabled={preparing || loading}
                />
              </div>
              <div className="review-section-row">
                <span className="label">Fee</span>
                <span className="value">
                  {btcPrepare.feeSats.toLocaleString()} sats ({(btcPrepare.feeSats / 1e8).toFixed(8)} BTC)
                </span>
              </div>
              <div className="review-section-row">
                <span className="label">Fee rate</span>
                <span className="value">{btcPrepare.feeRate.toFixed(1)} sat/vB</span>
              </div>
              <div className="review-section-row">
                <span className="label">Inputs</span>
                <span className="value">{btcPrepare.inputCount}</span>
              </div>
              {btcPrepare.changeSats > 0 && (
                <div className="review-section-row">
                  <span className="label">Change</span>
                  <span className="value">{btcPrepare.changeSats.toLocaleString()} sats</span>
                </div>
              )}
            </div>
          )}
          {asset === "btc" && btcPrepare && (
            <div className="review-total-row">
              <span className="label">Total</span>
              <span className="value">
                {((amountSats + btcPrepare.feeSats) / 1e8).toFixed(8)} BTC
              </span>
            </div>
          )}
        </div>

        <button
          className="btn btn-primary btn-full"
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? (signStatus || "Signing…") : "Confirm & Sign"}
        </button>
      </div>
    );
  }

  // Step 4: Complete
  const explorerUrl = asset === "btc"
    ? `${btcExplorerBase}${txResult?.rawTxid}`
    : `${archExplorerBase}${txResult?.rawTxid}`;

  return (
    <div className="send-form-shell">
      <div className="send-success">
        <div className="send-success-badge" aria-hidden>✓</div>
        <h2 className="send-success-title">Transaction sent</h2>
        <div className="send-success-subtitle">
          Your transaction is now broadcasting on the {asset === "btc" ? "Bitcoin" : "Arch"} network.
        </div>
        {txResult?.txid && (
          <div className="send-success-txid">{txResult.txid}</div>
        )}
        {txResult?.rawTxid && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm btn-secondary"
          >
            View on {asset === "btc" ? "Mempool" : "Explorer"} →
          </a>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn-secondary btn-full" onClick={resetFlow}>
          Send another
        </button>
        <button className="btn btn-primary btn-full" onClick={() => navigate("/dashboard")}>
          Done
        </button>
      </div>
    </div>
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
