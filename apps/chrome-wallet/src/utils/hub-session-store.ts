/**
 * Browser-session-scoped cache for per-user Wallet Hub session tokens
 * (Phase 2a of docs/security/session-auth-rollout.md).
 *
 * Deliberately dependency-free (no SDK, no signer, no wallet-store) so
 * both `utils/sdk.ts` (which re-attaches a cached token on every
 * `getClient()`) and `utils/hub-session.ts` (which mints + persists)
 * can import it without an import cycle.
 *
 * Storage choice: `chrome.storage.session` is browser-session-scoped
 * (cleared on browser restart, never written to disk). The token is an
 * opaque per-user bearer with a server-side TTL (~24h) and app scope --
 * far less sensitive than the keystore KEK -- so session storage is an
 * appropriate home for it. Entries are keyed by externalUserId +
 * accountId so switching the active account never reuses the wrong
 * principal's token.
 */

const HUB_SESSION_KEY = "arch-wallet:hub-session-tokens";

/**
 * Treat a token within this slack of its expiry as already expired so a
 * request started "just in time" doesn't land after the server has
 * expired it.
 */
const EXPIRY_SLACK_MS = 60_000;

interface StoredHubToken {
  token: string;
  /** Epoch ms. */
  expiresAtMs: number;
}

type HubTokenMap = Record<string, StoredHubToken>;

function cacheKey(externalUserId: string, accountId: string): string {
  return `${externalUserId}::${accountId}`;
}

function sessionArea(): chrome.storage.StorageArea | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = typeof chrome !== "undefined" ? chrome : undefined;
  return c?.storage?.session ?? null;
}

async function readMap(): Promise<HubTokenMap> {
  const area = sessionArea();
  if (!area) return {};
  try {
    const result = await area.get(HUB_SESSION_KEY);
    const raw = result?.[HUB_SESSION_KEY];
    if (raw && typeof raw === "object") return raw as HubTokenMap;
    return {};
  } catch {
    return {};
  }
}

async function writeMap(map: HubTokenMap): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.set({ [HUB_SESSION_KEY]: map });
  } catch {
    /* best-effort: in-memory client token still works for this context */
  }
}

/**
 * Return a live (non-expired) token for the principal, or null. Expired
 * entries are pruned as a side effect so they don't linger.
 */
export async function readHubToken(
  externalUserId: string,
  accountId: string,
): Promise<string | null> {
  if (!externalUserId || !accountId) return null;
  const map = await readMap();
  const entry = map[cacheKey(externalUserId, accountId)];
  if (!entry) return null;
  if (entry.expiresAtMs - EXPIRY_SLACK_MS <= Date.now()) {
    delete map[cacheKey(externalUserId, accountId)];
    await writeMap(map);
    return null;
  }
  return entry.token;
}

export async function writeHubToken(
  externalUserId: string,
  accountId: string,
  token: string,
  expiresAtMs: number,
): Promise<void> {
  if (!externalUserId || !accountId) return;
  const map = await readMap();
  map[cacheKey(externalUserId, accountId)] = { token, expiresAtMs };
  await writeMap(map);
}

/** Drop every cached token. Called on wallet lock. */
export async function clearAllHubTokens(): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.remove(HUB_SESSION_KEY);
  } catch {
    /* ignore */
  }
}
