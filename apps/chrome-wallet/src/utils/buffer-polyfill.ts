/**
 * Browser Node-globals polyfill.
 *
 * Several BTC libraries pulled in by `@arch/swap-engine` (notably
 * `@saturnbtcio/bip322-js` -> `cipher-base` -> `readable-stream`,
 * and `bitcoinjs-lib`'s vendored helpers) reference Node-only
 * globals at module-init time: `Buffer`, bare `global`, and
 * `process`. None of those exist in MV3 ServiceWorkers or the
 * extension popup, so we shim all three on the first import.
 *
 * Idempotent: if a host already provides any of these (e.g. tests
 * run via vitest in node mode), we leave them alone.
 *
 * Import this once at the top of every entry that loads the engine
 * or BTC primitives: popup `main.tsx`, sidepanel `main.tsx`, and
 * `background.ts`. Importing it from a leaf module is too late --
 * by the time the leaf evaluates, the offending top-level reference
 * has already thrown.
 */
import { Buffer } from "buffer";

type ProcessShim = {
  env: Record<string, string | undefined>;
  version: string;
  browser: boolean;
  platform: string;
  nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => void;
};

type NodeShim = {
  Buffer?: typeof Buffer;
  global?: unknown;
  process?: ProcessShim;
};

const g = globalThis as unknown as NodeShim;

if (typeof g.Buffer === "undefined") {
  g.Buffer = Buffer;
}

if (typeof g.global === "undefined") {
  // Many CommonJS-compiled modules check `typeof global !== "undefined"`
  // at top level (e.g. to feature-detect Node). Pointing `global` at
  // `globalThis` makes those checks succeed and the no-op branches
  // they guard run cleanly in the browser.
  g.global = globalThis;
}

if (typeof g.process === "undefined") {
  // `version` + `browser` satisfy readable-stream's Node-feature
  // detection (it does `process.version.slice(0, 5)` at module load).
  // `nextTick` is queueMicrotask-equivalent so anything queued runs
  // before the next macrotask. `platform` keeps any dep that grabs it
  // at init for diagnostics happy. Keep this set minimal so we surface
  // (rather than silently swallow) any future dep that reaches for
  // additional process API.
  g.process = {
    env: {},
    version: "v20.0.0",
    browser: true,
    platform: "browser",
    nextTick(cb, ...args) {
      queueMicrotask(() => cb(...args));
    },
  };
}

export {};
