/**
 * Testnet-only "Get test funds" affordance.
 *
 * Rendered between the swap form and the submit button when:
 *   - the active account is onboarded (status === "ready")
 *   - the network has a faucet configured (`faucetAvailable`)
 *   - and either:
 *       * the user has zero balance across all swappable tokens, OR
 *       * they explicitly toggled "show faucet" (future).
 *
 * The component is deliberately blunt: one button, one status line.
 * Polishing (per-token mints, amount overrides) lands later; right
 * now the priority is letting the user move from "I just onboarded"
 * to "I have testnet funds to swap" in a single click.
 */
import type { TokenSymbol, RequestFaucetResult } from "@arch/swap-engine";

import type { FaucetStatus } from "../../../hooks/useArchOnboarding";

// The engine knows the wrapped-BTC asset as "BTC"; the wallet displays
// it as "aBTC" everywhere else, so translate at the surface where we
// render the engine's TokenSymbol directly to the user.
function displaySymbolFor(symbol: TokenSymbol | string): string {
  return symbol === "BTC" ? "aBTC" : symbol;
}

type Props = {
  status: FaucetStatus;
  onRequest: (symbol?: TokenSymbol) => void;
  /** Inline note shown above the button, e.g. balance hint. */
  hint?: string;
};

function statusLine(status: FaucetStatus): { tone: "info" | "success" | "error"; text: string } | null {
  switch (status.kind) {
    case "idle":
      return null;
    case "running":
      return {
        tone: "info",
        text: status.symbol
          ? `Requesting ${displaySymbolFor(status.symbol)} from the testnet faucet…`
          : "Requesting test funds for every supported token…",
      };
    case "success": {
      const r: RequestFaucetResult = status.result;
      if (r.kind === "single") {
        return {
          tone: "success",
          text: `Minted ${r.minted} ${displaySymbolFor(r.token)}. (${r.txids.length} tx)`,
        };
      }
      const total = r.txids.length;
      const skipped = r.skipped?.length ?? 0;
      return {
        tone: "success",
        text:
          skipped > 0
            ? `Minted ${total} batch. ${skipped} symbol${skipped === 1 ? "" : "s"} skipped — see console.`
            : `Minted test funds for ${total} symbol${total === 1 ? "" : "s"}. Balances refresh in a few seconds.`,
      };
    }
    case "error":
      return { tone: "error", text: `Faucet error: ${status.message}` };
  }
}

export function FaucetPanel({ status, onRequest, hint }: Props) {
  const line = statusLine(status);
  const isRunning = status.kind === "running";
  return (
    <div className="faucet-panel">
      <div className="faucet-panel__head">
        <h4 className="faucet-panel__title">Need testnet funds?</h4>
        <span className="faucet-panel__chip">Testnet</span>
      </div>
      {hint && <p className="faucet-panel__hint">{hint}</p>}
      <button
        type="button"
        className="btn btn-secondary btn-full"
        disabled={isRunning}
        onClick={() => onRequest()}
      >
        {isRunning ? "Minting…" : "Get test funds (aBTC + USDC + USDT)"}
      </button>
      {line && (
        <div
          className={
            line.tone === "error"
              ? "error-banner faucet-panel__status"
              : line.tone === "success"
                ? "swap-success faucet-panel__status"
                : "swap-status faucet-panel__status"
          }
          role={line.tone === "error" ? "alert" : "status"}
        >
          {line.text}
        </div>
      )}
    </div>
  );
}
