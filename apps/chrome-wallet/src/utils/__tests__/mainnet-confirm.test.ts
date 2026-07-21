import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAINNET_CONFIRMED_KEY,
  hasConfirmedMainnet,
  markMainnetConfirmed,
} from "../mainnet-confirm";

describe("mainnet-confirm", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(),
          set: vi.fn(),
        },
      },
    });
  });

  it("returns false when the confirm key is missing", async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await expect(hasConfirmedMainnet()).resolves.toBe(false);
  });

  it("returns true when the confirm key is set", async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      [MAINNET_CONFIRMED_KEY]: true,
    });
    await expect(hasConfirmedMainnet()).resolves.toBe(true);
  });

  it("persists the confirm flag", async () => {
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await markMainnetConfirmed();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [MAINNET_CONFIRMED_KEY]: true,
    });
  });

  it("treats storage failures as unconfirmed / no-op", async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("denied"));
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("denied"));
    await expect(hasConfirmedMainnet()).resolves.toBe(false);
    await expect(markMainnetConfirmed()).resolves.toBeUndefined();
  });
});
