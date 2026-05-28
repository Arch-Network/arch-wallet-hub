import { describe, expect, it } from "vitest";
import {
  assessOriginRisk,
  hostnameFromOrigin,
  normalizeHostnameForComparison,
} from "../phishing";

describe("hostnameFromOrigin", () => {
  it("extracts hostname from a full URL", () => {
    expect(hostnameFromOrigin("https://example.com/path")).toBe("example.com");
    expect(hostnameFromOrigin("https://EXAMPLE.COM:8443/x")).toBe("example.com");
  });

  it("accepts bare hostnames", () => {
    expect(hostnameFromOrigin("example.com")).toBe("example.com");
    expect(hostnameFromOrigin("sub.example.com")).toBe("sub.example.com");
  });

  it("returns empty string for garbage", () => {
    expect(hostnameFromOrigin("")).toBe("");
    expect(hostnameFromOrigin("   ")).toBe("");
  });
});

describe("normalizeHostnameForComparison", () => {
  it("folds Cyrillic confusables to ASCII", () => {
    // "arсh.network" with a Cyrillic 'с' in place of Latin 'c'
    const cyrillic = "ar\u0441h.network";
    expect(normalizeHostnameForComparison(cyrillic)).toBe("arch.network");
  });

  it("folds digit lookalikes to letters", () => {
    expect(normalizeHostnameForComparison("0pensea.io")).toBe("opensea.io");
    expect(normalizeHostnameForComparison("1ightning.com")).toBe("lightning.com");
  });

  it("leaves clean ASCII hostnames untouched", () => {
    expect(normalizeHostnameForComparison("arch.network")).toBe("arch.network");
    expect(normalizeHostnameForComparison("example.com")).toBe("example.com");
  });
});

describe("assessOriginRisk", () => {
  const TRUSTED = ["arch.network", "hub.arch.network"];

  it("returns 'ok' for a clean unknown host", () => {
    const r = assessOriginRisk("https://opensea.io", { trustedList: TRUSTED });
    expect(r.reason).toBe("ok");
    expect(r.level).toBe("info");
  });

  it("returns 'ok' for the trusted host itself (no false positive)", () => {
    const r = assessOriginRisk("https://arch.network", { trustedList: TRUSTED });
    expect(r.reason).toBe("ok");
  });

  it("flags a blocklist entry as danger", () => {
    const r = assessOriginRisk("https://evil.example", {
      trustedList: TRUSTED,
      blocklist: new Set(["evil.example"]),
    });
    expect(r.reason).toBe("blocklist");
    expect(r.level).toBe("danger");
  });

  it("flags Cyrillic homograph against trusted host as danger", () => {
    // Latin 'c' replaced with Cyrillic 'с'. The URL parser re-
    // encodes this to Punycode, so the final hostname is both an
    // IDN and a visual-identical impostor of arch.network -- which
    // is the worst-case verdict (`punycode-lookalike`).
    const cyrillic = "https://ar\u0441h.network";
    const r = assessOriginRisk(cyrillic, { trustedList: TRUSTED });
    expect(r.reason).toBe("punycode-lookalike");
    expect(r.level).toBe("danger");
    expect(r.label).toContain("arch.network");
  });

  it("flags an ASCII visual-impostor (no IDN) as plain lookalike", () => {
    // No Punycode involved -- just a typo-squat. Should land on
    // `lookalike`, not `punycode-lookalike`.
    const r = assessOriginRisk("https://0pensea.io", {
      trustedList: ["opensea.io"],
    });
    expect(r.reason).toBe("lookalike");
    expect(r.level).toBe("danger");
  });

  it("flags a 1-char edit-distance lookalike as danger", () => {
    const r = assessOriginRisk("https://arch.netwoork", { trustedList: TRUSTED });
    expect(r.reason).toBe("lookalike");
    expect(r.level).toBe("danger");
  });

  it("does NOT flag hosts beyond the lookalike distance cap", () => {
    const r = assessOriginRisk("https://totallydifferent.io", {
      trustedList: TRUSTED,
    });
    expect(r.reason).toBe("ok");
  });

  it("flags Punycode-only (no lookalike) as warn", () => {
    // xn--80akhbyknj4f.example is a synthetic IDN we don't have in
    // the trusted list -- so the verdict is "internationalized
    // domain, double-check" rather than a hard danger.
    const r = assessOriginRisk("https://xn--80akhbyknj4f.example", {
      trustedList: TRUSTED,
    });
    expect(r.reason).toBe("punycode");
    expect(r.level).toBe("warn");
  });

  it("escalates Punycode + lookalike to danger", () => {
    // "аrch.network" with a Cyrillic 'а' encoded as Punycode --
    // the URL parser decodes it, the confusable fold makes it
    // match "arch.network", and the result is the worst case.
    // Real encoding: "аrch.network" -> "xn--rch-mn4d.network"
    const punycodeLookalike = "https://xn--rch-mn4d.network";
    const r = assessOriginRisk(punycodeLookalike, { trustedList: TRUSTED });
    expect(r.reason).toBe("punycode-lookalike");
    expect(r.level).toBe("danger");
  });

  it("emits an empty label for ok so the banner can short-circuit", () => {
    const r = assessOriginRisk("https://example.com", { trustedList: TRUSTED });
    expect(r.label).toBe("");
  });
});
