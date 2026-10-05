import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBridgeRequest } from "../handle";
import type { UnisatProvider } from "../unisat";

const TAPROOT = "tb1pjvtc0d2ha0m0dzy2q5w2xg3d3k7dw8x6fq0jth4k4x9ce3c2yv0szxzr9a";
const OTHER_TAPROOT = "tb1paecnsq8k5qz6c3dfcvz0cg0nd8hcl5nmpg2h7ln8wz4pmg0x9rssmd9al";
const SEGWIT = "tb1qrn7tvhdf6wnh790384ahj56u0xaa0kqgautnnz";
const PSBT_BASE64 = "cHNidP8="; // "psbt" magic + 0xff
const PSBT_HEX = "70736274ff";

function unisat(overrides: Partial<UnisatProvider> = {}): UnisatProvider {
  return {
    requestAccounts: vi.fn(async () => [TAPROOT]),
    getAccounts: vi.fn(async () => [TAPROOT]),
    getPublicKey: vi.fn(async () => "02ab"),
    getChain: vi.fn(async () => ({ enum: "BITCOIN_TESTNET4", name: "Bitcoin Testnet4" })),
    signMessage: vi.fn(async () => "sig"),
    signPsbt: vi.fn(async () => "signedhex"),
    ...overrides,
  };
}

function install(p: UnisatProvider | undefined) {
  (globalThis as any).window = { unisat: p };
}

const connect = (network: "testnet4" | "mainnet" = "testnet4") =>
  handleBridgeRequest({ provider: "unisat", method: "connect", args: { network } });

beforeEach(() => install(undefined));
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).window;
});

describe("UniSat connect", () => {
  it("returns its one Taproot address for both purposes after confirming the exact chain", async () => {
    install(unisat());
    expect(await connect()).toEqual({
      success: true,
      data: {
        provider: "unisat",
        address: TAPROOT,
        publicKeyHex: "02ab",
        addresses: [{ address: TAPROOT, publicKeyHex: "02ab", purposes: ["payment", "ordinals"], addressType: "p2tr" }],
        chainVerified: true,
      },
    });
  });

  it("reports a missing provider after waiting for late injection", async () => {
    vi.useFakeTimers();
    const pending = connect();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ success: false, code: "PROVIDER_MISSING" });
  });

  it("refuses the wrong chain before asking for accounts", async () => {
    const p = unisat({ getChain: vi.fn(async () => ({ enum: "BITCOIN_MAINNET", name: "Bitcoin Mainnet" })) });
    install(p);
    const res = await connect();
    expect(res).toMatchObject({ success: false, code: "WRONG_NETWORK" });
    expect(!res.success && res.error).toMatch(/UniSat is on Bitcoin Mainnet/);
    expect(p.requestAccounts).not.toHaveBeenCalled();
  });

  it("asks for Taproot when the active address is another type", async () => {
    install(unisat({ requestAccounts: vi.fn(async () => [SEGWIT]) }));
    expect(await connect()).toMatchObject({ success: false, code: "UNSUPPORTED_ADDRESS" });
  });

  it("can't confirm Testnet4 on a UniSat without getChain", async () => {
    install(unisat({ getChain: undefined, getNetwork: vi.fn(async () => "testnet") }));
    expect(await connect()).toMatchObject({ success: false, code: "UNSUPPORTED" });
  });

  it("accepts the legacy livenet report for Mainnet", async () => {
    install(unisat({ getChain: undefined, getNetwork: vi.fn(async () => "livenet") }));
    expect(await connect("mainnet")).toMatchObject({ success: true });
  });

  it("maps a 4001 rejection to USER_REJECTED", async () => {
    install(unisat({ requestAccounts: vi.fn(async () => Promise.reject({ code: 4001, message: "User rejected" })) }));
    expect(await connect()).toMatchObject({ success: false, code: "USER_REJECTED" });
  });
});

describe("UniSat signing", () => {
  it("refuses to sign when UniSat switched to another account", async () => {
    const p = unisat({ getAccounts: vi.fn(async () => [OTHER_TAPROOT]) });
    install(p);
    const res = await handleBridgeRequest({
      provider: "unisat",
      method: "signMessage",
      args: { address: TAPROOT, message: "hi", network: "testnet4" },
    });
    expect(res).toMatchObject({ success: false, code: "ACCOUNT_MISMATCH" });
    expect(p.signMessage).not.toHaveBeenCalled();
  });

  it("refuses to sign on the wrong chain", async () => {
    const p = unisat({ getChain: vi.fn(async () => ({ enum: "BITCOIN_SIGNET" })) });
    install(p);
    const res = await handleBridgeRequest({
      provider: "unisat",
      method: "signPsbt",
      args: { address: TAPROOT, psbtBase64: PSBT_BASE64, network: "testnet4" },
    });
    expect(res).toMatchObject({ success: false, code: "WRONG_NETWORK" });
    expect(p.signPsbt).not.toHaveBeenCalled();
  });

  it("lets a locked UniSat prompt for the account, then signs BIP-322", async () => {
    const p = unisat({ getAccounts: vi.fn(async () => []) });
    install(p);
    const res = await handleBridgeRequest({
      provider: "unisat",
      method: "signMessage",
      args: { address: TAPROOT, message: "hi", network: "testnet4" },
    });
    expect(p.requestAccounts).toHaveBeenCalled();
    expect(p.signMessage).toHaveBeenCalledWith("hi", "bip322-simple");
    expect(res).toEqual({ success: true, data: { signature: "sig", schemeHint: "bip322" } });
  });

  it("signs only the named inputs for the account address and never finalizes", async () => {
    const p = unisat();
    install(p);
    const res = await handleBridgeRequest({
      provider: "unisat",
      method: "signBtcPsbt",
      args: { address: TAPROOT, psbtBase64: PSBT_BASE64, network: "testnet4", inputIndexes: [0, 2] },
    });
    expect(p.signPsbt).toHaveBeenCalledWith(PSBT_HEX, {
      autoFinalized: false,
      toSignInputs: [
        { index: 0, address: TAPROOT },
        { index: 2, address: TAPROOT },
      ],
    });
    expect(res).toEqual({ success: true, data: { signedPsbtHex: "signedhex" } });
  });
});
