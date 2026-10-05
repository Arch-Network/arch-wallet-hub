import { describe, expect, it } from "vitest";
import { BridgeError, classifyProviderError, isUserRejection } from "../errors";
import { handleBridgeRequest } from "../handle";

describe("classifyProviderError", () => {
  it.each([
    [{ code: 4001, message: "User rejected the request" }],
    [{ code: -32000, message: "" }],
    [new Error("User denied signature")],
    [new Error("Request cancelled")],
  ])("treats %o as a rejection", (err) => {
    expect(classifyProviderError(err, "UniSat").code).toBe("USER_REJECTED");
  });

  it("keeps typed bridge errors as they are", () => {
    const original = new BridgeError("WRONG_NETWORK", "x");
    expect(classifyProviderError(original, "Xverse")).toBe(original);
  });

  it("names the wallet on other failures", () => {
    const e = classifyProviderError(new Error("internal"), "Xverse");
    expect(e.code).toBe("PROVIDER_ERROR");
    expect(e.message).toBe("Xverse: internal");
  });
});

describe("isUserRejection", () => {
  it("is true only for a typed rejection", () => {
    expect(isUserRejection(new BridgeError("USER_REJECTED", "x"))).toBe(true);
    expect(isUserRejection(new BridgeError("TIMEOUT", "x"))).toBe(false);
    expect(isUserRejection(new BridgeError("WINDOW_CLOSED", "x"))).toBe(false);
    expect(isUserRejection(new Error("User rejected"))).toBe(false);
  });
});

describe("handleBridgeRequest", () => {
  it("refuses an unknown provider", async () => {
    const res = await handleBridgeRequest({ provider: "leather", method: "connect", args: { network: "mainnet" } } as any);
    expect(res).toMatchObject({ success: false, code: "UNSUPPORTED" });
  });
});
