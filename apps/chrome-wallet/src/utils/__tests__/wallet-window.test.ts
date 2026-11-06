import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WALLET_WINDOW_ID_KEY,
  __resetWalletWindowForTests,
  findResizableWalletWindowIds,
  forgetWalletWindowId,
  openOrFocusWalletWindow,
  rememberWalletWindowId,
} from "../wallet-window";

type FakeWindow = {
  id: number;
  state?: string;
  type?: string;
  tabs?: Array<{ url?: string; pendingUrl?: string }>;
};

function makeFakeChrome(opts: {
  contexts?: Array<{ documentUrl?: string; windowId?: number }>;
  getContextsImpl?: ((filter: unknown) => Promise<unknown>) | null;
  windows?: FakeWindow[];
  storedId?: number;
  createId?: number;
}) {
  const session: Record<string, unknown> = {};
  if (opts.storedId != null) session[WALLET_WINDOW_ID_KEY] = opts.storedId;
  const local: Record<string, unknown> = {};
  const windowsList = opts.windows ?? [];

  const getContexts =
    opts.getContextsImpl === null
      ? undefined
      : vi.fn(
          opts.getContextsImpl ??
            (async () => opts.contexts ?? []),
        );

  const create = vi.fn(async () => ({ id: opts.createId ?? 42 }));
  const update = vi.fn(async () => ({}));
  const remove = vi.fn(async () => {});
  const get = vi.fn(async (id: number) => {
    const found = windowsList.find((win) => win.id === id);
    if (!found) throw new Error(`No window ${id}`);
    return found;
  });
  const getAll = vi.fn(async () => windowsList);

  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => `chrome-extension://id${path}`,
      getContexts,
    },
    windows: { create, update, remove, get, getAll },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(local, data);
        }),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(session, data);
        }),
        remove: vi.fn(async (key: string) => {
          delete session[key];
        }),
      },
    },
  });

  return { create, update, remove, get, getAll, getContexts, session, local };
}

