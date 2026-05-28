import { describe, it, expect } from "vitest";
import { interpretMessage, parseSiwaMessage } from "../sign-message";

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

describe("parseSiwaMessage", () => {
  const fullMessage = [
    "example.com wants you to sign in with your Arch account:",
    "bc1ptest000000000000000000000000000000000000000000",
    "",
    "Welcome to Example. Sign in to access your account.",
    "",
    "URI: https://example.com/login",
    "Version: 1",
    "Chain ID: bitcoin",
    "Nonce: 32891756",
    "Issued At: 2026-05-28T12:00:00Z",
    "Expiration Time: 2026-05-28T12:05:00Z",
    "Request ID: req-42",
    "Resources:",
    "- https://example.com/scopes/read",
    "- https://example.com/scopes/write",
  ].join("\n");

  it("parses a fully-populated SIWA message", () => {
    const s = parseSiwaMessage(fullMessage);
    expect(s).not.toBeNull();
    expect(s!.domain).toBe("example.com");
    expect(s!.address).toBe("bc1ptest000000000000000000000000000000000000000000");
    expect(s!.statement).toBe("Welcome to Example. Sign in to access your account.");
    expect(s!.uri).toBe("https://example.com/login");
    expect(s!.version).toBe("1");
    expect(s!.chainId).toBe("bitcoin");
    expect(s!.nonce).toBe("32891756");
    expect(s!.issuedAt).toBe("2026-05-28T12:00:00Z");
    expect(s!.expirationTime).toBe("2026-05-28T12:05:00Z");
    expect(s!.requestId).toBe("req-42");
    expect(s!.resources).toEqual([
      "https://example.com/scopes/read",
      "https://example.com/scopes/write",
    ]);
  });

  it("parses a minimal SIWA message (no statement, no optional fields)", () => {
    const minimal = [
      "example.com wants you to sign in with your Arch account:",
      "bc1ptest",
      "",
      "URI: https://example.com",
      "Version: 1",
      "Chain ID: bitcoin",
      "Nonce: 1",
      "Issued At: 2026-05-28T12:00:00Z",
    ].join("\n");
    const s = parseSiwaMessage(minimal);
    expect(s).not.toBeNull();
    expect(s!.statement).toBeUndefined();
    expect(s!.expirationTime).toBeUndefined();
    expect(s!.resources).toBeUndefined();
  });

  it("returns null when the header is wrong (e.g. Ethereum SIWE)", () => {
    const eth = [
      "example.com wants you to sign in with your Ethereum account:",
      "0xabc",
      "",
      "URI: https://example.com",
      "Version: 1",
      "Chain ID: 1",
      "Nonce: 1",
      "Issued At: 2026-05-28T12:00:00Z",
    ].join("\n");
    expect(parseSiwaMessage(eth)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    // Missing Nonce
    const broken = [
      "example.com wants you to sign in with your Arch account:",
      "bc1p",
      "",
      "URI: https://example.com",
      "Version: 1",
      "Chain ID: bitcoin",
      "Issued At: 2026-05-28T12:00:00Z",
    ].join("\n");
    expect(parseSiwaMessage(broken)).toBeNull();
  });

  it("returns null on plain text that just mentions 'sign in'", () => {
    expect(parseSiwaMessage("Please sign in with your wallet.")).toBeNull();
  });
});

describe("interpretMessage > SIWA", () => {
  function toHex(s: string): string {
    return Array.from(new TextEncoder().encode(s))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  const siwaText = [
    "example.com wants you to sign in with your Arch account:",
    "bc1ptest",
    "",
    "URI: https://example.com",
    "Version: 1",
    "Chain ID: bitcoin",
    "Nonce: abc",
    "Issued At: 2026-05-28T12:00:00Z",
  ].join("\n");

  it("returns kind=siwa for a valid SIWA message", () => {
    const r = interpretMessage(toHex(siwaText), "https://example.com");
    expect(r.kind).toBe("siwa");
    if (r.kind === "siwa") {
      expect(r.siwa.domain).toBe("example.com");
      expect(r.domainMismatch).toBeUndefined();
    }
  });

  it("flags domain mismatch when origin host differs from SIWA domain", () => {
    const r = interpretMessage(toHex(siwaText), "https://attacker.example");
    expect(r.kind).toBe("siwa");
    if (r.kind === "siwa") {
      expect(r.domainMismatch).toBeDefined();
      expect(r.domainMismatch!.expected).toBe("attacker.example");
      expect(r.domainMismatch!.got).toBe("example.com");
    }
  });

  it("flags an expired SIWA message as timingIssue=expired", () => {
    const expiredText = siwaText + "\nExpiration Time: 2000-01-01T00:00:00Z";
    const r = interpretMessage(toHex(expiredText), "https://example.com");
    expect(r.kind).toBe("siwa");
    if (r.kind === "siwa") {
      expect(r.timingIssue?.reason).toBe("expired");
    }
  });
});

