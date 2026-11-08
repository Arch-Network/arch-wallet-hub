import { describe, it, expect } from "vitest";
import { resolveOriginSigningAccount } from "../origin-account";
import type { AppState, ConnectedSite, WalletAccount } from "../../state/types";

const account = (id: string, btcAddress = `tb1p-${id}`): WalletAccount =>
  ({ id, label: `Wallet ${id}`, btcAddress, publicKeyHex: `pk-${id}`, kind: "turnkey" }) as WalletAccount;

const site = (accountId: string): ConnectedSite => ({
  origin: "https://dapp.example",
  connectedAt: 0,
  accountId,
});

function state(
  activeAccountId: string | null,
  connectedSites: Record<string, ConnectedSite>,
): Pick<AppState, "accounts" | "activeAccountId" | "connectedSites"> {
  return { accounts: [account("a"), account("b")], activeAccountId, connectedSites };
}

const ORIGIN = "https://dapp.example";

describe("resolveOriginSigningAccount", () => {
  it("signs with the bound account when it is also the active one", () => {
    const res = resolveOriginSigningAccount(state("a", { [ORIGIN]: site("a") }), ORIGIN);
    expect(res).toEqual({ ok: true, account: account("a") });
  });

  it("refuses when the bound account is not the active one, and names the bound account", () => {
    const res = resolveOriginSigningAccount(state("a", { [ORIGIN]: site("b") }), ORIGIN);
    expect(res.ok).toBe(false);
    expect(res.account).toEqual(account("b"));
    if (!res.ok) expect(res.reason).toMatch(/Wallet b/);
  });

  it("never falls back to the active account for an unknown or empty binding", () => {
    for (const accountId of ["gone", ""]) {
      const res = resolveOriginSigningAccount(state("a", { [ORIGIN]: site(accountId) }), ORIGIN);
      expect(res).toMatchObject({ ok: false, account: null });
    }
  });

  it("refuses an origin that is not connected", () => {
    const res = resolveOriginSigningAccount(state("a", {}), ORIGIN);
    expect(res).toMatchObject({ ok: false, account: null });
  });

  it("refuses when no account is active", () => {
    const res = resolveOriginSigningAccount(state(null, { [ORIGIN]: site("a") }), ORIGIN);
    expect(res).toMatchObject({ ok: false, account: account("a") });
  });

  it("resolves legacy bindings that stored the btcAddress in accountId", () => {
    const res = resolveOriginSigningAccount(state("b", { [ORIGIN]: site("tb1p-b") }), ORIGIN);
    expect(res).toEqual({ ok: true, account: account("b") });
  });
});
