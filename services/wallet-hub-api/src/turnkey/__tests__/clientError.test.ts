import { describe, expect, it } from "vitest";
import { isTurnkeyInvalidRequest } from "../clientError.js";

describe("isTurnkeyInvalidRequest", () => {
  it("matches Turnkey's invalid-request code", () => {
    expect(isTurnkeyInvalidRequest({ code: 3, message: "Turnkey error 3: invalid request" })).toBe(true);
    expect(isTurnkeyInvalidRequest({ code: "3" })).toBe(true);
  });

  it("leaves other Turnkey failures as server errors", () => {
    expect(isTurnkeyInvalidRequest({ code: 14, message: "unavailable" })).toBe(false);
    expect(isTurnkeyInvalidRequest(new Error("Turnkey error 3: invalid request"))).toBe(false);
    expect(isTurnkeyInvalidRequest(null)).toBe(false);
  });
});
