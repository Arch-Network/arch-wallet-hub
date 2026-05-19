/**
 * Strip an amount-input string down to a single positive decimal
 * number. Removes any characters that aren't digits or dots, then
 * collapses repeated dots so only the first one survives. Used at the
 * keystroke boundary in every action-form so callers can pass the
 * result straight to a numeric parser without re-validating.
 *
 *   "1.2.3"  -> "1.23"
 *   "0.0a5"  -> "0.05"
 *   "abc"    -> ""
 */
export function sanitizeAmountInput(next: string): string {
  const cleaned = next.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot === -1) return cleaned;
  return (
    cleaned.slice(0, firstDot + 1) +
    cleaned.slice(firstDot + 1).replace(/\./g, "")
  );
}