describe("openOrFocusWalletWindow", () => {
  beforeEach(() => {
    __resetWalletWindowForTests();
  });

  afterEach(() => {
    __resetWalletWindowForTests();
    vi.unstubAllGlobals();
  });

  it("focuses an existing HashRouter window instead of creating another", async () => {
    const api = makeFakeChrome({
      contexts: [
        { documentUrl: "chrome-extension://id/popup.html#/dashboard", windowId: 9 },
      ],
      windows: [{ id: 9, state: "normal", tabs: [{ url: "chrome-extension://id/popup.html#/dashboard" }] }],
    });

    await openOrFocusWalletWindow();

    expect(api.getContexts).toHaveBeenCalledWith({});
    expect(api.update).toHaveBeenCalledWith(9, { focused: true });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("does not pass a popup.html* glob that Brave rejects and Chrome never matches", async () => {
    const api = makeFakeChrome({ contexts: [] });
    await openOrFocusWalletWindow();
    expect(api.getContexts).toHaveBeenCalledTimes(1);
    expect(api.getContexts).toHaveBeenCalledWith({});
    const filter = vi.mocked(api.getContexts!).mock.calls[0]?.[0] as { documentUrls?: string[] };
    expect(filter?.documentUrls).toBeUndefined();
  });

  it("falls back to windows.getAll when getContexts throws (Brave)", async () => {
    const api = makeFakeChrome({
      getContextsImpl: async () => {
        throw new Error("Invalid URL pattern");
      },
      windows: [
        {
          id: 11,
          type: "normal",
          tabs: [{ url: "chrome-extension://id/popup.html#/dashboard" }],
        },
      ],
    });

    await openOrFocusWalletWindow();

    expect(api.getAll).toHaveBeenCalled();
    expect(api.update).toHaveBeenCalledWith(11, { focused: true });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("falls back to the last remembered window when lookup APIs are empty", async () => {
    const api = makeFakeChrome({
      contexts: [],
      windows: [{ id: 15, state: "normal" }],
      storedId: 15,
    });

    await openOrFocusWalletWindow();

    expect(api.update).toHaveBeenCalledWith(15, { focused: true });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("opens one window and remembers it when none exist", async () => {
    const api = makeFakeChrome({ contexts: [], windows: [], createId: 42 });

    await openOrFocusWalletWindow();

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "chrome-extension://id/popup.html",
        type: "popup",
        focused: true,
      }),
    );
    expect(api.session[WALLET_WINDOW_ID_KEY]).toBe(42);
  });

  it("shares one in-flight create across overlapping toolbar clicks", async () => {
    const api = makeFakeChrome({ contexts: [], windows: [], createId: 7 });
    api.create.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { id: 7 };
    });

    await Promise.all([
      openOrFocusWalletWindow(),
      openOrFocusWalletWindow(),
      openOrFocusWalletWindow(),
    ]);

    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("closes stacked copies and keeps the remembered window", async () => {
    const api = makeFakeChrome({
      storedId: 9,
      contexts: [
        { documentUrl: "chrome-extension://id/popup.html#/dashboard", windowId: 4 },
        { documentUrl: "chrome-extension://id/popup.html#/tokens", windowId: 9 },
      ],
      windows: [
        { id: 4, tabs: [{ url: "chrome-extension://id/popup.html#/dashboard" }] },
        { id: 9, tabs: [{ url: "chrome-extension://id/popup.html#/tokens" }] },
      ],
    });

    await openOrFocusWalletWindow();

    expect(api.remove).toHaveBeenCalledWith(4);
    expect(api.remove).not.toHaveBeenCalledWith(9);
    expect(api.update).toHaveBeenCalledWith(9, { focused: true });
    expect(api.create).not.toHaveBeenCalled();
  });

  it("leaves an approve prompt alone when choosing which window to focus", async () => {
    const api = makeFakeChrome({
      contexts: [
        { documentUrl: "chrome-extension://id/popup.html#/approve/abc", windowId: 2 },
        { documentUrl: "chrome-extension://id/popup.html#/dashboard", windowId: 8 },
      ],
      windows: [
        { id: 2, tabs: [{ url: "chrome-extension://id/popup.html#/approve/abc" }] },
        { id: 8, tabs: [{ url: "chrome-extension://id/popup.html#/dashboard" }] },
      ],
    });

    await openOrFocusWalletWindow();

    expect(api.update).toHaveBeenCalledWith(8, { focused: true });
    expect(api.remove).not.toHaveBeenCalledWith(2);
    expect(api.create).not.toHaveBeenCalled();
  });

  it("restores a minimized wallet window", async () => {
    const api = makeFakeChrome({
      contexts: [
        { documentUrl: "chrome-extension://id/popup.html#/dashboard", windowId: 3 },
      ],
      windows: [{ id: 3, state: "minimized", tabs: [{ url: "chrome-extension://id/popup.html#/dashboard" }] }],
    });

    await openOrFocusWalletWindow();

    expect(api.update).toHaveBeenCalledWith(3, { focused: true, state: "normal" });
  });

  it("creates a new window if the remembered id is already gone", async () => {
    const api = makeFakeChrome({
      contexts: [],
      windows: [],
      storedId: 99,
      createId: 5,
    });

    await openOrFocusWalletWindow();

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.session[WALLET_WINDOW_ID_KEY]).toBe(5);
  });
});

describe("rememberWalletWindowId", () => {
  afterEach(() => {
    __resetWalletWindowForTests();
    vi.unstubAllGlobals();
  });

  it("does not clear a live wallet window when some other window closes", async () => {
    makeFakeChrome({ windows: [{ id: 9 }] });
    await rememberWalletWindowId(9);
    await forgetWalletWindowId(3);
    expect(await findResizableWalletWindowIds()).toContain(9);
  });
});
