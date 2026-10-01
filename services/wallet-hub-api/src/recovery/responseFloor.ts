/** Resolve no earlier than `minMs` after `startedAtMs`. */
export async function padToMinimumDuration(startedAtMs: number, minMs: number): Promise<void> {
  const remaining = minMs - (Date.now() - startedAtMs);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
