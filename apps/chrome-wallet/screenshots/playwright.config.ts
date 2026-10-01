import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Scoped Playwright config for the Chrome Web Store screenshot harness.
// The capture logic lives in a single spec (capture.ts) that drives a
// persistent Chromium context with the built MV3 extension loaded. We run
// serially with a single worker because the harness mutates a shared
// extension storage state (theme / seeded wallet) between captures.
export default defineConfig({
  testDir: HERE,
  testMatch: ["capture.ts"],
  // Loading + onboarding an MV3 extension and compositing PNGs is slow.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: path.join(HERE, "..", ".screenshots", ".pw-artifacts"),
});
