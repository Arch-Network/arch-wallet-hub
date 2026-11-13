import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
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
  authMethod?: "email" | "passkey";
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
    accounts: [{ ...ACCOUNT, authMethod: options.authMethod ?? ACCOUNT.authMethod }],
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

const PASSKEY_PAGE_URL = "https://wallet.arch.network/passkey.html";

/** The ceremony page is injected by the extension; the hosted file is empty. */
async function stubPasskeyPage(context: BrowserContext): Promise<void> {
  await context.route(PASSKEY_PAGE_URL, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Arch Wallet</title>" }),
  );
}

/**
 * Give the passkey page a passkey that answers on its own, as a second
 * Arch Wallet passkey saved on the same device would.
 */
async function addPasskey(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: Buffer.from("e2e-other-wallet-passkey").toString("base64"),
      isResidentCredential: true,
      rpId: "wallet.arch.network",
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      userHandle: Buffer.from("e2e-other-wallet").toString("base64"),
      signCount: 0,
    },
  });
}

/**
 * Load the seeded wallet, unlocked, on the dashboard.
 *
 * Loaded at #/dashboard rather than the bare popup URL. From "/" the app
 * redirects to the dashboard and saves that as the last route; its
 * route restore then reads the saved route and navigates to it a moment
 * later, pulling a test that has already moved on back to the dashboard.
 * Starting on the route it would restore leaves it nothing to do.
 */
async function openUnlockedWallet(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}#/dashboard`);
  await seedWallet(page);
  await page.reload();
  await expect(page.locator(".app-container")).toBeVisible();
}

/**
 * Open Send and wait until it has rendered. The hash change returns
 * before React routes, and the dashboard still on screen has its own
 * "Get test ARCH" and "Bitcoin" buttons for an asset click to land on.
 */
