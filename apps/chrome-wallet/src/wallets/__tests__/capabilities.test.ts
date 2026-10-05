import { describe, it, expect } from "vitest";
import { signerInfo, supports, type Operation, type SignerKind } from "../capabilities";
import type { WalletAccount } from "../../state/types";

function account(overrides: Partial<WalletAccount>): WalletAccount {
  return {
    id: "acct",
    label: "Test",
    btcAddress: "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m",
    publicKeyHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    kind: "turnkey",
    turnkeyResourceId: "r",
    organizationId: "o",
    authMethod: "passkey",
    createdAt: 0,
    ...overrides,
  } as WalletAccount;
}

const ACCOUNTS: Record<SignerKind, WalletAccount> = {
  passkey: account({}),
  email: account({ authMethod: "email" }),
  xverse: account({ kind: "external", authMethod: "external", externalProvider: "xverse" }),
  unisat: account({ kind: "external", authMethod: "external", externalProvider: "unisat" }),
  watch: account({ kind: "watch", authMethod: "watch", turnkeyResourceId: "", organizationId: "" }),
};

// Mirrors docs/wallet-capability-matrix.md. Change both together.
const MATRIX: Record<Operation, Record<SignerKind, boolean>> = {
  "send.arch": { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  "send.btc": { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  "send.rune": { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  "send.inscription": { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  swap: { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  "dapp.connect": { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  "dapp.archTransfer": { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  "dapp.archMessageHash": { passkey: true, email: true, xverse: true, unisat: true, watch: false },
  "dapp.signPsbt": { passkey: true, email: true, xverse: false, unisat: false, watch: false },
};

describe("signerInfo", () => {
  it("names the signer and the approval action", () => {
    expect(signerInfo(ACCOUNTS.passkey)).toMatchObject({ label: "Passkey", approveLabel: "Approve", external: false });
    expect(signerInfo(ACCOUNTS.email)).toMatchObject({ label: "Email", approveLabel: "Approve" });
    expect(signerInfo(ACCOUNTS.xverse)).toMatchObject({ label: "Xverse", approveLabel: "Continue in Xverse", external: true });
    expect(signerInfo(ACCOUNTS.unisat)).toMatchObject({ label: "UniSat", approveLabel: "Continue in UniSat", external: true });
    expect(signerInfo(ACCOUNTS.watch)).toMatchObject({ label: "Watch-only", badge: "Watch", canSign: false });
  });
});

describe("supports", () => {
  for (const [op, row] of Object.entries(MATRIX) as Array<[Operation, Record<SignerKind, boolean>]>) {
    for (const [kind, expected] of Object.entries(row) as Array<[SignerKind, boolean]>) {
      it(`${kind} ${expected ? "can" : "cannot"} ${op}`, () => {
        const result = supports(ACCOUNTS[kind], op);
        expect(result.ok).toBe(expected);
        if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
      });
    }
  }
});
