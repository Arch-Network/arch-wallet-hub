import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_THIS_WINDOW_MESSAGE,
  __resetWalletAutoCloseForTests,
  autoCloseBlocked,
  closeThisExtensionWindow,
  holdWalletWindow,
  releaseWalletWindowHold,
  suppressWalletAutoClose,
  walletAutoCloseAction,
  walletDismissAllowed,
  withWalletWindowHeld,
} from "../wallet-autoclose";

function stubSession() {
  const session: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string | string[]) => {
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) out[k] = session[k];
            return out;
          }
          return { [key]: session[key] };
        }),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(session, data);
        }),
        remove: vi.fn(async (key: string) => {
          delete session[key];
        }),
      },
    },
    runtime: { sendMessage: vi.fn() },
    windows: { getCurrent: vi.fn(), remove: vi.fn() },
  });
  return session;
}

afterEach(() => {
  __resetWalletAutoCloseForTests();
  vi.unstubAllGlobals();
});

describe("walletAutoCloseAction", () => {
  it("closes an unfocused wallet window", () => {
    expect(walletAutoCloseAction({ hasFocus: false, hash: "#/dashboard", blocked: false })).toBe("close");
    expect(walletAutoCloseAction({ hasFocus: false, hash: "", blocked: false })).toBe("close");
  });

  it("leaves a focused window and an approve prompt alone", () => {
    expect(walletAutoCloseAction({ hasFocus: true, hash: "#/send", blocked: false })).toBe("stay");
    expect(walletAutoCloseAction({ hasFocus: false, hash: "#/approve/abc", blocked: false })).toBe("stay");
  });

  it("waits out a passkey prompt or a toolbar click instead of closing", () => {
    expect(walletAutoCloseAction({ hasFocus: false, hash: "#/dashboard", blocked: true })).toBe("wait");
  });

  it("stays open on recovery so a password manager can take focus", () => {
    expect(walletAutoCloseAction({ hasFocus: false, hash: "#/recover", blocked: false })).toBe("stay");
    expect(
      walletAutoCloseAction({ hasFocus: false, hash: "#/recover?externalUserId=abc", blocked: false }),
    ).toBe("stay");
  });
});

describe("auto-close holds", () => {
  it("suppresses dismiss across the toolbar click that refocuses the window", async () => {
    stubSession();
    await suppressWalletAutoClose(1_000);
    expect(await autoCloseBlocked()).toBe(true);
    expect(await walletDismissAllowed()).toBe(false);
    expect(await autoCloseBlocked(Date.now() + 5_000)).toBe(false);
  });

  it("blocks dismiss before the storage write from a toolbar click finishes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (key: string | string[]) => {
            if (Array.isArray(key)) {
              const out: Record<string, unknown> = {};
              for (const k of key) out[k] = session[k];
              return out;
            }
            return { [key]: session[key] };
          }),
          set: vi.fn(async (data: Record<string, unknown>) => {
            await gate;
            Object.assign(session, data);
          }),
          remove: vi.fn(async (key: string) => {
            delete session[key];
          }),
        },
      },
    });

    const pending = suppressWalletAutoClose(5_000);
    expect(await walletDismissAllowed()).toBe(false);
    release();
    await pending;
  });

  it("holds through a ceremony and expires if the page never releases it", async () => {
    stubSession();
    await holdWalletWindow(1_000);
    expect(await autoCloseBlocked()).toBe(true);
    expect(await autoCloseBlocked(Date.now() + 5_000)).toBe(false);
  });

  it("keeps one hold when two overlap, then grants a short grace on the last release", async () => {
    stubSession();
    await holdWalletWindow(60_000);
    await holdWalletWindow(60_000);
    await releaseWalletWindowHold();
    expect(await autoCloseBlocked(Date.now() + 10_000)).toBe(true);
    await releaseWalletWindowHold();
    expect(await autoCloseBlocked()).toBe(true);
    expect(await autoCloseBlocked(Date.now() + 10_000)).toBe(false);
  });

  it("releases the hold when the ceremony throws", async () => {
    stubSession();
    await expect(
      withWalletWindowHeld(async () => {
        throw new Error("user dismissed the passkey prompt");
      }),
    ).rejects.toThrow("user dismissed the passkey prompt");
    expect(await autoCloseBlocked(Date.now() + 10_000)).toBe(false);
  });
});

describe("closeThisExtensionWindow", () => {
  it("asks the service worker to remove the window, which works on Brave", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const remove = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      windows: { getCurrent: vi.fn(), remove },
    });

    await expect(closeThisExtensionWindow()).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ type: CLOSE_THIS_WINDOW_MESSAGE });
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the current window itself when the service worker cannot", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: false }) },
      windows: {
        getCurrent: vi.fn().mockResolvedValue({ id: 12 }),
        remove,
      },
    });

    await expect(closeThisExtensionWindow()).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith(12);
  });

  it("falls back to window.close when the windows API is missing", async () => {
    const close = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn().mockRejectedValue(new Error("no receiver")) },
    });
    vi.stubGlobal("window", { close });

    await expect(closeThisExtensionWindow()).resolves.toBe(true);
    expect(close).toHaveBeenCalled();
  });
});
