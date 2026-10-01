import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(HERE, "..");
const EXTENSION_DIR = path.join(APP_ROOT, ".output", "chrome-mv3");
const PASSWORD = "e2e-test-password";
const ACCOUNT = {
  id: "e2e-account",
  label: "E2E test wallet",
  btcAddress: "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m",
  publicKeyHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  archAddress: "11111111111111111111111111111111",
  kind: "turnkey",
  turnkeyResourceId: "e2e-resource",
  organizationId: "e2e-org",
  authMethod: "email",
  createdAt: 0,
};

type SeedOptions = {
  unlocked?: boolean;
  checkpoint?: boolean;
};

async function extensionId(context: BrowserContext): Promise<string> {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  return new URL(worker.url()).host;
}

async function seedWallet(page: Page, options: SeedOptions = {}): Promise<void> {
  const state = {
    schemaVersion: 5,
    initialized: true,
    locked: false,
    network: "testnet4",
    activeAccountId: ACCOUNT.id,
    accounts: [ACCOUNT],
    connectedSites: {},
    hubBaseUrl: "https://e2e.arch.network",
    hubApiKey: "e2e-key",
    indexerBaseUrl: "",
    indexerApiKey: "",
    openAs: "popup",
    recentRecipients: [],
    contacts: [],
    autoLockMinutes: 15,
    sentryOptIn: false,
    debugMode: false,
  };

  await page.evaluate(
    async ({ state, password, unlocked, checkpoint }) => {
      const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const passwordKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          new TextEncoder().encode(JSON.stringify(state)),
        ),
      );
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      await chrome.storage.local.set({
        arch_wallet_keystore: {
          schema: 2,
          salt: b64(salt),
          iv: b64(iv),
          ciphertext: b64(ciphertext),
          iterations: 600_000,
          createdAt: 0,
          updatedAt: 0,
        },
        arch_wallet_install_id: "e2e-install",
      });
      if (unlocked) {
        const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
        await chrome.storage.session.set({ arch_wallet_session_key: b64(rawKey) });
      }
      if (checkpoint) {
        await chrome.storage.session.set({
          arch_wallet_recovery_session: {
            step: "otp",
            email: "test@example.com",
            challengeId: "e2e-challenge",
            candidates: [],
            emailMasked: "t***@example.com",
            pickedToken: null,
            pinnedExternalUserId: null,
            pinnedResourceId: null,
            savedAt: Date.now(),
          },
        });
      }
    },
    { state, password: PASSWORD, unlocked: options.unlocked ?? true, checkpoint: options.checkpoint ?? false },
  );
}

