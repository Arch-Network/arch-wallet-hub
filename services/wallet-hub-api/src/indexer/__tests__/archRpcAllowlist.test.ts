import { describe, it, expect } from "vitest";
import {
  ALLOWED_ARCH_RPC_METHODS,
  isAllowedArchRpcMethod,
} from "../archRpcAllowlist.js";

describe("isAllowedArchRpcMethod (issue #45)", () => {
  it("allows every documented Hub read method", () => {
    for (const method of ALLOWED_ARCH_RPC_METHODS) {
      expect(isAllowedArchRpcMethod(method)).toBe(true);
    }
  });

  it("rejects mutating / faucet methods", () => {
    expect(isAllowedArchRpcMethod("send_transaction")).toBe(false);
    expect(isAllowedArchRpcMethod("request_airdrop")).toBe(false);
  });

  it("rejects unknown and empty method names", () => {
    expect(isAllowedArchRpcMethod("")).toBe(false);
    expect(isAllowedArchRpcMethod("Read_Account_Info")).toBe(false);
    expect(isAllowedArchRpcMethod("evil_method")).toBe(false);
  });
});
