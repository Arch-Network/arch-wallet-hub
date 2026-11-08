import { test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compositeToCanvas, type CanvasTheme } from "./lib/composite";
import {
  makeDeterministicWalletSeed,
  makeLockedKeystoreSeed,
  type StorageSeed,
} from "./lib/seed";
import {
  FIXTURE_ACCOUNTS,
  coingeckoResponse,
  fixtureResponse,
  type FixtureAccountId,
  type FixtureMode,
} from "./lib/fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, "..");
const EXTENSION_DIR = path.join(APP_ROOT, ".output", "chrome-mv3");
const OUTPUT_DIR = path.join(APP_ROOT, ".screenshots");
const REVIEW_DIR = path.join(OUTPUT_DIR, "review");
const THEME_STORAGE_KEY = "arch_wallet_theme"; // src/utils/theme.ts
const THEMES: CanvasTheme[] = ["light", "dark"];

const HEADED = process.env.HEADED === "1";

interface Viewport {
  width: number;
  height: number;
}
// The toolbar popup is fixed at 400px (global.css), so 360px only occurs
// in a narrow side panel, which fills its width.
const POPUP_400: Viewport = { width: 400, height: 600 };
const PANEL_NARROW: Viewport = { width: 360, height: 600 };
const PANEL_WIDE: Viewport = { width: 1000, height: 800 };

interface ScreenDef {
  name: string;
  route: string; // HashRouter route, "" = default landing
  requiresSeed: boolean;
  settleMs: number;
  description: string;
}

// The wallet renders Onboarding when uninitialized and Unlock when sealed but
// locked — both are reachable WITHOUT any secret. The remaining screens use a
// synthetic unlocked wallet and intercepted indexer responses.
const SCREENS: ScreenDef[] = [
  { name: "onboarding", route: "", requiresSeed: false, settleMs: 1600, description: "Welcome / create wallet" },
  { name: "unlock", route: "", requiresSeed: false, settleMs: 1200, description: "Unlock (locked keystore)" },
  { name: "dashboard", route: "/dashboard", requiresSeed: true, settleMs: 3200, description: "Portfolio dashboard" },
  { name: "send", route: "/send", requiresSeed: true, settleMs: 2600, description: "Send" },
  { name: "receive", route: "/receive", requiresSeed: true, settleMs: 2200, description: "Receive" },
  { name: "history", route: "/history", requiresSeed: true, settleMs: 3200, description: "Activity / history" },
  { name: "settings", route: "/settings", requiresSeed: true, settleMs: 1600, description: "Settings" },
];

/**
 * Uncomposited captures for design review: every account kind, the
 * popup, narrow and wide side panels, and the history failure state.
 */
interface ReviewCapture {
  name: string;
  account: FixtureAccountId | null;
  route: string;
  theme: CanvasTheme;
  viewport: Viewport;
  surface: "popup" | "sidepanel";
  mode?: Partial<FixtureMode>;
  settleMs?: number;
}

const ACCOUNT_IDS: FixtureAccountId[] = ["native-email", "native-passkey", "xverse", "unisat", "watch"];

const REVIEW_CAPTURES: ReviewCapture[] = [
  ...ACCOUNT_IDS.flatMap((account): ReviewCapture[] => [
    { name: `dashboard-${account}`, account, route: "/dashboard", theme: "dark", viewport: POPUP_400, surface: "popup" },
    { name: `receive-${account}`, account, route: "/receive", theme: "dark", viewport: POPUP_400, surface: "popup" },
  ]),
  { name: "dashboard-xverse-light", account: "xverse", route: "/dashboard", theme: "light", viewport: POPUP_400, surface: "popup" },
  { name: "send-xverse-light", account: "xverse", route: "/send", theme: "light", viewport: POPUP_400, surface: "popup" },
  { name: "settings-xverse", account: "xverse", route: "/settings", theme: "dark", viewport: POPUP_400, surface: "popup" },
  { name: "history-failure", account: "native-email", route: "/history", theme: "dark", viewport: POPUP_400, surface: "popup", mode: { btcHistory: "fail" } },
  { name: "dashboard-xverse-panel-narrow", account: "xverse", route: "/dashboard", theme: "dark", viewport: PANEL_NARROW, surface: "sidepanel" },
  { name: "receive-xverse-panel-narrow", account: "xverse", route: "/receive", theme: "light", viewport: PANEL_NARROW, surface: "sidepanel" },
  { name: "dashboard-xverse-panel-wide", account: "xverse", route: "/dashboard", theme: "light", viewport: PANEL_WIDE, surface: "sidepanel" },
  { name: "onboarding-panel-narrow", account: null, route: "", theme: "dark", viewport: PANEL_NARROW, surface: "sidepanel", settleMs: 1600 },
];

interface CaptureResult {
  screen: string;
  theme: CanvasTheme;
  status: "captured" | "skipped";
  reason?: string;
  file?: string;
}

const DEFAULT_MODE: FixtureMode = { btcHistory: "ok" };

async function resolveExtensionId(context: BrowserContext): Promise<string> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  // chrome-extension://<id>/background.js
  return new URL(sw.url()).host;
}

