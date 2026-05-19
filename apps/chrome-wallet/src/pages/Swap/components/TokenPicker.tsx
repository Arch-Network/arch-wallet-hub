/**
 * Bottom-sheet token picker used by both the sell and receive cards.
 * Renders the list of swappable tokens for the active network --
 * which today comes from the engine's TESTNET_CONFIG / MAINNET_CONFIG.
 */
import { useEffect, useRef } from "react";
import type { TokenInfo, TokenSymbol } from "@arch/swap-engine";

import { TokenChip } from "./TokenChip";

/**
 * Display fields are passed in pre-resolved so this component stays
 * decoupled from the wallet's display-override registry. The engine's
 * `TokenInfo.symbol` remains the routing/selection key; the
 * `displaySymbol` / `displayName` strings are what the user sees.
 */
export type PickerToken = TokenInfo & {
  displaySymbol: string;
  displayName: string;
};

type Props = {
  tokens: ReadonlyArray<PickerToken>;
  selected: TokenSymbol;
  /** Token currently selected by the *other* side -- prevents picking the same pair on both sides. */
  excluded?: TokenSymbol;
  onSelect: (symbol: TokenSymbol) => void;
  onClose: () => void;
};

export function TokenPicker({ tokens, selected, excluded, onSelect, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="swap-picker-overlay"
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      role="presentation"
    >
      <div className="swap-picker" role="dialog" aria-label="Select token">
        <div className="swap-picker-header">
          <span>Select a token</span>
          <button
            type="button"
            className="swap-picker-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <ul className="swap-picker-list">
          {tokens.map((token) => {
            const isSelected = token.symbol === selected;
            const isExcluded = excluded === token.symbol;
            return (
              <li key={token.symbol}>
                <button
                  type="button"
                  className={`swap-picker-row ${isSelected ? "selected" : ""}`}
                  disabled={isExcluded}
                  onClick={() => {
                    onSelect(token.symbol);
                    onClose();
                  }}
                >
                  <TokenChip symbol={token.displaySymbol} iconPath={token.icon} />
                  <span className="swap-picker-row-name">{token.displayName}</span>
                  {isExcluded && (
                    <span className="swap-picker-row-note">In use</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
