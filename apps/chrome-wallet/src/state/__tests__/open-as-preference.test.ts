import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { walletStore } from "../wallet-store";
import { keystore } from "../../crypto/keystore";
import { DEFAULT_STATE } from "../types";
import { OPEN_AS_KEY } from "../open-as-preference";

describe("toolbar preference persistence", () => {
  let local: Record<string, unknown>;
  beforeEach(() => {
    local = {};
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: local[key] })),
      set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(local, data); }),
    } } });
    vi.spyOn(keystore, "isSealed").mockResolvedValue(true);
    vi.spyOn(keystore, "isUnlocked").mockResolvedValue(false);
    vi.spyOn(keystore, "read").mockResolvedValue({ ...DEFAULT_STATE, openAs: "sidepanel" });
    vi.spyOn(keystore, "write").mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("preserves sidebar selection while locked without reading wallet contents", async () => {
    await walletStore.setOpenAs("sidepanel");
    expect((await walletStore.getState()).openAs).toBe("sidepanel");
    expect(keystore.read).not.toHaveBeenCalled();
    expect(keystore.write).not.toHaveBeenCalled();
    // Repeated locked/background reads do not reset the persisted value.
    expect((await walletStore.getState()).openAs).toBe("sidepanel");
    expect(local[OPEN_AS_KEY]).toBe("sidepanel");
  });

  it("does not migrate a locked shell's default", async () => {
    expect((await walletStore.getState()).openAs).toBe("popup");
    expect(local[OPEN_AS_KEY]).toBeUndefined();
  });

  it("migrates an existing encrypted preference on unlock", async () => {
    vi.mocked(keystore.isUnlocked).mockResolvedValue(true);
    expect((await walletStore.getState()).openAs).toBe("sidepanel");
    expect(local[OPEN_AS_KEY]).toBe("sidepanel");
    vi.mocked(keystore.isUnlocked).mockResolvedValue(false);
    expect((await walletStore.getState()).openAs).toBe("sidepanel");
  });

  it("honors a new popup preference over the old encrypted sidebar value", async () => {
    await walletStore.setOpenAs("popup");
    vi.mocked(keystore.isUnlocked).mockResolvedValue(true);
    expect((await walletStore.getState()).openAs).toBe("popup");
    expect(local[OPEN_AS_KEY]).toBe("popup");
  });
});
