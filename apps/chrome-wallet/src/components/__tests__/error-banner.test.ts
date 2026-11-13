// @vitest-environment happy-dom
/**
 * The error banner shows the message and can copy a report of it or
 * send it to the Hub. The report must say enough to act on and nothing
 * that identifies the wallet, and it must go nowhere until the user
 * says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const h = vi.hoisted(() => ({
  state: null as unknown,
  stateFails: false,
  pageLogs: [] as unknown[],
  logged: [] as Array<{ level: string; msg: string; extra: unknown }>,
  sent: [] as Array<{ report: string }>,
  sendFails: null as unknown,
}));

vi.mock("../../state/wallet-store", () => ({
  walletStore: {
    getState: async () => {
      if (h.stateFails) throw new Error("storage unavailable");
      return h.state;
    },
  },
}));

// log.ts lazily imports the optional `@sentry/browser`, which the DOM
// environment's import analysis refuses to resolve.
vi.mock("../../utils/log", () => ({
  GET_RECENT_LOGS_MESSAGE: "GET_RECENT_LOGS",
  getRecentLogs: () => h.pageLogs,
  log: {
    warn: (msg: string, extra: unknown) => h.logged.push({ level: "warn", msg, extra }),
    error: (msg: string, extra: unknown) => h.logged.push({ level: "error", msg, extra }),
  },
}));

vi.mock("../../utils/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/sdk")>()),
  getClient: async () => ({
    submitErrorReport: async (body: { report: string }) => {
      h.sent.push(body);
      if (h.sendFails) throw h.sendFails;
      return { id: SENT_ID };
    },
  }),
}));

const { default: ErrorBanner } = await import("../ErrorBanner");
const { default: AppErrorBoundary } = await import("../AppErrorBoundary");
const { rememberHubFailure } = await import("../../utils/hub-error");
const { WalletHubError } = await import("@arch-network/wallet-hub-sdk");

const SENT_ID = "9c2f1a7e-51b3-4d6a-8a43-0b6f2d7c1e55";
const REQUEST_ID = "4b1f6d0e-8a55-4c0e-9c1b-2f7f3a401e29";
const PAGE_LOG = {
  ts: Date.parse("2026-11-13T11:59:59.000Z"),
  level: "warn",
  msg: "hub request failed",
  extra: { status: 503 },
};

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;

const ACCOUNT = {
  id: "acct-secret-id",
  kind: "turnkey",
  authMethod: "passkey",
  label: "Savings wallet",
  btcAddress: "tb1pwalletaddress",
  archAddress: "ArchWalletAddress",
  publicKeyHex: "02abcdef",
};

const unlockedState = {
  hubBaseUrl: "https://hub.example.test/",
  initialized: true,
  locked: false,
  network: "testnet4",
  activeAccountId: ACCOUNT.id,
  accounts: [ACCOUNT],
};

let root: Root | null = null;
let copied: string[] = [];
let clipboardFails = false;
/** What the background answers a page asking for its log. */
let background: (message: unknown) => Promise<unknown>;

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function render(node: ReturnType<typeof createElement>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  flushSync(() => root!.render(node));
  return el;
}

function mount(props: { message: string; id?: string }) {
  return render(createElement(ErrorBanner, props));
}

function button(el: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll("button")].find((b) => b.textContent === label);
}

async function click(el: HTMLElement, label: string) {
  button(el, label)!.click();
  await settle();
}

const clickCopy = (el: HTMLElement) => click(el, "Copy error details");

beforeEach(() => {
  h.state = unlockedState;
  h.stateFails = false;
  h.pageLogs = [PAGE_LOG];
  h.logged = [];
  h.sent = [];
  h.sendFails = null;
  background = async () => ({ logs: [] });
  (globalThis as any).chrome = { runtime: { sendMessage: (message: unknown) => background(message) } };
});

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  delete (globalThis as any).chrome;
  vi.restoreAllMocks();
});

