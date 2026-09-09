import type { OpenAsMode } from "./types";

// UI preference must remain readable when the encrypted wallet is locked.
export const OPEN_AS_KEY = "arch_wallet_open_as";

export async function readOpenAsPreference(): Promise<OpenAsMode | undefined> {
  const value = (await chrome.storage.local.get(OPEN_AS_KEY))[OPEN_AS_KEY];
  return value === "popup" || value === "sidepanel" ? value : undefined;
}

export async function writeOpenAsPreference(mode: OpenAsMode): Promise<void> {
  await chrome.storage.local.set({ [OPEN_AS_KEY]: mode });
}
