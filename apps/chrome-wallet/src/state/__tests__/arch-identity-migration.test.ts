import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { migrateState } from "../wallet-store";
import type { WalletAccount } from "../types";

/**
 * Real-world vector from the Unisat derivation bug report:
 * canonical (untweaked internal key) vs wrongly-registered (BIP-341 tweaked
 * output key decoded from the taproot address).
 */
const CANONICAL_ARCH_ADDRESS = "9futhVvDtou9SiUHUK31kQEzpR9yk81HmZrcFbtHAvFu";
const TWEAKED_ARCH_ADDRESS = "9uCzmLZXTdKQup3MenMwr2UdozfXp2R4xXzVarQTnhT5";
const canonicalXOnlyHex = Array.from(bs58.decode(CANONICAL_ARCH_ADDRESS))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

function externalAccount(overrides: Partial<WalletAccount>): WalletAccount {
  return {
    id: "lw-1",
    label: "UniSat Wallet",
    btcAddress: "bc1p...",
    publicKeyHex: canonicalXOnlyHex,
    kind: "external",
    turnkeyResourceId: "",
    organizationId: "",
    authMethod: "external",
    externalProvider: "unisat",
    createdAt: 0,
    ...overrides,
  } as WalletAccount;
}

describe("deriveArchAccountAddress (canonical identity)", () => {
  it("derives the canonical (untweaked) identity from the x-only pubkey", () => {
    expect(deriveArchAccountAddress(canonicalXOnlyHex)).toBe(CANONICAL_ARCH_ADDRESS);
  });

  it("drops the parity byte of a compressed 33-byte key", () => {
    expect(deriveArchAccountAddress(`02${canonicalXOnlyHex}`)).toBe(CANONICAL_ARCH_ADDRESS);
    expect(deriveArchAccountAddress(`03${canonicalXOnlyHex}`)).toBe(CANONICAL_ARCH_ADDRESS);
  });

  it("never equals the tweaked output key registered by the old bug", () => {
    expect(deriveArchAccountAddress(canonicalXOnlyHex)).not.toBe(TWEAKED_ARCH_ADDRESS);
  });
});

describe("migrateState: external-account canonical Arch identity repair", () => {
  it("rewrites a tweaked archAddress to canonical and preserves the old value", () => {
    const { state, migrated } = migrateState({
      accounts: [externalAccount({ archAddress: TWEAKED_ARCH_ADDRESS })],
    });
    const acct = state.accounts[0];
    expect(migrated).toBe(true);
    expect(acct.archAddress).toBe(CANONICAL_ARCH_ADDRESS);
    expect(acct.legacyArchAddress).toBe(TWEAKED_ARCH_ADDRESS);
  });

  it("is idempotent: a second run changes nothing", () => {
    const first = migrateState({
      accounts: [externalAccount({ archAddress: TWEAKED_ARCH_ADDRESS })],
    });
    const second = migrateState(JSON.parse(JSON.stringify(first.state)));
    const acct = second.state.accounts[0];
    expect(acct.archAddress).toBe(CANONICAL_ARCH_ADDRESS);
    expect(acct.legacyArchAddress).toBe(TWEAKED_ARCH_ADDRESS);
  });

  it("keeps the first legacy value if archAddress drifts again", () => {
    const { state } = migrateState({
      accounts: [
        externalAccount({
          archAddress: "SomeOtherWrongValue11111111111111111111111",
          legacyArchAddress: TWEAKED_ARCH_ADDRESS,
        }),
      ],
    });
    const acct = state.accounts[0];
    expect(acct.archAddress).toBe(CANONICAL_ARCH_ADDRESS);
    expect(acct.legacyArchAddress).toBe(TWEAKED_ARCH_ADDRESS);
  });

  it("leaves accounts already on the canonical identity untouched", () => {
    const { state } = migrateState({
      accounts: [externalAccount({ archAddress: CANONICAL_ARCH_ADDRESS })],
    });
    const acct = state.accounts[0];
    expect(acct.archAddress).toBe(CANONICAL_ARCH_ADDRESS);
    expect(acct.legacyArchAddress).toBeUndefined();
  });

  it("does not touch non-external accounts", () => {
    const { state } = migrateState({
      accounts: [
        {
          ...externalAccount({ archAddress: TWEAKED_ARCH_ADDRESS }),
          kind: "turnkey",
          authMethod: "passkey",
          externalProvider: undefined,
        },
      ],
    });
    const acct = state.accounts[0];
    expect(acct.archAddress).toBe(TWEAKED_ARCH_ADDRESS);
    expect(acct.legacyArchAddress).toBeUndefined();
  });
});
