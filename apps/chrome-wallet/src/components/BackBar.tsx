/**
 * Shared back affordance.
 *
 * One canonical back control for every drill-down screen (Send,
 * SendRune, SendInscription, Collectibles, Token list/detail). It
 * replaces the previously divergent implementations -- the muted
 * `.back-link` chevron on the form pages and the gold `.back-btn`
 * left-arrow on the token pages -- so style and behavior are
 * identical app-wide.
 *
 * The bar is sticky to the top of the scrolling content area, so it
 * stays reachable while the user scrolls long lists (activity feeds,
 * galleries) instead of scrolling off the top.
 */
interface BackBarProps {
  /** Click handler -- typically navigate(-1) / navigate to a route,
   *  or a state change (e.g. step back, close a detail pane). */
  onBack: () => void;
  /** Button label. Defaults to "Back". */
  label?: string;
  /** Disable while a flow is mid-flight (e.g. signing). */
  disabled?: boolean;
}

export default function BackBar({ onBack, label = "Back", disabled }: BackBarProps) {
  return (
    <div className="back-bar">
      <button
        type="button"
        className="back-link"
        onClick={onBack}
        disabled={disabled}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        {label}
      </button>
    </div>
  );
}