describe("ErrorBanner", () => {
  beforeEach(() => {
    copied = [];
    clipboardFails = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (clipboardFails) throw new Error("clipboard blocked");
          copied.push(text);
        },
      },
    });
    window.location.hash = "#/send?asset=btc&to=tb1precipient&amount=5";
  });

  it("announces the message, not the copy button", () => {
    const el = mount({ message: "Wallet Hub error 503", id: "unlock-error" });
    const alert = el.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("Wallet Hub error 503");
    expect(alert.id).toBe("unlock-error");
    expect(el.querySelector(".error-banner button")?.textContent).toBe("Copy error details");
    expect(el.querySelector(".error-banner-ref")).toBeNull();
  });

  it("shows a short reference for an error that came from a Hub response, and copies the whole id", async () => {
    rememberHubFailure({ requestId: REQUEST_ID, bodyMessage: "Turnkey is not reachable" });
    const el = mount({ message: "WalletHub error 503 : ServiceUnavailable: Turnkey is not reachable", id: "e" });

    expect(el.querySelector(".error-banner-ref")?.textContent).toBe("Ref 4b1f6d0e");
    expect(el.querySelector('[role="alert"]')?.textContent).not.toContain("4b1f6d0e");

    await clickCopy(el);
    expect(copied[0]).toMatch(new RegExp(`^Hub request: ${REQUEST_ID}$`, "m"));
  });

  it("logs each error it shows once, however often the screen shows it", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_800_000_000_000);
    rememberHubFailure({ requestId: REQUEST_ID, bodyMessage: "Indexer is down" });

    mount({ message: "Hub indexer GET /arch/tokens 502 : Indexer is down" });
    root?.unmount();
    mount({ message: "Hub indexer GET /arch/tokens 502 : Indexer is down" });
    root?.unmount();
    mount({ message: "Enter an amount" });
    await settle();

    expect(h.logged).toEqual([
      {
        level: "warn",
        msg: "Error shown",
        extra: { message: "Hub indexer GET /arch/tokens 502 : Indexer is down", requestId: REQUEST_ID },
      },
      { level: "warn", msg: "Error shown", extra: { message: "Enter an amount", requestId: undefined } },
    ]);

    // Shown again a minute later, it is a new occurrence.
    now.mockReturnValue(1_800_000_000_000 + 61_000);
    root?.unmount();
    mount({ message: "Enter an amount" });
    await settle();
    expect(h.logged).toHaveLength(3);
  });

  it("copies the error with the build, screen, signer and recent log", async () => {
    const el = mount({ message: "Wallet Hub error 503" });
    await clickCopy(el);

    expect(copied).toHaveLength(1);
    const report = copied[0];
    expect(report).toContain("Error: Wallet Hub error 503");
    expect(report).toMatch(/^Version: \S+$/m);
    expect(report).toMatch(/^Page: \S*#\/send$/m);
    expect(report).toContain("Wallet: testnet4, Passkey");
    expect(report).toContain('WARN hub request failed {"status":503}');
    expect(el.querySelector("button")?.textContent).toBe("Copied");
  });

  it("leaves out everything that identifies the wallet or the transfer", async () => {
    // What the session code logs once the wallet is unlocked.
    h.pageLogs = [PAGE_LOG, { ts: PAGE_LOG.ts, level: "info", msg: "hub-session.minted", extra: { accountId: ACCOUNT.id } }];
    const el = mount({ message: "Wallet Hub error 503" });
    await clickCopy(el);

    const report = copied[0];
    for (const secret of [
      ACCOUNT.id,
      ACCOUNT.label,
      ACCOUNT.btcAddress,
      ACCOUNT.archAddress,
      ACCOUNT.publicKeyHex,
      "tb1precipient",
      "amount",
    ]) {
      expect(report).not.toContain(secret);
    }
  });

  it("reports a locked wallet without a network or signer", async () => {
    h.state = { initialized: true, locked: true, network: "mainnet", accounts: [] };
    const el = mount({ message: "Wrong password" });
    await clickCopy(el);
    expect(copied[0]).toMatch(/^Wallet: locked$/m);
  });

  it("still copies the error when the wallet state cannot be read", async () => {
    h.stateFails = true;
    const el = mount({ message: "Storage is unavailable" });
    await clickCopy(el);
    expect(copied[0]).toContain("Error: Storage is unavailable");
    expect(copied[0]).toMatch(/^Wallet: unknown$/m);
  });

  it("merges the background's log into the report by time, naming where each line came from", async () => {
    background = async (message) => {
      expect(message).toEqual({ type: "GET_RECENT_LOGS" });
      return {
        logs: [
          { ts: Date.parse("2026-11-13T11:59:58.000Z"), level: "error", msg: "uncaught error" },
          { ts: Date.parse("2026-11-13T12:00:01.000Z"), level: "error", msg: "unhandled promise rejection" },
        ],
      };
    };
    window.history.replaceState(null, "", "/sidepanel.html#/send");
    const el = mount({ message: "Wallet Hub error 503" });
    await clickCopy(el);
    window.history.replaceState(null, "", "/");

    expect(copied[0].split("\n").slice(-4)).toEqual([
      "Recent log (3):",
      "[2026-11-13T11:59:58.000Z] background ERROR uncaught error",
      '[2026-11-13T11:59:59.000Z] sidepanel WARN hub request failed {"status":503}',
      "[2026-11-13T12:00:01.000Z] background ERROR unhandled promise rejection",
    ]);
  });

  it.each([
    ["cannot be reached", async () => Promise.reject(new Error("Could not establish connection"))],
    ["does not know the message", async () => ({ success: false, error: "Unknown message type: GET_RECENT_LOGS" })],
    ["answers nothing", async () => undefined],
  ])("still copies this page's log when the background %s", async (_why, answer) => {
    background = answer;
    const el = mount({ message: "Wallet Hub error 503" });
    await clickCopy(el);
    expect(copied[0]).toContain("Recent log (1):");
    expect(copied[0]).toContain('WARN hub request failed {"status":503}');
  });

  it("does not wait for a background that never answers", async () => {
    background = () => new Promise(() => {});
    const el = mount({ message: "Wallet Hub error 503" });
    button(el, "Copy error details")!.click();
    await settle(1_200);
    expect(copied[0]).toContain("Recent log (1):");
  });

  it("says so when the clipboard refuses", async () => {
    clipboardFails = true;
    const el = mount({ message: "Wallet Hub error 503" });
    await clickCopy(el);
    expect(copied).toEqual([]);
    expect(el.querySelector("button")?.textContent).toBe("Couldn't copy");
  });
});

