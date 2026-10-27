import { afterEach, describe, expect, it, vi } from "vitest";
import { openWalletPopup, reopenForExternalSigning } from "../runtime-context";

function stubChrome(currentTab: unknown) {
  const create = vi.fn().mockResolvedValue({});
  vi.stubGlobal("chrome", {
    tabs: { getCurrent: vi.fn().mockResolvedValue(currentTab) },
    windows: { create },
    runtime: { getURL: (path: string) => `chrome-extension://id${path}` },
  });
  return create;
}

afterEach(() => vi.unstubAllGlobals());

describe("reopenForExternalSigning", () => {
  it("reopens the form in a standalone window from the toolbar popup", async () => {
    const create = stubChrome(undefined);
    await expect(reopenForExternalSigning("/send")).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "chrome-extension://id/popup.html#/send", type: "popup", focused: true }),
    );
  });

  it("signs in place from a window or tab that survives focus loss", async () => {
    const create = stubChrome({ id: 7 });
    await expect(reopenForExternalSigning("/send")).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("openWalletPopup", () => {
  it("opens at the size the user last resized a popup window to", async () => {
    const create = vi.fn().mockResolvedValue({});
    vi.stubGlobal("chrome", {
      windows: { create },
      runtime: { getURL: (path: string) => `chrome-extension://id${path}` },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            arch_wallet_popup_bounds: { width: 720, height: 900 },
          }),
        },
      },
    });

    await openWalletPopup({ path: "/dashboard" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "popup", width: 720, height: 900, focused: true }),
    );
  });
});
