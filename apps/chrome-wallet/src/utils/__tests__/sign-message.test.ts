import { describe, it, expect } from "vitest";
import { interpretMessage } from "../sign-message";

describe("interpretMessage", () => {
  function hex(s: string): string {
    return Array.from(new TextEncoder().encode(s))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  it("returns text for printable utf-8", () => {
    const result = interpretMessage(hex("Hello, world"), "https://example.com");
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toBe("Hello, world");
  });

  it("returns json when payload parses", () => {
    const result = interpretMessage(hex('{"foo":1}'), "https://example.com");
    expect(result.kind).toBe("json");
  });

  it("flags domain mismatches for structured payloads", () => {
    const siwe = hex(
      "example.com wants you to sign in with your Bitcoin account\nURI: https://attacker.example\nVersion: 1",
    );
    const result = interpretMessage(siwe, "https://example.com");
    expect(result.kind).toBe("structured");
    if (result.kind === "structured") {
      expect(result.domainMismatch).toBeDefined();
      expect(result.domainMismatch?.expected).toBe("example.com");
      expect(result.domainMismatch?.got).toBe("attacker.example");
    }
  });

  it("returns binary for non-printable bytes", () => {
    const result = interpretMessage("deadbeef00", "https://example.com");
    expect(result.kind).toBe("binary");
  });

  it("returns binary for invalid hex", () => {
    const result = interpretMessage("not-hex", "https://example.com");
    expect(result.kind).toBe("binary");
  });
});
