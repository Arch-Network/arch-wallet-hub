// A validator answers an absent account with 404, the indexer's RPC with -32002; older nodes only say so in the message.
const NOT_FOUND_CODES = new Set([404, -32002]);

export function isAccountNotFound(err: unknown): boolean {
  const code = (err as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === "number" && NOT_FOUND_CODES.has(code)) return true;
  const message = String((err as { message?: unknown } | null)?.message ?? err).toLowerCase();
  return message.includes("not in database") || /account \S+ not found/.test(message);
}

export type AccountProbe = (pubkey: Uint8Array) => Promise<unknown>;

/**
 * Whether the recipient's token account needs a non-idempotent `Create` (mainnet's ATA program rejects one for an
 * account that exists). The indexer's token list is not an existence check: it omits a token account whose balance is
 * zero, so a recipient who once held the mint and emptied it reads as absent. An account the indexer names is used as
 * is; otherwise the derived ATA is read off the chain. A probe that fails for any other reason keeps the create.
 */
export async function resolveDestTokenAccount(params: {
  readonly indexedDestAta: Uint8Array | null;
  readonly derivedDestAta: Uint8Array;
  readonly probe: AccountProbe;
  readonly onProbeError?: (err: unknown) => void;
}): Promise<{ readonly destAta: Uint8Array; readonly create: boolean }> {
  if (params.indexedDestAta) return { destAta: params.indexedDestAta, create: false };
  try {
    const info = await params.probe(params.derivedDestAta);
    return { destAta: params.derivedDestAta, create: info === null || info === undefined };
  } catch (err) {
    if (!isAccountNotFound(err)) params.onProbeError?.(err);
    return { destAta: params.derivedDestAta, create: true };
  }
}
