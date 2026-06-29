import { test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compositeToCanvas, type CanvasTheme } from "./lib/composite";
import { loadSeedFile, makeLockedKeystoreSeed, type StorageSeed } from "./lib/seed";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, "..");
const EXTENSION_DIR = path.join(APP_ROOT, ".output", "chrome-mv3");
const OUTPUT_DIR = path.join(APP_ROOT, ".screenshots");
const THEME_STORAGE_KEY = "arch_wallet_theme"; // src/utils/theme.ts
const THEMES: CanvasTheme[] = ["light", "dark"];

const SEED_FILE =
  process.env.WALLET_SEED_FILE || path.join(HERE, "seed.local.json");
const HEADED = process.env.HEADED === "1";

interface ScreenDef {
  name: string;
  route: string; // HashRouter route, "" = default landing
  requiresSeed: boolean;
  settleMs: number;
  description: string;
}

// The wallet renders Onboarding when uninitialized and Unlock when sealed but
// locked — both are reachable WITHOUT any secret. The remaining screens need a
// seeded (unlocked) wallet supplied via WALLET_SEED_FILE.
const SCREENS: ScreenDef[] = [
  { name: "onboarding", route: "", requiresSeed: false, settleMs: 1600, description: "Welcome / create wallet" },
  { name: "unlock", route: "", requiresSeed: false, settleMs: 1200, description: "Unlock (locked keystore)" },
  { name: "dashboard", route: "/dashboard", requiresSeed: true, settleMs: 3200, description: "Portfolio dashboard" },
  { name: "send", route: "/send", requiresSeed: true, settleMs: 2600, description: "Send" },
  { name: "receive", route: "/receive", requiresSeed: true, settleMs: 2200, description: "Receive" },
  { name: "history", route: "/history", requiresSeed: true, settleMs: 3200, description: "Activity / history" },
  { name: "settings", route: "/settings", requiresSeed: true, settleMs: 1600, description: "Settings" },
];

interface CaptureResult {
  screen: string;
  theme: CanvasTheme;
  status: "captured" | "skipped";
  reason?: string;
  file?: string;
}

function detectEnvKeys(): Record<string, boolean> {
  const envPath = path.join(APP_ROOT, ".env.local");
  const wanted = ["WXT_HUB_API_KEY_DEV", "WXT_INDEXER_API_KEY_DEV"];
  const present: Record<string, boolean> = Object.fromEntries(
    wanted.map((k) => [k, false]),
  );
  if (!existsSync(envPath)) return present;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && wanted.includes(m[1]) && m[2].length > 0) present[m[1]] = true;
  }
  return present;
}

async function resolveExtensionId(context: BrowserContext): Promise<string> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  // chrome-extension://<id>/background.js
  return new URL(sw.url()).host;
}

/** Reset extension storage, inject the seed for this screen, and reload. */
async function primePage(
  page: Page,
  baseUrl: string,
  theme: CanvasTheme,
  seed: StorageSeed | undefined,
): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const payload: StorageSeed = {
    local: { [THEME_STORAGE_KEY]: theme, ...(seed?.local ?? {}) },
    session: seed?.session ?? {},
  };
  await page.evaluate(async (s) => {
    await chrome.storage.local.clear();
    if (chrome.storage.session) await chrome.storage.session.clear();
    if (s.local) await chrome.storage.local.set(s.local);
    if (s.session && chrome.storage.session) {
      await chrome.storage.session.set(s.session);
    }
  }, payload);
  await page.emulateMedia({ colorScheme: theme });
  await page.reload({ waitUntil: "domcontentloaded" });
}

/** True once the unlocked app shell (not Onboarding/Unlock) is mounted. */
async function isUnlockedShell(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.querySelector(".app-container"));
}

