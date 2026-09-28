import { describe, expect, it } from "vitest";
import { hasValidServiceKey } from "../serviceAuth.js";

describe("hasValidServiceKey", () => {
  it("accepts the dedicated key from either supported header", () => {
    expect(hasValidServiceKey({ "x-service-key": "secret" }, "secret")).toBe(true);
    expect(
      hasValidServiceKey({ authorization: "Bearer secret" }, "secret"),
    ).toBe(true);
  });

  it("fails closed when the key is absent or incorrect", () => {
    expect(hasValidServiceKey({}, undefined)).toBe(false);
    expect(hasValidServiceKey({}, "secret")).toBe(false);
    expect(hasValidServiceKey({ "x-service-key": "wrong" }, "secret")).toBe(false);
  });
});
