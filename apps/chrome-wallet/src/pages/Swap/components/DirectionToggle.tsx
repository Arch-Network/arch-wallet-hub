/**
 * Flip-direction button that swaps the sell / buy tokens. Visually
 * sits in the negative space between the two amount cards.
 */
type Props = {
  onClick: () => void;
  disabled?: boolean;
};

export function DirectionToggle({ onClick, disabled }: Props) {
  return (
    <div className="swap-direction-row">
      <button
        type="button"
        className="swap-direction-btn"
        onClick={onClick}
        disabled={disabled}
        aria-label="Flip swap direction"
        title="Flip swap direction"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 4v16" />
          <path d="M3 8l4-4 4 4" />
          <path d="M17 20V4" />
          <path d="M21 16l-4 4-4-4" />
        </svg>
      </button>
    </div>
  );
}
