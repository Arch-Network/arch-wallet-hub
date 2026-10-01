import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Functional extension coverage. The tests load WXT's built MV3 output and
 * use a fresh Chromium profile per test, so no developer wallet, passkey, or
 * network service is required.
 */
export default defineConfig({
  testDir: HERE,
  testMatch: ["*.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: path.join(tmpdir(), "arch-wallet-e2e-artifacts"),
});
