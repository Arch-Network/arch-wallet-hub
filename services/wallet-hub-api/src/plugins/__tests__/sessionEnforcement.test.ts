import { describe, it, expect } from "vitest";
import {
  parseEnforcedRoutes,
  isRouteEnforced,
  sessionEnforcementDecision,
} from "../sessionAuth.js";

describe("parseEnforcedRoutes", () => {
  it("treats empty / undefined as enforce-nothing", () => {
    for (const v of ["", "   ", undefined]) {
      const cfg = parseEnforcedRoutes(v);
      expect(cfg.all).toBe(false);
      expect(cfg.set.size).toBe(0);
      expect(isRouteEnforced(cfg, "arch.transfer")).toBe(false);
    }
  });

  it("parses a comma list, tolerating whitespace and blanks", () => {
    const cfg = parseEnforcedRoutes(" arch.transfer , ,turnkey.sign-message ");
    expect(cfg.all).toBe(false);
    expect(isRouteEnforced(cfg, "arch.transfer")).toBe(true);
    expect(isRouteEnforced(cfg, "turnkey.sign-message")).toBe(true);
    expect(isRouteEnforced(cfg, "btc.build")).toBe(false);
  });

  it("supports the '*' / 'all' wildcard (case-insensitive)", () => {
    for (const v of ["*", "all", "ALL", "arch.transfer,*"]) {
      const cfg = parseEnforcedRoutes(v);
      expect(cfg.all).toBe(true);
      expect(isRouteEnforced(cfg, "anything.at.all")).toBe(true);
    }
  });
});

describe("sessionEnforcementDecision", () => {
  it("skips entirely when the route is not enforced (no behavior change)", () => {
    expect(
      sessionEnforcementDecision({ enabled: false, hasValidSession: false }),
    ).toBe("skip");
    // Even with a bogus claim, a disabled route is untouched.
    expect(
      sessionEnforcementDecision({
        enabled: false,
        hasValidSession: false,
        claimedExternalUserId: "victim",
      }),
    ).toBe("skip");
  });

  it("401s an enforced route with no valid session", () => {
    expect(
      sessionEnforcementDecision({ enabled: true, hasValidSession: false }),
    ).toBe("unauthorized");
  });

  it("403s when the claimed externalUserId differs from the session principal", () => {
    expect(
      sessionEnforcementDecision({
        enabled: true,
        hasValidSession: true,
        sessionExternalUserId: "alice",
        claimedExternalUserId: "bob",
      }),
    ).toBe("forbidden");
  });

  it("allows when the claimed externalUserId matches the principal", () => {
    expect(
      sessionEnforcementDecision({
        enabled: true,
        hasValidSession: true,
        sessionExternalUserId: "alice",
        claimedExternalUserId: "alice",
      }),
    ).toBe("allow");
  });

  it("allows an enforced route that carries no externalUserId to bind", () => {
    // e.g. a route identified purely by a path param / UUID; the session
    // is still required, but there's nothing to cross-check.
    expect(
      sessionEnforcementDecision({
        enabled: true,
        hasValidSession: true,
        sessionExternalUserId: "alice",
        claimedExternalUserId: undefined,
      }),
    ).toBe("allow");
    expect(
      sessionEnforcementDecision({
        enabled: true,
        hasValidSession: true,
        sessionExternalUserId: "alice",
        claimedExternalUserId: "",
      }),
    ).toBe("allow");
  });
});