async function openSend(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}#/send`);
  await expect(page.getByText("Choose which asset you want to send.")).toBeVisible();
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
  // Never skipped in CI: a missing build there has to fail, not pass quietly.
  test.skip(
    !existsSync(EXTENSION_DIR) && !process.env.CI,
    `Run "npm run build" before E2E tests: ${EXTENSION_DIR}`,
  );

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

  test("an error banner copies a report of the error to the clipboard", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await popup.goto(baseUrl);
    await seedWallet(popup, { unlocked: false });
    await popup.reload();
    await popup.getByPlaceholder("Your password").fill("wrong-password");
    await popup.getByRole("button", { name: /unlock/i }).click();
    await expect(popup.getByRole("alert")).toHaveText(/incorrect password/i);

    await popup.getByRole("button", { name: "Copy error details" }).click();
    await expect(popup.getByRole("button", { name: "Copied" })).toBeVisible();

    const report = await popup.evaluate(() => navigator.clipboard.readText());
    expect(report).toMatch(/^Error: .*incorrect password/im);
    expect(report).toMatch(/^Version: \d+\.\d+\.\d+$/m);
    expect(report).toMatch(/^Page: popup\.html/m);
    expect(report).toMatch(/^Wallet: locked$/m);
    // Nothing about the wallet behind the lock screen.
    expect(report).not.toContain(ACCOUNT.btcAddress);
  });

  test("Send report posts the report to the Hub only once confirmed, and shows its reference", async () => {
    const failedRequestId = "e2e0fa11-0000-4000-8000-000000000001";
    const reportId = "e2e0cafe-0000-4000-8000-000000000002";
    // The Hub answers 502 whenever the indexer behind it fails.
    await context.route("https://e2e.arch.network/v1/indexer/**", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        headers: { "x-request-id": failedRequestId },
        body: JSON.stringify({
          statusCode: 502,
          error: "BadGateway",
          message: "Indexer error 500 Internal Server Error (https://indexer.invalid/v1): upstream exploded",
        }),
      }),
    );
    const posted: Array<{ method: string; headers: Record<string, string>; body: string | null }> = [];
    await context.route("https://e2e.arch.network/v1/error-reports", (route) => {
      const request = route.request();
      posted.push({ method: request.method(), headers: request.headers(), body: request.postData() });
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        headers: { "x-request-id": reportId },
        body: JSON.stringify({ id: reportId }),
      });
    });
    // An error in the service worker, for the report to carry.
    await context.serviceWorkers()[0].evaluate(() => {
      setTimeout(() => {
        throw new Error("e2e background failure");
      }, 0);
    });

    await openUnlockedWallet(popup, baseUrl);
    const banner = popup.locator(".error-banner").first();
    await expect(banner.getByRole("alert")).toHaveText(/couldn't load your balances/i, { timeout: 20_000 });
    // The id of the failed request, short on screen and whole in the report.
    await expect(banner.locator(".error-banner-ref")).toHaveText("Ref e2e0fa11");

    await banner.getByRole("button", { name: "Send report" }).click();
    await expect(banner.getByText(/to the Wallet Hub at e2e\.arch\.network, where its operators can read it/)).toBeVisible();
    expect(posted).toEqual([]);

    await banner.getByRole("button", { name: "Send", exact: true }).click();
    await expect(banner.getByRole("status")).toHaveText("Report sent. Reference e2e0cafe");

    expect(posted).toHaveLength(1);
    expect(posted[0].method).toBe("POST");
    expect(posted[0].headers["x-api-key"]).toBe("e2e-key");
    expect(posted[0].headers["authorization"]).toBeUndefined();
    const body = JSON.parse(posted[0].body!);
    expect(Object.keys(body)).toEqual(["report"]);
    const report: string = body.report;
    expect(report).toMatch(/^Error: Couldn't load your balances/m);
    expect(report).toMatch(new RegExp(`^Hub request: ${failedRequestId}$`, "m"));
    expect(report).toMatch(/^Version: \d+\.\d+\.\d+$/m);
    expect(report).toMatch(/^Page: popup\.html#\/dashboard$/m);
    expect(report).toMatch(/^Wallet: testnet4, /m);
    expect(report).toMatch(/ popup WARN Hub request failed /);
    expect(report).toMatch(/ background ERROR uncaught error .*e2e background failure/);
    // Nothing that says whose wallet it is.
    for (const secret of [ACCOUNT.btcAddress, ACCOUNT.archAddress, ACCOUNT.publicKeyHex, ACCOUNT.id, ACCOUNT.label]) {
      expect(report).not.toContain(secret);
    }
  });

  test("a passkey wait says where to finish and can be cancelled", async () => {
    await stubPasskeyPage(context);
    await popup.goto(baseUrl);
    await seedWallet(popup, { unlocked: false, authMethod: "passkey" });
    await popup.reload();

    const passkeyOpened = context.waitForEvent("page");
    await popup.getByPlaceholder("Your password").fill(PASSWORD);
    await popup.getByRole("button", { name: /unlock/i }).click();

    const passkeyPage = await passkeyOpened;
    await expect(passkeyPage.getByRole("button", { name: "My passkey isn't listed" })).toBeVisible();
    await expect(popup.getByText("Waiting for your passkey")).toBeVisible();

    await popup.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => passkeyPage.isClosed()).toBe(true);
    await expect(popup.getByText("Waiting for your passkey")).toBeHidden();
    await expect(popup.locator(".app-container")).toBeVisible();
  });

  test("a wrong passkey at unlock is reported and can be retried", async () => {
    await stubPasskeyPage(context);
    // Turnkey's reply when the passkey that answered is not on the wallet's sub-org.
    await context.route("https://api.turnkey.com/**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          code: 16,
          message:
            "credential ID could not be found in organization or its parent organization organizationId=e2e-org credentialId=e2e",
          details: [{ turnkeyErrorCode: "CREDENTIAL_NOT_FOUND" }],
        }),
      }),
    );
    await popup.goto(baseUrl);
    await seedWallet(popup, { unlocked: false, authMethod: "passkey" });
    await popup.reload();

    const passkeyOpened = context.waitForEvent("page");
    await popup.getByPlaceholder("Your password").fill(PASSWORD);
    await popup.getByRole("button", { name: /unlock/i }).click();
    const passkeyPage = await passkeyOpened;
    await addPasskey(context, passkeyPage);
    await passkeyPage.getByRole("button", { name: "Continue" }).click();

    await expect(popup.getByText("Signing is not unlocked yet")).toBeVisible();
    await expect(popup.getByText(`That passkey isn't registered to "${ACCOUNT.label}"`)).toBeVisible();
    await expect(popup.locator(".app-container")).toBeVisible();

    const retryOpened = context.waitForEvent("page");
    await popup.getByRole("button", { name: "Try again" }).click();
    const retryPage = await retryOpened;
    await expect(popup.getByText("Waiting for your passkey")).toBeVisible();
    await expect(popup.getByText("Signing is not unlocked yet")).toBeHidden();

    await popup.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => retryPage.isClosed()).toBe(true);
    await expect(popup.getByText("Signing is not unlocked yet")).toBeHidden();
  });

  test("prepares a Bitcoin send entirely from deterministic indexer fixtures", async () => {
    await openUnlockedWallet(popup, baseUrl);
    await openSend(popup, baseUrl);

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
    await openUnlockedWallet(popup, baseUrl);
    await openSend(popup, baseUrl);

    await popup.getByRole("button", { name: /arch/i }).first().click();
    await popup.getByPlaceholder("Base58 address").fill("nobody-e2e.arch");
    await popup.getByPlaceholder("0.00").fill("0.001");
    await expect(popup.getByText(/Unresolved name or invalid Arch address/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(popup.getByRole("button", { name: "Review" })).toBeDisabled();
  });

  test("accepts a literal Arch address for send without name resolution", async () => {
    await openUnlockedWallet(popup, baseUrl);
    await openSend(popup, baseUrl);

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
      kind: ACCOUNT.kind,
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