async function installIndexerFixtures(context: BrowserContext): Promise<void> {
  await context.route("https://e2e.arch.network/**", async (route) => {
    const url = new URL(route.request().url());
    const pathName = url.pathname;
    const json = (body: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

    if (pathName.endsWith("/fee-estimates")) return json({ "1": 2, "3": 5, "6": 8 });
    if (pathName.endsWith("/utxo")) {
      return json([
        {
          txid: "11".repeat(32),
          vout: 0,
          value: 100_000,
          status: { confirmed: true },
        },
      ]);
    }
    if (pathName.includes("/btc/address/")) {
      return json({ chain_stats: { funded_txo_sum: 100_000, spent_txo_sum: 0 } });
    }
    if (pathName.endsWith("/tokens")) return json({ tokens: [] });
    if (pathName.includes("/transactions")) return json({ transactions: [] });
    if (pathName.includes("/accounts/")) {
      return json({ address: ACCOUNT.archAddress, lamports_balance: 0, transaction_count: 0 });
    }
    return json({});
  });
}

test.describe("Chrome wallet functional flows", () => {
  test.skip(!existsSync(EXTENSION_DIR), `Run "npm run build" before E2E tests: ${EXTENSION_DIR}`);

  let context: BrowserContext;
  let popup: Page;
  let baseUrl: string;

  test.beforeEach(async () => {
    context = await chromium.launchPersistentContext(
      mkdtempSync(path.join(tmpdir(), "arch-wallet-e2e-")),
      {
        headless: true,
        channel: "chromium",
        viewport: { width: 400, height: 640 },
        args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
      },
    );
    await installIndexerFixtures(context);
    baseUrl = `chrome-extension://${await extensionId(context)}/popup.html`;
    popup = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test("renders onboarding, validates unlock, and resumes recovery", async () => {
    await popup.goto(baseUrl);
    await expect(popup.getByText(/welcome/i).first()).toBeVisible();

    await seedWallet(popup, { unlocked: false });
    await popup.reload();
    await expect(popup.getByText(/unlock/i).first()).toBeVisible();
    await popup.getByPlaceholder("Your password").fill("wrong-password");
    await popup.getByRole("button", { name: /unlock/i }).click();
    await expect(popup.getByText(/incorrect password/i)).toBeVisible();

    await seedWallet(popup, { checkpoint: true });
    await popup.goto(`${baseUrl}#/dashboard`);
    await expect(popup).toHaveURL(/#\/recover/);
  });

  test("prepares a Bitcoin send entirely from deterministic indexer fixtures", async () => {
    await popup.goto(baseUrl);
    await seedWallet(popup);
    await popup.reload();
    await expect(popup.locator(".app-container")).toBeVisible();
    await popup.goto(`${baseUrl}#/send`);

    await popup.getByRole("button", { name: /bitcoin/i }).click();
    await popup.getByPlaceholder("tb1p…").fill(ACCOUNT.btcAddress);
    await popup.getByPlaceholder("0.00").fill("0.0005");
    await popup.getByRole("button", { name: "Review" }).click();

    await expect(popup.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(popup.getByText(/network fee/i)).toBeVisible();
    await expect(popup.getByText(/8\.0 sat\/vB/)).toBeVisible();
    await expect(popup.getByText("1,232 sats (0.00001232 BTC)")).toBeVisible();
  });

  test("blocks ARCH send review when a .arch name cannot be resolved", async () => {
    await popup.goto(baseUrl);
    await seedWallet(popup);
    await popup.reload();
    await expect(popup.locator(".app-container")).toBeVisible();
    await popup.goto(`${baseUrl}#/send`);

    await popup.getByRole("button", { name: /arch/i }).first().click();
    await popup.getByPlaceholder("Base58 address").fill("nobody-e2e.arch");
    await popup.getByPlaceholder("0.00").fill("0.001");
    await expect(popup.getByText(/Unresolved name or invalid Arch address/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(popup.getByRole("button", { name: "Review" })).toBeDisabled();
  });

  test("accepts a literal Arch address for send without name resolution", async () => {
    await popup.goto(baseUrl);
    await seedWallet(popup);
    await popup.reload();
    await expect(popup.locator(".app-container")).toBeVisible();
    await popup.goto(`${baseUrl}#/send`);

    await popup.getByRole("button", { name: /arch/i }).first().click();
    await popup.getByPlaceholder("Base58 address").fill(ACCOUNT.archAddress);
    await expect(popup.getByText(new RegExp(`Address:\\s*${ACCOUNT.archAddress}`))).toBeVisible({
      timeout: 10_000,
    });
  });

  test("dapp connect approval persists consent and rejection returns an error", async () => {
    await popup.goto(baseUrl);
    await seedWallet(popup);

    const dapp = await context.newPage();
    await dapp.route("https://e2e-dapp.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>E2E dapp</title>" }),
    );
    await dapp.goto("https://e2e-dapp.test/");
    await expect.poll(() => dapp.evaluate(() => Boolean((window as any).arch))).toBe(true);

    const approvalOpened = context.waitForEvent("page");
    await dapp.evaluate(() => {
      (window as any).__connect = (window as any).arch.connect();
    });
    const approval = await approvalOpened;
    await approval.waitForLoadState("domcontentloaded");
    await expect(approval.getByText(/wants to connect/i)).toBeVisible();
    await approval.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => dapp.evaluate(() => (window as any).__connect)).toEqual({
      address: ACCOUNT.btcAddress,
      publicKey: ACCOUNT.publicKeyHex,
      archAddress: ACCOUNT.archAddress,
    });

    const rejectOpened = context.waitForEvent("page");
    await dapp.evaluate(() => {
      (window as any).__sign = (window as any).arch.signMessage(new Uint8Array([1, 2, 3])).catch(
        (error: Error) => error.message,
      );
    });
    const rejectApproval = await rejectOpened;
    await rejectApproval.waitForLoadState("domcontentloaded");
    await expect(rejectApproval.getByText(/sign message/i)).toBeVisible();
    await rejectApproval.getByRole("button", { name: "Reject" }).click();
    await expect.poll(() => dapp.evaluate(() => (window as any).__sign)).toMatch(/user rejected/i);
  });
});
