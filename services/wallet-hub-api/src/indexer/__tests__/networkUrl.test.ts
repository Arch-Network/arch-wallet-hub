/**
 * Path resolution for the upstream Arch indexer.
 *
 * Critical safety invariant: regardless of what shape INDEXER_BASE_URL
 * takes in deployment config, the resolved URL MUST end in
 * `/{network}` with no trailing slash. A regression here silently
 * misroutes mainnet wallet traffic to testnet.
 */
import { describe, it, expect } from "vitest";
import { resolveNetworkBaseUrl } from "../networkUrl.js";

describe("resolveNetworkBaseUrl — base URL has no network segment", () => {
  it("appends /mainnet to a /api/v1 base", () => {
    expect(resolveNetworkBaseUrl("https://host/api/v1", "mainnet")).toBe(
      "https://host/api/v1/mainnet"
    );
  });

  it("appends /testnet to a /api/v1 base", () => {
    expect(resolveNetworkBaseUrl("https://host/api/v1", "testnet")).toBe(
      "https://host/api/v1/testnet"
    );
  });

  it("tolerates trailing slash on the base URL", () => {
    expect(resolveNetworkBaseUrl("https://host/api/v1/", "mainnet")).toBe(
      "https://host/api/v1/mainnet"
    );
  });

  it("handles bare origin (no /api/v1) defensively", () => {
    expect(resolveNetworkBaseUrl("https://host", "mainnet")).toBe(
      "https://host/mainnet"
    );
  });
});

describe("resolveNetworkBaseUrl — base URL has existing network segment", () => {
  it("swaps /mainnet to /testnet correctly", () => {
    expect(resolveNetworkBaseUrl("https://host/api/v1/mainnet", "testnet")).toBe(
      "https://host/api/v1/testnet"
    );
  });

  it("swaps /testnet to /mainnet correctly", () => {
    expect(resolveNetworkBaseUrl("https://host/api/v1/testnet", "mainnet")).toBe(
      "https://host/api/v1/mainnet"
    );
  });

  it("preserves the network when input matches target", () => {
    expect(resolveNetworkBaseUrl("https://host/api/v1/mainnet", "mainnet")).toBe(
      "https://host/api/v1/mainnet"
    );
  });

  it("tolerates trailing slash on a segmented base URL", () => {
    expect(resolveNetworkBaseUrl("https://host/api/v1/testnet/", "mainnet")).toBe(
      "https://host/api/v1/mainnet"
    );
  });
});

describe("resolveNetworkBaseUrl — defensive cases", () => {
  it("does NOT treat a host called 'testnet.example.com' as a network segment", () => {
    // Subdomain coincidence: the host happens to contain 'testnet'.
    // We must only match a path segment, never a host substring.
    expect(resolveNetworkBaseUrl("https://testnet.example.com/api/v1", "mainnet")).toBe(
      "https://testnet.example.com/api/v1/mainnet"
    );
  });

  it("preserves ports and query strings", () => {
    expect(resolveNetworkBaseUrl("https://host:8080/api/v1", "mainnet")).toBe(
      "https://host:8080/api/v1/mainnet"
    );
  });

  it("throws on a non-URL input rather than producing garbage", () => {
    expect(() => resolveNetworkBaseUrl("not-a-url", "mainnet")).toThrow(/invalid/i);
  });

  it("never returns a URL with a trailing slash", () => {
    for (const base of [
      "https://host/api/v1",
      "https://host/api/v1/",
      "https://host/api/v1/mainnet",
      "https://host/api/v1/mainnet/"
    ]) {
      for (const net of ["mainnet", "testnet"] as const) {
        const r = resolveNetworkBaseUrl(base, net);
        expect(r).not.toMatch(/\/$/);
      }
    }
  });
});
