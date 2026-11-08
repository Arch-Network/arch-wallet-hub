import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { migrateState } from "../wallet-store";
import type { WalletAccount } from "../types";

const CANONICAL_ARCH_ADDRESS = "9futhVvDtou9SiUHUK31kQEzpR9yk81HmZrcFbtHAvFu";
const X_ONLY = Array.from(bs58.decode(CANONICAL_ARCH_ADDRESS))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const TB_TAPROOT = "tb1prmkx3hvhttcga8z0n28jalzca0wemn8fp5gaj5lncw6cy4lcrnnszpve2m";
const TB_PAYMENT = "2NBFNJTktNa7GZusGbDbGKRZTxdK9VVez3n";

function legacyXverse(overrides: Partial<WalletAccount> = {}): WalletAccount {
  return {
    id: "linked-wallet-uuid",
    label: "My Xverse",
    btcAddress: TB_TAPROOT,
    publicKeyHex: X_ONLY,
    archAddress: CANONICAL_ARCH_ADDRESS,
    kind: "external",
    turnkeyResourceId: "",
    organizationId: "",
    authMethod: "external",
    externalProvider: "xverse",
    linkedWalletId: "linked-wallet-uuid",
    verificationScheme: "bip322",
    createdAt: 1,
    ...overrides,
  } as WalletAccount;
}

describe("migrateState: linked accounts and address records", () => {
  it("leaves a pre-upgrade linked account's identity, id, and site binding untouched", () => {
    const permissions = {
      readState: true,
      signMessage: true,
      sendTransfer: false,
      signPsbt: false,
      spendingLimitSatsPerDay: 5000,
    };
    const { state } = migrateState({
      activeAccountId: "linked-wallet-uuid",
      accounts: [legacyXverse()],
      connectedSites: {
        "https://dapp.example": {
          origin: "https://dapp.example",
          connectedAt: 1,
          accountId: "linked-wallet-uuid",
          permissions,
        },
      },
    });
    const acct = state.accounts[0];
    expect(acct.id).toBe("linked-wallet-uuid");
    expect(acct.linkedWalletId).toBe("linked-wallet-uuid");
    expect(acct.btcAddress).toBe(TB_TAPROOT);
    expect(acct.archAddress).toBe(CANONICAL_ARCH_ADDRESS);
    expect(acct.addresses).toBeUndefined();
    expect(state.activeAccountId).toBe("linked-wallet-uuid");
    expect(state.connectedSites["https://dapp.example"].accountId).toBe("linked-wallet-uuid");
    expect(state.connectedSites["https://dapp.example"].permissions).toEqual(permissions);
  });

  it("keeps valid provider records and drops malformed ones", () => {
    const valid = {
      address: TB_PAYMENT,
      purposes: ["payment"],
      network: "testnet4",
      addressType: "p2sh",
      chainVerified: true,
    };
    const { state, migrated } = migrateState({
      accounts: [
        legacyXverse({
          addresses: [
            valid,
            { address: TB_TAPROOT, purposes: ["ordinals"], network: "testnet3", addressType: "p2tr", chainVerified: true },
            { address: TB_TAPROOT, purposes: ["staking"], network: "testnet4", addressType: "p2tr", chainVerified: true },
            { address: "", purposes: ["ordinals"], network: "testnet4", addressType: "p2tr", chainVerified: true },
          ] as any,
        }),
      ],
    });
    expect(migrated).toBe(true);
    expect(state.accounts[0].addresses).toEqual([valid]);
  });

  it("removes provider records from native accounts", () => {
    const { state } = migrateState({
      accounts: [
        legacyXverse({
          kind: "turnkey",
          authMethod: "passkey",
          externalProvider: undefined,
          addresses: [
            { address: TB_TAPROOT, purposes: ["ordinals"], network: "testnet4", addressType: "p2tr", chainVerified: true },
          ],
        }),
      ],
    });
    expect(state.accounts[0].addresses).toBeUndefined();
  });

  it("leaves accounts unchanged on a second run", () => {
    const first = migrateState({ accounts: [legacyXverse()] });
    const second = migrateState(JSON.parse(JSON.stringify(first.state)));
    expect(second.state.accounts).toEqual(first.state.accounts);
  });
});