async function installDeterministicFixtures(
  context: BrowserContext,
  currentMode: () => FixtureMode,
): Promise<void> {
  await context.route("https://screenshots.arch.network/**", async (route) => {
    const { status, body } = fixtureResponse(new URL(route.request().url()).pathname, currentMode());
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await context.route("https://api.coingecko.com/**", async (route) => {
    const { status, body } = coingeckoResponse();
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/** Reset extension storage, inject the seed for this screen, and reload. */
async function primePage(
  page: Page,
  url: string,
  theme: CanvasTheme,
  seed: StorageSeed | undefined,
): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
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

async function renderScreen(
  page: Page,
  url: string,
  route: string,
  theme: CanvasTheme,
  seed: StorageSeed | undefined,
  settleMs: number,
): Promise<void> {
  await primePage(page, url, theme, seed);
  if (route) {
    await page.evaluate((r) => {
      window.location.hash = r;
    }, route);
  }
  await page.waitForSelector("#root *", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
}

async function captureListingScreen(
  page: Page,
  baseUrl: string,
  screen: ScreenDef,
  theme: CanvasTheme,
  seed: StorageSeed | undefined,
): Promise<CaptureResult> {
  await page.setViewportSize(POPUP_400);
  await renderScreen(page, baseUrl, screen.route, theme, seed, screen.settleMs);

  if (screen.requiresSeed && !(await isUnlockedShell(page))) {
    return {
      screen: screen.name,
      theme,
      status: "skipped",
      reason: "synthetic wallet did not unlock the extension",
    };
  }

  const popupPng = await page.screenshot();
  const composed = await compositeToCanvas(popupPng, theme);
  const file = path.join(OUTPUT_DIR, `${screen.name}-${theme}.png`);
  writeFileSync(file, composed);
  return { screen: screen.name, theme, status: "captured", file };
}

async function captureReview(
  page: Page,
  extensionOrigin: string,
  capture: ReviewCapture,
  seeds: Record<FixtureAccountId, StorageSeed>,
  setMode: (mode: FixtureMode) => void,
): Promise<CaptureResult> {
  setMode({ ...DEFAULT_MODE, ...capture.mode });
  await page.setViewportSize(capture.viewport);
  const url = `${extensionOrigin}/${capture.surface}.html`;
  const seed = capture.account ? seeds[capture.account] : undefined;
  await renderScreen(page, url, capture.route, capture.theme, seed, capture.settleMs ?? 3200);
  if (capture.account && !(await isUnlockedShell(page))) {
    return { screen: capture.name, theme: capture.theme, status: "skipped", reason: "wallet did not unlock" };
  }
  const file = path.join(REVIEW_DIR, `${capture.name}.png`);
  writeFileSync(file, await page.screenshot());
  return { screen: capture.name, theme: capture.theme, status: "captured", file };
}

test("capture listing and review screenshots", async () => {
  test.skip(
    !existsSync(EXTENSION_DIR),
    `Built extension not found at ${EXTENSION_DIR}. Run "npm run build" first.`,
  );

  mkdirSync(REVIEW_DIR, { recursive: true });

  const allAccounts = ACCOUNT_IDS.map((id) => FIXTURE_ACCOUNTS[id]);
  const seeds = {} as Record<FixtureAccountId, StorageSeed>;
  for (const id of ACCOUNT_IDS) {
    seeds[id] = await makeDeterministicWalletSeed(allAccounts, String(FIXTURE_ACCOUNTS[id].id));
  }
  const lockedSeed = await makeLockedKeystoreSeed();

  console.log("\n=== Arch Wallet screenshot harness ===");
  console.log(`Extension: ${EXTENSION_DIR}`);
  console.log(`Output:    ${OUTPUT_DIR}`);
  console.log("Data:      deterministic synthetic wallets + intercepted fixtures");

  const userDataDir = mkdtempSync(path.join(tmpdir(), "arch-wallet-screenshots-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    // The new headless mode (channel "chromium") is required to load MV3
    // extensions headlessly; headed runs use the default bundled build.
    ...(HEADED ? {} : { channel: "chromium" }),
    viewport: POPUP_400,
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
    ],
  });

  let mode: FixtureMode = DEFAULT_MODE;
  const results: CaptureResult[] = [];
  try {
    await installDeterministicFixtures(context, () => mode);
    const extensionId = await resolveExtensionId(context);
    const extensionOrigin = `chrome-extension://${extensionId}`;
    const baseUrl = `${extensionOrigin}/popup.html`;
    console.log(`Extension id: ${extensionId}\n`);

    const page = await context.newPage();

    for (const screen of SCREENS) {
      const seed = screen.name === "unlock"
        ? lockedSeed
        : screen.requiresSeed ? seeds["native-email"] : undefined;
      for (const theme of THEMES) {
        try {
          results.push(await captureListingScreen(page, baseUrl, screen, theme, seed));
        } catch (err) {
          results.push({ screen: screen.name, theme, status: "skipped", reason: `error: ${(err as Error).message}` });
        }
      }
    }

    for (const capture of REVIEW_CAPTURES) {
      try {
        results.push(await captureReview(page, extensionOrigin, capture, seeds, (m) => { mode = m; }));
      } catch (err) {
        results.push({ screen: capture.name, theme: capture.theme, status: "skipped", reason: `error: ${(err as Error).message}` });
      }
    }
  } finally {
    await context.close();
  }

  writeFileSync(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
  );

  const captured = results.filter((r) => r.status === "captured");
  const skipped = results.filter((r) => r.status === "skipped");
  console.log(`\n--- Capture summary ---`);
  for (const r of captured) console.log(`  [captured] ${r.screen} (${r.theme}) -> ${path.relative(OUTPUT_DIR, r.file!)}`);
  for (const r of skipped) console.log(`  [skipped]  ${r.screen} (${r.theme}): ${r.reason}`);
  console.log(`\n${captured.length} captured, ${skipped.length} skipped.`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  // Fail only if the extension did not load or render at all.
  if (captured.length === 0) {
    throw new Error(
      "No screens captured — the extension failed to load or render. " +
        "Try HEADED=1 and confirm `npm run build` produced .output/chrome-mv3.",
    );
  }
});
