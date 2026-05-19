/**
 * Human-readable labels for well-known Arch Network programs.
 *
 * Keyed by base58-encoded program ID.  The indexer sometimes returns its own
 * `display_name` / `program_name` – prefer that when available, and fall back
 * to this map for programs the indexer doesn't label.
 */
export const PROGRAM_LABELS: Record<string, string> = {
  // Core runtime
  "11111111111111111111111111111111": "System Program",
  "BpfLoader1111111111111111111111111111111111": "BPF Loader",

  // Token programs
  "AplToken111111111111111111111111": "APL Token",
  "AssociatedTokenAccount1111111111": "Associated Token Account",
  "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3": "Associated Token Account",

  // Resharing (key ceremony)
  "Resharing1111111111111111111111111111111111": "Resharing Program",
  "ResharingData111111111111111111111111111111": "Resharing Data Account",
  "ResharingStaging111111111111111111111111111": "Resharing Staging Account",

  // PropAMM swap
  "E5XgxZnEdvsanU8qYTxsQut3qsusMCkyhh3RzYMx481Y": "PropAMM Swap",
};

/**
 * Return a human-readable label for a program, falling back to a truncated ID.
 *
 * @param programId   base58 program ID
 * @param indexerName optional `program_name` / `display_name` from the indexer
 * @param keep        characters to keep on each side when truncating
 */
export function getProgramLabel(
  programId: string,
  indexerName?: string | null,
  keep = 6,
): string {
  if (indexerName) return indexerName;
  return PROGRAM_LABELS[programId] ?? truncateId(programId, keep);
}

function truncateId(id: string, keep: number): string {
  if (id.length <= keep * 2 + 3) return id;
  return `${id.slice(0, keep)}...${id.slice(-keep)}`;
}
