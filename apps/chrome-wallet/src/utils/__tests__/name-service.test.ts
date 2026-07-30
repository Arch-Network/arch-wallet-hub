import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ansManagerUrl,
  isAnsEnabledForNetwork,
  isArchAddress,
  isArchName,
  openAnsManager,
  resolveName,
  resolvePrimaryName,
} from "../name-service";

const owner = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ownerAddress = bs58.encode(owner);

describe("name service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recognizes ANS names and 32-byte base58 Arch addresses", () => {
    expect(isArchName("Alice.arch")).toBe(true);
    expect(isArchName("alice.eth")).toBe(false);
    expect(isArchAddress(ownerAddress)).toBe(true);
    expect(isArchAddress("not-an-address")).toBe(false);
  });

  it("enables ANS on testnet only until a mainnet manifest exists", () => {
    expect(isAnsEnabledForNetwork("testnet4")).toBe(true);
    expect(isAnsEnabledForNetwork("mainnet")).toBe(false);
  });

  it("builds ANS manager deep links", () => {
    expect(ansManagerUrl("explore")).toBe("https://id.arch.network/#/explore");
    expect(ansManagerUrl("manage")).toBe("https://id.arch.network/#/manage");
    expect(ansManagerUrl("names")).toBe("https://id.arch.network/#/names");
    expect(ansManagerUrl("register")).toBe("https://id.arch.network/#/register");
    expect(ansManagerUrl({ view: "Matt.arch" })).toBe(
      "https://id.arch.network/#/view?name=matt.arch",
    );
  });

  it("opens ANS manager via chrome.tabs when available", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { tabs: { create } });
    const open = vi.fn();
    vi.stubGlobal("open", open);

    await openAnsManager("explore");
    expect(create).toHaveBeenCalledWith({ url: "https://id.arch.network/#/explore" });
    expect(open).not.toHaveBeenCalled();
  });

  it("preserves literal Bitcoin and Arch addresses", async () => {
    const btc = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    await expect(resolveName(btc, { network: "testnet4" })).resolves.toEqual({
      address: btc,
      source: "literal",
    });
    await expect(resolveName(ownerAddress, { network: "testnet4" })).resolves.toEqual({
      address: ownerAddress,
      source: "literal",
    });
  });

  it("resolves a testnet .arch name through the SDK client", async () => {
    const client = {
      resolveOwner: vi.fn().mockResolvedValue(owner),
      resolvePrimary: vi.fn(),
    };

    await expect(
      resolveName("Alice.arch", { network: "testnet4", client }),
    ).resolves.toEqual({
      address: ownerAddress,
      source: "arch-name",
      name: "alice.arch",
    });
    expect(client.resolveOwner).toHaveBeenCalledWith("Alice.arch");
  });

  it("rejects invalid names and keeps ANS disabled on mainnet", async () => {
    const client = {
      resolveOwner: vi.fn().mockResolvedValue(owner),
      resolvePrimary: vi.fn(),
    };

    await expect(
      resolveName("alice.eth", { network: "testnet4", client }),
    ).resolves.toBeNull();
    await expect(
      resolveName("alice.arch", { network: "mainnet", client }),
    ).resolves.toBeNull();
    expect(client.resolveOwner).not.toHaveBeenCalled();
  });

  it("resolves a primary name only on testnet", async () => {
    const client = {
      resolveOwner: vi.fn(),
      resolvePrimary: vi.fn().mockResolvedValue("alice.arch"),
    };

    await expect(
      resolvePrimaryName(ownerAddress, { network: "testnet4", client }),
    ).resolves.toBe("alice.arch");
    expect(client.resolvePrimary).toHaveBeenCalledWith(owner);

    await expect(
      resolvePrimaryName(ownerAddress, { network: "mainnet", client }),
    ).resolves.toBeNull();
  });
});
