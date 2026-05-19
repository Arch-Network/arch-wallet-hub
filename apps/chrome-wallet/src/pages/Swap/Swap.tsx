/**
 * Native in-wallet swap. Wires `@arch/swap-engine` (quote routing +
 * transaction submission) to the popup's design system.
 *
 * Lifecycle:
 *
 *   1. On mount + whenever the network changes, push the wallet's
 *      indexer + price config into the engine via
 *      `configureSwapEngineFromAppState`.
 *
 *   2. Resolve the engine's `TokenInfo` for sell / buy from the
 *      current `NetworkConfig` (today: BTC + USDC on testnet).
 *
 *   3. Load BTC and APL balances from the indexer; pass into
 *      `useSwapQuote` so we can validate "exceeds balance" before
 *      ever asking the user to sign.
 *
 *   4. On Confirm, build a `WalletDigestSigner` from the active
 *      account, wrap with `makeSwapSigner`, and hand to
 *      `signAndSendTransaction` with `signaturePlacement: "prepend"`
 *      (PropAMM transactions ship with the program's signature
 *      pre-populated; the user's signature has to land in slot 0).
 *
 *   5. On success, link to the explorer; on failure surface a clean
 *      error banner without unrendering the form.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  applySlippage,
  signAndSendTransaction,
  type TokenInfo,
  type TokenSymbol,
} from "@arch/swap-engine";

import { useWallet } from "../../hooks/useWallet";
import { useArchOnboarding } from "../../hooks/useArchOnboarding";
import { getIndexer } from "../../utils/indexer";
import { formatSwapAmount } from "../../utils/format";
import { applyDisplayOverridesByMintHex, lookupKnownToken } from "../../utils/known-tokens";
import { isInSidePanel, openWalletPopup } from "../../utils/runtime-context";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import {
  configureSwapEngineFromAppState,
  getEngineNetworkConfig,
  swapTransactionSignerForAccount,
  walletStateForEngine,
} from "../../utils/swap-engine";

import { DirectionToggle } from "./components/DirectionToggle";
import { FaucetPanel } from "./components/FaucetPanel";
import { OnboardingPanel } from "./components/OnboardingPanel";
import { QuoteDetails } from "./components/QuoteDetails";
import { ReceiveAmountCard } from "./components/ReceiveAmountCard";
import { SellAmountCard } from "./components/SellAmountCard";
import { SubmitButton, type SwapValidation } from "./components/SubmitButton";
import { TokenPicker } from "./components/TokenPicker";
import { useSwapQuote } from "./useSwapQuote";

const DEFAULT_SLIPPAGE_PCT = 1;
const SWAP_LABEL = "Swap";

type TokenBalances = Partial<Record<TokenSymbol, number>>;

type Direction = "sell" | "buy";

type PickerState = { direction: Direction } | null;

function priceForSymbol(symbol: TokenSymbol, btcPrice: number): number {
  if (symbol === "BTC") return btcPrice;
  if (symbol === "USDC") return 1;
  return 0;
}

function pickTokens(
  symbols: TokenSymbol[],
  sell: TokenSymbol,
  buy: TokenSymbol,
): { sell: TokenSymbol; buy: TokenSymbol } {
  const fallback = symbols[0] ?? "BTC";
  const other = symbols.find((s) => s !== fallback) ?? fallback;
  const sellOk = symbols.includes(sell);
  const buyOk = symbols.includes(buy) && buy !== sell;
  return {
    sell: sellOk ? sell : fallback,
    buy: buyOk ? buy : sellOk ? other : fallback,
  };
}

export default function Swap() {
  const { state, activeAccount } = useWallet();
  const { price: btcUsdPriceRaw } = useBtcUsdPrice();
  const btcUsdPrice = btcUsdPriceRaw ?? 0;

  const config = useMemo(
    () => getEngineNetworkConfig(state.network),
    [state.network],
  );
  const availableSymbols = useMemo(
    () => Object.keys(config.tokens) as TokenSymbol[],
    [config],
  );

  useEffect(() => {
    configureSwapEngineFromAppState(state);
  }, [state]);

  const [pair, setPair] = useState<{ sell: TokenSymbol; buy: TokenSymbol }>(
    () => pickTokens(availableSymbols, "BTC", "USDC"),
  );

  useEffect(() => {
    setPair((prev) => pickTokens(availableSymbols, prev.sell, prev.buy));
  }, [availableSymbols]);

  const sellToken: TokenInfo | undefined = config.tokens[pair.sell];
  const buyToken: TokenInfo | undefined = config.tokens[pair.buy];

  // Display-only overrides. Keeps `pair.sell` / `pair.buy` (TokenSymbol)
  // intact as routing keys for balance lookups and price-feed wiring
  // while letting the UI label wrapped APL tokens (e.g. BTC → "aBTC")
  // distinctly from their L1 counterparts.
  const sellDisplay = useMemo(
    () =>
      sellToken
        ? applyDisplayOverridesByMintHex(
            { symbol: sellToken.symbol as string, name: sellToken.name },
            sellToken.mint,
          )
        : null,
    [sellToken],
  );
  const buyDisplay = useMemo(
    () =>
      buyToken
        ? applyDisplayOverridesByMintHex(
            { symbol: buyToken.symbol as string, name: buyToken.name },
            buyToken.mint,
          )
        : null,
    [buyToken],
  );

  const [rawInput, setRawInput] = useState("");
  const [picker, setPicker] = useState<PickerState>(null);
  const [balances, setBalances] = useState<TokenBalances>({});
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successTxid, setSuccessTxid] = useState<string | null>(null);
  // Bumping this triggers a balance re-load. Driven by both the manual
  // refresh button and the post-faucet auto-retry ladder.
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);
  const refreshBalances = useCallback(() => {
    setBalanceRefreshKey((n) => n + 1);
  }, []);

  // ── side-panel → popup handoff ────────────────────────────────────
  //
  // Chrome's side panel context cannot reliably surface WebAuthn /
  // passkey prompts (the prompt is anchored to a top-level browser
  // window and silently no-ops from the side panel iframe). We detect
  // the surface once at mount and, on Confirm Swap, defer to a fresh
  // popup window — passing the in-flight intent (`?sell=&buy=&amount=
  // &resume=1`) through the URL so the popup reconstructs the exact
  // same form the user just saw. The popup signs, broadcasts, and
  // surfaces success the normal way.
  const sidePanelMode = useMemo(() => isInSidePanel(), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const [resumedFromSidePanel, setResumedFromSidePanel] = useState(false);
  const resumeAppliedRef = useRef(false);

  useEffect(() => {
    if (resumeAppliedRef.current) return;
    if (searchParams.get("resume") !== "1") return;
    // Wait until the engine has materialised this network's token list
    // before applying — otherwise our pair guard rejects the symbols
    // and the resume becomes a no-op.
    if (availableSymbols.length === 0) return;
    resumeAppliedRef.current = true;

    const sellParam = searchParams.get("sell");
    const buyParam = searchParams.get("buy");
    const amountParam = searchParams.get("amount");

    setPair((prev) =>
      pickTokens(
        availableSymbols,
        (sellParam as TokenSymbol) ?? prev.sell,
        (buyParam as TokenSymbol) ?? prev.buy,
      ),
    );
    if (amountParam) {
      const parsed = Number.parseFloat(amountParam);
      if (Number.isFinite(parsed) && parsed > 0) {
        setRawInput(amountParam);
      }
    }
    setResumedFromSidePanel(true);

    // Wipe the URL so a popup refresh doesn't re-trigger resume mode
    // and so we don't keep stale params around in history.
    const next = new URLSearchParams(searchParams);
    next.delete("resume");
    next.delete("sell");
    next.delete("buy");
    next.delete("amount");
    setSearchParams(next, { replace: true });
  }, [searchParams, availableSymbols, setSearchParams]);

  // ── onboarding + faucet ───────────────────────────────────────────
  const onboarding = useArchOnboarding({
    account: activeAccount ?? null,
    config,
    network: state.network,
  });

  // Auto-refresh balances on a retry ladder after a successful faucet.
  // The upstream waits for one confirmation server-side, but the public
  // indexer can still serve stale `getAccountTokens` for tens of seconds
  // after that — empirically 15-30s is normal. A three-shot schedule
  // (4s/12s/24s) covers the common case without polling forever; the
  // user can also hit the manual refresh button at any time.
  const lastFaucetAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (onboarding.faucet.kind !== "success") return;
    if (lastFaucetAtRef.current === onboarding.faucet.at) return;
    lastFaucetAtRef.current = onboarding.faucet.at;
    const delays = [4_000, 12_000, 24_000];
    const handles = delays.map((delay) =>
      setTimeout(() => setBalanceRefreshKey((n) => n + 1), delay),
    );
    return () => handles.forEach(clearTimeout);
  }, [onboarding.faucet]);

  // ── balance loader ────────────────────────────────────────────────
  //
  // Three details that have bitten us before and are worth locking in:
  //
  //   1. The indexer returns `mint_address` as base58. The engine
  //      config stores `mint` as hex. Direct `===` comparison never
  //      matches. We route every comparison through the
  //      `known-tokens` registry, which indexes by both hex AND
  //      base58, then match on the hex form.
  //
  //   2. The wallet applies a display override to wrapped BTC
  //      (engine symbol "BTC" → display "aBTC"). That override
  //      lives in the SAME registry the enrichment helper reads,
  //      so an earlier implementation that matched on
  //      `enriched.symbol === wanted.symbol` silently dropped the
  //      BTC balance the moment the override shipped (engine
  //      `availableSymbols` contains "BTC"; enriched rows now
  //      carry "aBTC"). We therefore match on MINT here, not
  //      symbol — mint is the only stable routing key.
  //
  //   3. The Swap surface trades the *wrapped* BTC token on Arch
  //      L2, not the on-chain Bitcoin testnet sat balance. The
  //      faucet mints to the BTC ATA; the swap router routes
  //      through it. Reading the BTC sat balance here would show
  //      the wrong number (typically 0 on a fresh testnet
  //      account) and gate swaps behind funding the user's
  //      Bitcoin testnet address — which is unrelated to swaps.
  useEffect(() => {
    if (!activeAccount) {
      setBalances({});
      return;
    }
    let cancelled = false;
    (async () => {
      setBalancesLoading(true);
      try {
        const indexer = await getIndexer();
        const archAddr =
          activeAccount.archAddress ||
          (activeAccount.publicKeyHex
            ? deriveArchAccountAddress(activeAccount.publicKeyHex)
            : "");
        if (!archAddr) {
          if (!cancelled) setBalances({});
          return;
        }

        const tokensResp = await indexer.getAccountTokens(archAddr);
        const rows = tokensResp?.tokens ?? [];

        const next: TokenBalances = {};
        for (const symbol of availableSymbols) {
          next[symbol] = 0;
          const engineToken = config.tokens[symbol];
          if (!engineToken) continue;
          const wantedHex = engineToken.mint.toLowerCase();
          const row = rows.find((r) => {
            const known = lookupKnownToken(
              r.mint_address as string,
              state.network,
            );
            return known?.mintHex === wantedHex;
          });
          if (!row) continue;
          const amount = Number(row.amount) || 0;
          // The engine's `decimals` is authoritative — overrides
          // any (rare) indexer disagreement.
          const decimals = engineToken.decimals;
          next[symbol] =
            decimals > 0 ? amount / 10 ** decimals : amount;
        }

        if (!cancelled) setBalances(next);
      } catch {
        if (!cancelled) setBalances({});
      } finally {
        if (!cancelled) setBalancesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAccount, state.network, availableSymbols, config, balanceRefreshKey]);

  // ── quote ─────────────────────────────────────────────────────────
  const sellAmount = useMemo(() => {
    const parsed = Number.parseFloat(rawInput);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, [rawInput]);

  const walletForEngine = useMemo(
    () =>
      activeAccount
        ? walletStateForEngine(activeAccount)
        : { pubkeyXCoord: "", taprootAddress: "", identity: { providerId: "", providerLabel: "" } },
    [activeAccount],
  );

  const {
    quote,
    isLoading: isQuoteLoading,
    isStale,
    error: quoteError,
    refresh: refreshQuote,
  } = useSwapQuote({
    config,
    wallet: walletForEngine,
    sellToken: sellToken ?? ({} as TokenInfo),
    buyToken: buyToken ?? ({} as TokenInfo),
    sellAmount,
    btcUsdPrice: btcUsdPrice || 1,
  });

  const isQuoteRefreshing = isQuoteLoading || isStale;
  const hasFreshQuote =
    !!quote &&
    !isStale &&
    quote.sellSymbol === pair.sell &&
    quote.buySymbol === pair.buy;
  const buyAmount = hasFreshQuote ? quote!.buyAmount : 0;

  const showUsdSell = state.network === "mainnet" && btcUsdPrice > 0;
  const showUsdBuy = showUsdSell;
  const sellUsdValue = sellAmount * priceForSymbol(pair.sell, btcUsdPrice);
  const buyUsdValue = buyAmount * priceForSymbol(pair.buy, btcUsdPrice);

  // ── validation ────────────────────────────────────────────────────
  const sellBalance = balances[pair.sell] ?? 0;
  const buyBalance = balances[pair.buy] ?? 0;
  const validation: SwapValidation = useMemo(() => {
    if (!activeAccount) return { kind: "no-account" };
    // Block swap submission until the on-chain account + ATAs exist.
    // The OnboardingPanel above gives the user the path to fix this; the
    // submit button label points them at it so the page is self-documenting.
    if (onboarding.status === "needs-onboarding" || onboarding.status === "error") {
      return { kind: "needs-onboarding" };
    }
    if (sellAmount <= 0) return { kind: "empty" };
    if (sellAmount > sellBalance) {
      return {
        kind: "exceeds-balance",
        available: sellBalance,
        symbol: sellDisplay?.symbol ?? pair.sell,
      };
    }
    if (activeAccount.authMethod === "email") return { kind: "custodial-unsupported" };
    if (quoteError) return { kind: "quote-failed", message: quoteError };
    if (isQuoteRefreshing || !hasFreshQuote) return { kind: "quote-loading" };
    return { kind: "valid" };
  }, [
    activeAccount,
    onboarding.status,
    sellAmount,
    sellBalance,
    pair.sell,
    sellDisplay,
    quoteError,
    isQuoteRefreshing,
    hasFreshQuote,
  ]);

  // Show the faucet panel only when:
  //   - testnet (faucetAvailable)
  //   - onboarded
  //   - user has zero balance across all swappable tokens (= classic
  //     "I just connected and have nothing" state)
  // Once they have anything, the panel hides itself to keep the swap
  // surface uncluttered. The faucet remains reachable via the Settings
  // page in a future follow-up.
  const totalSwappableBalance = useMemo(
    () => availableSymbols.reduce((sum, s) => sum + (balances[s] ?? 0), 0),
    [availableSymbols, balances],
  );
  const shouldShowFaucet =
    onboarding.faucetAvailable &&
    onboarding.status === "ready" &&
    !balancesLoading &&
    totalSwappableBalance === 0;

  // ── handlers ──────────────────────────────────────────────────────
  const handleFlip = useCallback(() => {
    setPair((prev) => ({ sell: prev.buy, buy: prev.sell }));
    setRawInput("");
    setSuccessTxid(null);
  }, []);

  const handleMax = useCallback(() => {
    if (sellBalance <= 0) return;
    const decimals = pair.sell === "USDC" ? 2 : 8;
    setRawInput(sellBalance.toFixed(decimals));
  }, [sellBalance, pair.sell]);

  const handlePickToken = useCallback(
    (direction: Direction, symbol: TokenSymbol) => {
      setPair((prev) => {
        if (direction === "sell") {
          return { sell: symbol, buy: prev.buy === symbol ? prev.sell : prev.buy };
        }
        return { sell: prev.sell === symbol ? prev.buy : prev.sell, buy: symbol };
      });
      setRawInput("");
      setSuccessTxid(null);
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    if (validation.kind === "quote-failed") {
      refreshQuote();
      return;
    }
    if (validation.kind !== "valid") return;
    if (!activeAccount || !quote) return;

    // Side panel → defer signing to a fresh popup window where
    // WebAuthn actually works. We hand off the current intent via URL
    // params so the popup reconstructs the form the user just confirmed.
    if (sidePanelMode) {
      setError(null);
      setSuccessTxid(null);
      try {
        await openWalletPopup({
          path: "/swap",
          query: {
            sell: pair.sell,
            buy: pair.buy,
            amount: rawInput || String(sellAmount),
            resume: "1",
          },
        });
        setStatusMsg(
          "Continue in the popup window to sign. The side panel can't show passkey prompts.",
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? `Could not open the wallet popup: ${e.message}`
            : "Could not open the wallet popup.",
        );
      }
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setStatusMsg(null);
    setSuccessTxid(null);

    try {
      const signer = swapTransactionSignerForAccount(activeAccount);
      const txHash = await signAndSendTransaction(quote.runtimeTx, signer, {
        label: SWAP_LABEL,
        // PropAMM/CLAMM transactions arrive with the program's
        // signatures pre-populated. The user's signature has to land
        // in slot 0 and the rest must be preserved.
        signaturePlacement: "prepend",
        onStatus: (s) => setStatusMsg(s),
      });
      setSuccessTxid(txHash);
      setStatusMsg(null);
      setRawInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap failed");
      setStatusMsg(null);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    validation,
    activeAccount,
    quote,
    refreshQuote,
    sidePanelMode,
    pair.sell,
    pair.buy,
    rawInput,
    sellAmount,
  ]);

  const tokenList = useMemo(
    () =>
      availableSymbols
        .map((s) => {
          const t = config.tokens[s];
          if (!t) return null;
          const display = applyDisplayOverridesByMintHex(
            { symbol: t.symbol as string, name: t.name },
            t.mint,
          );
          return { ...t, displaySymbol: display.symbol, displayName: display.name };
        })
        .filter(
          (
            t,
          ): t is TokenInfo & { displaySymbol: string; displayName: string } => !!t,
        ),
    [availableSymbols, config],
  );

  const explorerBase =
    state.network === "mainnet"
      ? "https://explorer.arch.network/mainnet/tx/"
      : "https://explorer.arch.network/testnet/tx/";

  if (!sellToken || !buyToken) {
    return (
      <>
        <div className="page-header" style={{ marginBottom: 18 }}>
          <h2 className="page-title">Swap</h2>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <p style={{ margin: 0, color: "var(--text-muted)" }}>
            No swappable tokens on the current network.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-header swap-page-header" style={{ marginBottom: 14 }}>
        <div className="swap-page-header__text">
          <h2 className="page-title">Swap</h2>
          <div className="page-subtitle">
            Trade between Bitcoin and Arch-native tokens.
          </div>
        </div>
        {activeAccount && (
          <button
            type="button"
            className="swap-refresh-btn"
            onClick={refreshBalances}
            disabled={balancesLoading}
            aria-label="Refresh balances"
            title="Refresh balances"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={balancesLoading ? "swap-refresh-icon spinning" : "swap-refresh-icon"}
            >
              <path d="M21 12a9 9 0 1 1-3.6-7.2" />
              <polyline points="21 4 21 10 15 10" />
            </svg>
          </button>
        )}
      </div>

      <div className="swap-shell">
        <OnboardingPanel
          status={onboarding.status}
          readiness={onboarding.readiness}
          phase={onboarding.phase}
          error={onboarding.error}
          isInitializing={onboarding.isInitializing}
          onInitialize={onboarding.initialize}
        />

        {resumedFromSidePanel && (
          <div className="swap-resume-notice" role="status">
            Resumed from the side panel. Review the quote below and confirm
            to sign — the popup window can show the passkey prompt that the
            side panel can't.
          </div>
        )}

        <SellAmountCard
          value={rawInput}
          symbol={sellDisplay?.symbol ?? pair.sell}
          iconPath={sellToken.icon}
          usdValue={sellUsdValue}
          walletConnected={!!activeAccount}
          balance={sellBalance}
          isLoadingBalance={balancesLoading}
          showUsd={showUsdSell}
          onChange={setRawInput}
          onMax={handleMax}
          onPickToken={() => setPicker({ direction: "sell" })}
        />

        <DirectionToggle onClick={handleFlip} disabled={isSubmitting} />

        <ReceiveAmountCard
          amount={buyAmount}
          symbol={buyDisplay?.symbol ?? pair.buy}
          iconPath={buyToken.icon}
          usdValue={buyUsdValue}
          showUsd={showUsdBuy}
          isRefreshing={isQuoteRefreshing && sellAmount > 0}
          walletConnected={!!activeAccount}
          balance={buyBalance}
          onPickToken={() => setPicker({ direction: "buy" })}
        />

        {hasFreshQuote && (
          <QuoteDetails
            sellSymbol={sellDisplay?.symbol ?? pair.sell}
            buySymbol={buyDisplay?.symbol ?? pair.buy}
            sellAmount={sellAmount}
            buyAmount={buyAmount}
            slippagePct={DEFAULT_SLIPPAGE_PCT}
            source={quote!.source}
          />
        )}

        {validation.kind === "quote-failed" && (
          <div className="error-banner" style={{ marginTop: 8 }}>
            Quote failed: {validation.message}
          </div>
        )}

        {error && (
          <div className="error-banner" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}

        {statusMsg && (
          <div className="swap-status" role="status">
            {statusMsg}
          </div>
        )}

        {successTxid && (
          <div className="swap-success">
            <span>Swap submitted</span>
            <a
              href={`${explorerBase}${successTxid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm btn-secondary"
            >
              View on Explorer →
            </a>
          </div>
        )}

        {shouldShowFaucet && (
          <FaucetPanel
            status={onboarding.faucet}
            onRequest={onboarding.requestFunds}
            hint="Your account is ready, but you have no testnet tokens to swap yet."
          />
        )}

        <SubmitButton
          validation={validation}
          isSubmitting={isSubmitting}
          onSubmit={handleSubmit}
        />

        {validation.kind === "valid" && hasFreshQuote && (
          <div className="swap-fineprint">
            Min received (after {DEFAULT_SLIPPAGE_PCT}% slippage):{" "}
            <strong>
              {formatSwapAmount(
                applySlippage(buyAmount, DEFAULT_SLIPPAGE_PCT),
                pair.buy,
              )}{" "}
              {buyDisplay?.symbol ?? pair.buy}
            </strong>
          </div>
        )}
      </div>

      <div className="swap-network-footer">
        Network: {state.network === "testnet4" ? "Testnet" : "Mainnet"}
      </div>

      {picker && (
        <TokenPicker
          tokens={tokenList}
          selected={picker.direction === "sell" ? pair.sell : pair.buy}
          excluded={picker.direction === "sell" ? pair.buy : pair.sell}
          onSelect={(s) => handlePickToken(picker.direction, s)}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}
