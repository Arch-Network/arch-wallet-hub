import { describe, it, expect } from "vitest";
import { isAllowedHubBaseUrl } from "../types";

describe("isAllowedHubBaseUrl", () => {
  it("accepts the production Hub host", () => {
    expect(isAllowedHubBaseUrl("https://hub.arch.network")).toBe(true);
    expect(isAllowedHubBaseUrl("https://hub.arch.network/")).toBe(true);
    expect(isAllowedHubBaseUrl("https://hub.arch.network/v1")).toBe(true);
  });

  it("accepts *.arch.network subdomains", () => {
    expect(isAllowedHubBaseUrl("https://staging.arch.network")).toBe(true);
    expect(isAllowedHubBaseUrl("https://canary.hub.arch.network")).toBe(true);
    expect(isAllowedHubBaseUrl("https://arch.network")).toBe(true);
  });

  it("accepts local dev hosts on either protocol", () => {
    expect(isAllowedHubBaseUrl("http://localhost:3005")).toBe(true);
    expect(isAllowedHubBaseUrl("http://127.0.0.1:3005")).toBe(true);
    expect(isAllowedHubBaseUrl("https://localhost:3005")).toBe(true);
  });

  it("rejects look-alike and unrelated hosts", () => {
    // The whole point of the allowlist: visually-similar but not us.
    expect(isAllowedHubBaseUrl("https://hub.arch-network.com")).toBe(false);
    expect(isAllowedHubBaseUrl("https://hub.arch.netwoгk")).toBe(false); // Cyrillic 'г'
    expect(isAllowedHubBaseUrl("https://arch.network.evil.com")).toBe(false);
    expect(isAllowedHubBaseUrl("https://evil.com")).toBe(false);
    expect(isAllowedHubBaseUrl("https://archnetwork.com")).toBe(false);
  });

  it("rejects strings that don't parse as URLs", () => {
    expect(isAllowedHubBaseUrl("")).toBe(false);
    expect(isAllowedHubBaseUrl("not a url")).toBe(false);
    expect(isAllowedHubBaseUrl("hub.arch.network")).toBe(false); // missing protocol
  });

  it("matches hostname case-insensitively", () => {
    expect(isAllowedHubBaseUrl("https://HUB.ARCH.NETWORK")).toBe(true);
  });
});
