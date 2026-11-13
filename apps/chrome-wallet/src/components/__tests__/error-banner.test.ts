// @vitest-environment happy-dom
/**
 * The error banner shows the message and can copy a report of it. The
 * report must say enough to act on and nothing that identifies the
 * wallet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

const h = vi.hoisted(() => ({
  state: null as unknown,
  stateFails: false,
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
  getRecentLogs: () => [
    { ts: Date.parse("2026-11-13T11:59:59.000Z"), level: "warn", msg: "hub request failed", extra: { status: 503 } },
  ],
}));

const { default: ErrorBanner } = await import("../ErrorBanner");

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
  initialized: true,
  locked: false,
  network: "testnet4",
  activeAccountId: ACCOUNT.id,
  accounts: [ACCOUNT],
};

let root: Root | null = null;
let copied: string[] = [];
let clipboardFails = false;

const settle = () => new Promise((r) => setTimeout(r, 20));

function mount(props: { message: string; id?: string }) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  flushSync(() => root!.render(createElement(ErrorBanner, props)));
  return el;
}

async function clickCopy(el: HTMLElement) {
  el.querySelector("button")!.click();
  await settle();
}

describe("ErrorBanner", () => {
  beforeEach(() => {
    h.state = unlockedState;
    h.stateFails = false;
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

  afterEach(() => {
    root?.unmount();
    root = null;
    document.body.innerHTML = "";
  });

  it("announces the message, not the copy button", () => {
    const el = mount({ message: "Wallet Hub error 503", id: "unlock-error" });
    const alert = el.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("Wallet Hub error 503");
    expect(alert.id).toBe("unlock-error");
    expect(el.querySelector(".error-banner button")?.textContent).toBe("Copy error details");
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

  it("says so when the clipboard refuses", async () => {
    clipboardFails = true;
    const el = mount({ message: "Wallet Hub error 503" });
    await clickCopy(el);
    expect(copied).toEqual([]);
    expect(el.querySelector("button")?.textContent).toBe("Couldn't copy");
  });
});