describe("Send report", () => {
  it("sends nothing until the user has read what is sent and where, and confirmed", async () => {
    const el = mount({ message: "Wallet Hub error 503" });
    await settle();
    expect(h.sent).toEqual([]);

    await click(el, "Send report");
    expect(h.sent).toEqual([]);
    const statement = el.querySelector(".error-report-confirm p")!.textContent!;
    expect(statement).toContain("to the Wallet Hub at hub.example.test");
    expect(statement).toContain("where its operators can read it");
    for (const part of ["app version", "screen", "network", "wallet type", "browser", "recent diagnostic log"]) {
      expect(statement).toContain(part);
    }
    // This error did not come from a Hub response, so there is no reference to send.
    expect(statement).not.toContain("reference");

    await click(el, "Cancel");
    expect(h.sent).toEqual([]);
    expect(el.querySelector(".error-report-confirm")).toBeNull();
    expect(button(el, "Send report")).toBeDefined();
  });

  it("sends the same report it would copy, and shows the reference the Hub answered with", async () => {
    rememberHubFailure({ requestId: REQUEST_ID, bodyMessage: "Signing service is unavailable" });
    h.pageLogs = [PAGE_LOG, { ts: PAGE_LOG.ts, level: "info", msg: "hub-session.minted", extra: { accountId: ACCOUNT.id } }];
    window.location.hash = "#/send?to=tb1precipient";
    const el = mount({ message: "WalletHub error 503 : Signing service is unavailable" });
    await click(el, "Send report");
    expect(el.querySelector(".error-report-confirm p")!.textContent).toContain(
      "Sends this error and the reference of the failed request, with the app version,",
    );
    await click(el, "Send");

    expect(h.sent).toHaveLength(1);
    const lines = h.sent[0].report.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "Arch Wallet error report",
      "Error: WalletHub error 503 : Signing service is unavailable",
      `Hub request: ${REQUEST_ID}`,
    ]);
    expect(h.sent[0].report).toMatch(/^Page: \S*#\/send$/m);
    expect(h.sent[0].report).toContain("Wallet: testnet4, Passkey");
    expect(h.sent[0].report).toContain('WARN hub request failed {"status":503}');
    for (const secret of [ACCOUNT.id, ACCOUNT.label, ACCOUNT.btcAddress, ACCOUNT.archAddress, "tb1precipient"]) {
      expect(h.sent[0].report).not.toContain(secret);
    }

    expect(el.querySelector('[role="status"]')?.textContent).toBe("Report sent. Reference 9c2f1a7e");
    // One report per confirmation: there is nothing left to press.
    expect(button(el, "Send")).toBeUndefined();
    expect(button(el, "Send report")).toBeUndefined();
  });

  it("drops the oldest log lines so the report is one the Hub accepts", async () => {
    h.pageLogs = Array.from({ length: 300 }, (_, i) => ({
      ts: Date.parse("2026-11-13T11:00:00.000Z") + i * 1000,
      level: "warn",
      msg: `Hub request failed "${i}"`,
      extra: { status: 502, route: "/v1/indexer/arch/accounts/:id" },
    }));
    const el = mount({ message: "Wallet Hub error 503" });
    await click(el, "Send report");
    await click(el, "Send");

    const { report } = h.sent[0];
    expect(new TextEncoder().encode(JSON.stringify(report)).length).toBeLessThanOrEqual(12_000);
    expect(report).toMatch(/^Recent log \(latest \d+, \d+ older left out\):$/m);
    expect(report).toContain('Hub request failed "299"');
    expect(report).not.toContain('Hub request failed "0"');
  });

  it("says so when the report could not be sent, and lets the user try again", async () => {
    h.sendFails = new Error("Failed to fetch");
    const el = mount({ message: "Wallet Hub error 503" });
    await click(el, "Send report");
    await click(el, "Send");

    expect(el.querySelector('[role="status"]')?.textContent).toBe(
      "Couldn't send the report. Copy the details instead.",
    );
    expect(button(el, "Send report")).toBeDefined();
  });

  it("says when too many reports were sent", async () => {
    h.sendFails = new WalletHubError("WalletHub error 429 : TooManyRequests", 429, undefined);
    const el = mount({ message: "Wallet Hub error 503" });
    await click(el, "Send report");
    await click(el, "Send");

    expect(el.querySelector('[role="status"]')?.textContent).toBe(
      "Too many reports were sent recently. Copy the details instead.",
    );
  });
});

describe("AppErrorBoundary", () => {
  function Broken(): never {
    throw new TypeError("Cannot read properties of undefined (reading 'balance')");
  }

  it("shows its children while they render", () => {
    const el = render(createElement(AppErrorBoundary, null, createElement("p", null, "Dashboard")));
    expect(el.textContent).toBe("Dashboard");
  });

  it("shows a crash with the copy and send actions, and logs it, where the screen would go blank", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = render(createElement(AppErrorBoundary, null, createElement(Broken)));
    await settle();

    expect(el.querySelector("h1")?.textContent).toBe("Something went wrong");
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      "Cannot read properties of undefined (reading 'balance')",
    );
    expect(button(el, "Copy error details")).toBeDefined();
    expect(button(el, "Reload")).toBeDefined();

    const crash = h.logged.find((entry) => entry.msg === "Render crash");
    expect(crash?.level).toBe("error");
    expect(crash?.extra).toBeInstanceOf(TypeError);

    await click(el, "Send report");
    await click(el, "Send");
    expect(h.sent[0].report).toContain("Error: Cannot read properties of undefined (reading 'balance')");
    expect(el.querySelector('[role="status"]')?.textContent).toBe("Report sent. Reference 9c2f1a7e");
  });
});
