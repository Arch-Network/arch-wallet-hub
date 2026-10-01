/**
 * First-time mainnet switch gate (shared by Header network switcher
 * and Approve CONNECT). Stored in chrome.storage.local so a single
 * confirm covers the whole install.
 */

export const MAINNET_CONFIRMED_KEY = "arch_wallet_mainnet_confirmed";

export async function hasConfirmedMainnet(): Promise<boolean> {
  try {
    const res = await chrome.storage.local.get(MAINNET_CONFIRMED_KEY);
    return !!res?.[MAINNET_CONFIRMED_KEY];
  } catch {
    return false;
  }
}

export async function markMainnetConfirmed(): Promise<void> {
  try {
    await chrome.storage.local.set({ [MAINNET_CONFIRMED_KEY]: true });
  } catch {
    /* ignore — confirm UI can reappear next time */
  }
}
