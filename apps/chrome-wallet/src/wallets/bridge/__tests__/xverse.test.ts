import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const satsConnect = vi.hoisted(() => ({
  getAddress: vi.fn(),
  request: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("sats-connect", () => ({
  AddressPurpose: { Ordinals: "ordinals", Payment: "payment", Stacks: "stacks" },
  BitcoinNetworkType: { Mainnet: "Mainnet", Testnet: "Testnet", Testnet4: "Testnet4", Signet: "Signet", Regtest: "Regtest" },
  MessageSigningProtocols: { ECDSA: "ECDSA", BIP322: "BIP322" },
  ...satsConnect,
}));

import { handleBridgeRequest } from "../handle";
import { toBridgeAddress } from "../xverse";

const PAYMENT = "2N2uFi5LbDQQwTqAVd5veF6qE9hWww2DVzF";
const ORDINALS = "tb1pgxxy0q0ld6jw0yjt3lz4ksdhr4nrtw3l2z4r2mw2v3f8dl33ugqq387jl";
const MAINNET_ORDINALS = "bc1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnns4f6ks5";

const addressResponse = (ordinals = ORDINALS) => ({
  addresses: [
    { address: PAYMENT, publicKey: "02cd", purpose: "payment", addressType: "p2sh" },
    { address: ordinals, publicKey: "ab", purpose: "ordinals", addressType: "p2tr" },
    { address: "SP000", publicKey: "", purpose: "stacks", addressType: "stacks" },
  ],
});

/** Mimic the legacy callback API: resolve via onFinish, or onCancel to decline. */
function answers(fn: ReturnType<typeof vi.fn>, response: unknown | "cancel") {
  fn.mockImplementation(async (opts: any) => {
    if (response === "cancel") opts.onCancel();
    else opts.onFinish(response);
  });
}

function reportsNetwork(name: string | null) {
  satsConnect.request.mockImplementation(async () =>
    name === null ? Promise.reject(new Error("no permission")) : { status: "success", result: { bitcoin: { name } } },
  );
}

const connect = (network: "testnet4" | "mainnet" = "testnet4") =>
  handleBridgeRequest({ provider: "xverse", method: "connect", args: { network } });

beforeEach(() => {
  (globalThis as any).window = { XverseProviders: { BitcoinProvider: {} } };
  for (const fn of Object.values(satsConnect)) fn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

describe("Xverse connect", () => {
  it("returns payment and ordinals separately and uses the ordinals Taproot address as the identity", async () => {
    answers(satsConnect.getAddress, addressResponse());
    reportsNetwork("Testnet4");
    expect(await connect()).toEqual({
      success: true,
      data: {
        provider: "xverse",
        address: ORDINALS,
        publicKeyHex: "ab",
        addresses: [
          { address: PAYMENT, publicKeyHex: "02cd", purposes: ["payment"], addressType: "p2sh" },
          { address: ORDINALS, publicKeyHex: "ab", purposes: ["ordinals"], addressType: "p2tr" },
        ],
        chainVerified: true,
      },
    });
    expect(satsConnect.getAddress.mock.calls[0][0].payload.network).toEqual({ type: "Testnet4" });
  });

  it("marks the chain unverified when Xverse can't report its network", async () => {
    answers(satsConnect.getAddress, addressResponse());
    reportsNetwork(null);
    expect(await connect()).toMatchObject({ success: true, data: { chainVerified: false } });
  });

  it("stops waiting on a network read that never resolves", async () => {
    vi.useFakeTimers();
    answers(satsConnect.getAddress, addressResponse());
    satsConnect.request.mockImplementation(() => new Promise(() => {}));
    const pending = connect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ success: true, data: { chainVerified: false } });
  });

  it("refuses when Xverse reports a different network", async () => {
    answers(satsConnect.getAddress, addressResponse());
    reportsNetwork("Mainnet");
    const res = await connect();
    expect(res).toMatchObject({ success: false, code: "WRONG_NETWORK" });
    expect(!res.success && res.error).toMatch(/Switch Xverse to Bitcoin Testnet4/);
  });

  it("refuses addresses encoded for the other network even when the network read fails", async () => {
    answers(satsConnect.getAddress, {
      addresses: [{ address: MAINNET_ORDINALS, publicKey: "ab", purpose: "ordinals", addressType: "p2tr" }],
    });
    reportsNetwork(null);
    expect(await connect()).toMatchObject({ success: false, code: "WRONG_NETWORK" });
  });

  it("maps a declined connection to USER_REJECTED", async () => {
    answers(satsConnect.getAddress, "cancel");
    expect(await connect()).toMatchObject({ success: false, code: "USER_REJECTED" });
  });

  it("reports a missing provider without calling sats-connect", async () => {
    vi.useFakeTimers();
    (globalThis as any).window = {};
    const pending = connect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ success: false, code: "PROVIDER_MISSING" });
    expect(satsConnect.getAddress).not.toHaveBeenCalled();
  });
});

describe("Xverse signing", () => {
  it("signs a BTC send for the exact address and inputs without broadcasting", async () => {
    reportsNetwork("Testnet4");
    answers(satsConnect.signTransaction, { psbtBase64: "signed" });
    const res = await handleBridgeRequest({
      provider: "xverse",
      method: "signBtcPsbt",
      args: { address: ORDINALS, psbtBase64: "cHNidP8=", network: "testnet4", inputIndexes: [0, 1] },
    });
    const payload = satsConnect.signTransaction.mock.calls[0][0].payload;
    expect(payload).toMatchObject({
      psbtBase64: "cHNidP8=",
      inputsToSign: [{ address: ORDINALS, signingIndexes: [0, 1] }],
      broadcast: false,
      network: { type: "Testnet4" },
    });
    expect(res).toEqual({ success: true, data: { signedPsbtBase64: "signed" } });
  });

  it("refuses to sign when Xverse moved to another network", async () => {
    reportsNetwork("Mainnet");
    const res = await handleBridgeRequest({
      provider: "xverse",
      method: "signMessage",
      args: { address: ORDINALS, message: "hi", network: "testnet4" },
    });
    expect(res).toMatchObject({ success: false, code: "WRONG_NETWORK" });
    expect(satsConnect.signMessage).not.toHaveBeenCalled();
  });

  it("signs messages with BIP-322", async () => {
    reportsNetwork("Testnet4");
    answers(satsConnect.signMessage, "sig");
    const res = await handleBridgeRequest({
      provider: "xverse",
      method: "signMessage",
      args: { address: ORDINALS, message: "hi", network: "testnet4" },
    });
    expect(satsConnect.signMessage.mock.calls[0][0].payload).toMatchObject({ address: ORDINALS, protocol: "BIP322" });
    expect(res).toEqual({ success: true, data: { signature: "sig", schemeHint: "bip322" } });
  });
});

describe("toBridgeAddress", () => {
  it("drops non-Bitcoin purposes", () => {
    expect(toBridgeAddress({ address: "SP000", publicKey: "", purpose: "stacks", addressType: "stacks" } as any)).toBeNull();
  });

  it("infers the script type from the encoding when Xverse doesn't report a known one", () => {
    expect(toBridgeAddress({ address: PAYMENT, publicKey: "02", purpose: "payment", addressType: "" } as any)).toMatchObject({
      addressType: "p2sh",
    });
  });
});
