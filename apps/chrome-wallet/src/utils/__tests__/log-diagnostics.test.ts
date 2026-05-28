import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetForTests,
  applyDiagnosticsRuntime,
  clearRecentLogs,
  getRecentLogs,
  installGlobalErrorHandlers,
  isDebugModeEnabled,
  log,
} from "../log";

class FakeTarget {
  private listeners = new Map<string, Set<(e: any) => void>>();

  addEventListener(type: string, fn: (e: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatch(type: string, event: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

beforeEach(() => {
  __resetForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyDiagnosticsRuntime", () => {
  it("flips debug mode at runtime so log.debug starts recording", () => {
    expect(isDebugModeEnabled()).toBe(false);
    log.debug("invisible", { x: 1 });
    expect(getRecentLogs()).toHaveLength(0);

    applyDiagnosticsRuntime({ debugMode: true, sentryOptIn: false });
    expect(isDebugModeEnabled()).toBe(true);

    log.debug("visible", { x: 2 });
    const entries = getRecentLogs();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.msg).toBe("visible");
  });

  it("does NOT initialize Sentry when no DSN is configured at build", async () => {
    // No DSN is configured in the vitest environment (see vitest.config.ts).
    // Sentry init must short-circuit even when the user opts in, otherwise
    // we'd silently emit hits to whatever endpoint a misconfigured build
    // pointed at.
    applyDiagnosticsRuntime({ debugMode: false, sentryOptIn: true });
    await new Promise((r) => setTimeout(r, 5));
    expect((globalThis as any).Sentry).toBeUndefined();
  });

  it("toggling debug off stops new entries from being recorded", () => {
    applyDiagnosticsRuntime({ debugMode: true, sentryOptIn: false });
    log.debug("first");
    expect(getRecentLogs()).toHaveLength(1);

    applyDiagnosticsRuntime({ debugMode: false, sentryOptIn: false });
    log.debug("dropped");
    // First entry still in the ring, second one never got pushed.
    expect(getRecentLogs()).toHaveLength(1);
  });
});

describe("installGlobalErrorHandlers", () => {
  it("forwards uncaught errors into the ring buffer", () => {
    const target = new FakeTarget();
    installGlobalErrorHandlers(target);
    expect(target.listenerCount("error")).toBe(1);
    expect(target.listenerCount("unhandledrejection")).toBe(1);

    target.dispatch("error", { error: new Error("boom") });
    const entries = getRecentLogs();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.msg).toBe("uncaught error");
    expect(entries[0]!.extra).toMatchObject({ name: "Error", message: "boom" });
  });

  it("forwards unhandled rejections (Error and non-Error reasons)", () => {
    const target = new FakeTarget();
    installGlobalErrorHandlers(target);

    target.dispatch("unhandledrejection", { reason: new Error("rejected") });
    target.dispatch("unhandledrejection", { reason: "string reason" });

    const entries = getRecentLogs();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.extra).toMatchObject({ message: "rejected" });
    expect(entries[1]!.extra).toMatchObject({ message: "string reason" });
  });

  it("is idempotent: a second install does nothing and teardown is a no-op", () => {
    const target = new FakeTarget();
    const teardown1 = installGlobalErrorHandlers(target);
    const teardown2 = installGlobalErrorHandlers(target);

    expect(target.listenerCount("error")).toBe(1);
    teardown2();
    expect(target.listenerCount("error")).toBe(1);

    teardown1();
    expect(target.listenerCount("error")).toBe(0);
  });
});

describe("ring buffer", () => {
  it("clearRecentLogs empties the buffer", () => {
    applyDiagnosticsRuntime({ debugMode: true, sentryOptIn: false });
    log.debug("a");
    log.debug("b");
    expect(getRecentLogs()).toHaveLength(2);

    clearRecentLogs();
    expect(getRecentLogs()).toHaveLength(0);
  });
});
