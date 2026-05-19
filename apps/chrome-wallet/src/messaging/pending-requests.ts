/**
 * Service-worker-safe pending request store.
 *
 * Pending requests must survive an MV3 service-worker restart, otherwise
 * the user will hit "Request not found" on the Approve popup whenever
 * the SW is idle-killed between the dapp's `connect()` call and the
 * user clicking Approve. We back the store with `chrome.storage.session`
 * which lives for the duration of the browser session and is never
 * persisted to disk.
 */

import type { PendingRequest } from "./types";

const SESSION_KEY = "arch_wallet_pending_requests";

async function readAll(): Promise<Record<string, PendingRequest>> {
  try {
    if (!chrome?.storage?.session) return {};
    const res = await chrome.storage.session.get(SESSION_KEY);
    const data = res?.[SESSION_KEY];
    if (data && typeof data === "object") return data as Record<string, PendingRequest>;
    return {};
  } catch {
    return {};
  }
}

async function writeAll(map: Record<string, PendingRequest>): Promise<void> {
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.set({ [SESSION_KEY]: map });
  } catch {
    /* ignore */
  }
}

export const pendingRequestsStore = {
  async get(id: string): Promise<PendingRequest | null> {
    const all = await readAll();
    return all[id] ?? null;
  },

  async set(req: PendingRequest): Promise<void> {
    const all = await readAll();
    all[req.id] = req;
    await writeAll(all);
  },

  async remove(id: string): Promise<void> {
    const all = await readAll();
    delete all[id];
    await writeAll(all);
  },

  async list(): Promise<PendingRequest[]> {
    const all = await readAll();
    return Object.values(all);
  },

  async clearAll(): Promise<void> {
    await writeAll({});
  },
};