async function captureScreen(
  page: Page,
  baseUrl: string,
  screen: ScreenDef,
  theme: CanvasTheme,
  seed: StorageSeed | undefined,
): Promise<CaptureResult> {
  await primePage(page, baseUrl, theme, seed);
  if (screen.route) {
    await page.evaluate((r) => {
      window.location.hash = r;
    }, screen.route);
  }
  await page.waitForSelector("#root *", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(screen.settleMs);

  if (screen.requiresSeed && !(await isUnlockedShell(page))) {
    return {
      screen: screen.name,
      theme,
      status: "skipped",
      reason: "seed did not unlock the wallet (set WALLET_SEED_FILE)",
    };
  }

  const popupPng = await page.screenshot();
  const composed = await compositeToCanvas(popupPng, theme);
  const file = path.join(OUTPUT_DIR, `${screen.name}-${theme}.png`);
  writeFileSync(file, composed);
  return { screen: screen.name, theme, status: "captured", file };
}

test("capture Chrome Web Store listing screenshots", async () => {
  test.skip(
    !existsSync(EXTENSION_DIR),
    `Built extension not found at ${EXTENSION_DIR}. Run "npm run build" first.`,
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const envKeys = detectEnvKeys();
  const seedFromFile = loadSeedFile(SEED_FILE);
  const lockedSeed = await makeLockedKeystoreSeed();

  console.log("\n=== Arch Wallet screenshot harness ===");
  console.log(`Extension: ${EXTENSION_DIR}`);
  console.log(`Output:    ${OUTPUT_DIR}`);
  console.log(`Env keys:  ${JSON.stringify(envKeys)}`);
  console.log(
    seedFromFile
      ? `Seed file: ${SEED_FILE} (present) — will attempt data-rich screens`
      : `Seed file: none at ${SEED_FILE} — data-rich screens will be skipped`,
  );

  const userDataDir = mkdtempSync(path.join(tmpdir(), "arch-wallet-screenshots-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    // The new headless mode (channel "chromium") is required to load MV3
    // extensions headlessly; headed runs use the default bundled build.
    ...(HEADED ? {} : { channel: "chromium" }),
    viewport: { width: 400, height: 600 },
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
    ],
  });

  const results: CaptureResult[] = [];
  try {
    const extensionId = await resolveExtensionId(context);
    const baseUrl = `chrome-extension://${extensionId}/popup.html`;
    console.log(`Extension id: ${extensionId}\n`);

    const page = await context.newPage();

    for (const screen of SCREENS) {
      const seed = screen.requiresSeed ? seedFromFile ?? undefined : undefined;
      if (screen.name === "unlock") {
        // Unlock needs a sealed-but-locked keystore (no secret involved).
        for (const theme of THEMES) {
          results.push(
            await captureScreen(page, baseUrl, screen, theme, lockedSeed),
          );
        }
        continue;
      }
      if (screen.requiresSeed && !seedFromFile) {
        for (const theme of THEMES) {
          results.push({
            screen: screen.name,
            theme,
            status: "skipped",
            reason: "no WALLET_SEED_FILE provided",
          });
        }
        continue;
      }
      for (const theme of THEMES) {
        try {
          results.push(await captureScreen(page, baseUrl, screen, theme, seed));
        } catch (err) {
          results.push({
            screen: screen.name,
            theme,
            status: "skipped",
            reason: `error: ${(err as Error).message}`,
          });
        }
      }
    }
  } finally {
    await context.close();
  }

  writeFileSync(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), envKeys, results }, null, 2),
  );

  const captured = results.filter((r) => r.status === "captured");
  const skipped = results.filter((r) => r.status === "skipped");
  console.log(`\n--- Capture summary ---`);
  for (const r of captured) console.log(`  [captured] ${r.screen} (${r.theme}) -> ${path.basename(r.file!)}`);
  for (const r of skipped) console.log(`  [skipped]  ${r.screen} (${r.theme}): ${r.reason}`);
  console.log(`\n${captured.length} captured, ${skipped.length} skipped.`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  // The harness itself must succeed even when data-rich screens are skipped;
  // we only fail if NOTHING could be captured (a real harness/extension fault).
  if (captured.length === 0) {
    throw new Error(
      "No screens captured — the extension failed to load or render. " +
        "Try HEADED=1 and confirm `npm run build` produced .output/chrome-mv3.",
    );
  }
});
