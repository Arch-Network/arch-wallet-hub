import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isInStandalonePopupWindow,
  openWalletPopup,
  reopenForExternalSigning,
} from "../runtime-context";
import { WALLET_WINDOW_ID_KEY, __resetWalletWindowForTests } from "../wallet-window";

function stubChrome(currentTab: unknown) {
  const create = vi.fn().mockResolvedValue({});
  vi.stubGlobal("chrome", {
    tabs: { getCurrent: vi.fn().mockResolvedValue(currentTab) },
    windows: { create },
    runtime: { getURL: (path: string) => `chrome-extension://id${path}` },
  });
  return create;
}

afterEach(() => {
  __resetWalletWindowForTests();
  vi.unstubAllGlobals();
});

describe("isInStandalonePopupWindow", () => {
  it("treats a Brave popup reported as type=normal as already rehosted", async () => {
    vi.stubGlobal("chrome", {
      windows: { getCurrent: vi.fn().mockResolvedValue({ type: "normal", id: 4 }) },
      tabs: { getCurrent: vi.fn().mockResolvedValue({ id: 7 }) },
    });
    await expect(isInStandalonePopupWindow()).resolves.toBe(true);
  });

  it("still rehosts from the toolbar bubble, which has no tab", async () => {
    vi.stubGlobal("chrome", {
      windows: { getCurrent: vi.fn().mockResolvedValue({ type: "normal", id: 1 }) },
      tabs: { getCurrent: vi.fn().mockResolvedValue(undefined) },
    });
    await expect(isInStandalonePopupWindow()).resolves.toBe(false);
  });
});

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

  it("remembers a non-approve window so the toolbar icon can focus it later", async () => {
    const create = vi.fn().mockResolvedValue({ id: 21 });
    const session: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      windows: { create },
      runtime: { getURL: (path: string) => `chrome-extension://id${path}` },
      storage: {
        local: { get: vi.fn().mockResolvedValue({}) },
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session[key] })),
          set: vi.fn(async (data: Record<string, unknown>) => {
            Object.assign(session, data);
          }),
        },
      },
    });

    await openWalletPopup({ path: "/swap" });

    expect(session[WALLET_WINDOW_ID_KEY]).toBe(21);
  });
});
