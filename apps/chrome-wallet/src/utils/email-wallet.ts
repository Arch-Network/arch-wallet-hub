/**
 * The Hub id the extension stores as the account id.
 *
 * Verify returns it. A Hub that predates the field still returns the
 * session and the organization, and `GET /turnkey/wallets` lists the
 * same row once that session is attached.
 */
export function emailWalletResourceId(
  verified: { resourceId?: string | null; organizationId: string },
  wallets: ReadonlyArray<{ id: string; organizationId: string }>,
): string | null {
  if (typeof verified.resourceId === "string" && verified.resourceId.length > 0) {
    return verified.resourceId;
  }
  return wallets.find((w) => w.organizationId === verified.organizationId)?.id ?? null;
}
