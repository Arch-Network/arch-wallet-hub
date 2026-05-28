import { describe, it, expect } from "vitest";
import {
  LEAKED_INDEXER_API_KEY,
  migrateApiConfig,
} from "../wallet-store";
import { DEFAULT_INDEXER_API_KEY } from "../../utils/explorer-config";
import { INDEXER_BASE_URL } from "../../utils/explorer-config";

// Minimal stand-in for AppState shape. migrateApiConfig only reads
// the api-config fields, so the rest can stay empty / undefined.
function makeState(overrides: Record<string, unknown> = {}): any {
  return {
    hubBaseUrl: "https://hub.arch.network",
    hubApiKey: "valid-current-hub-key",
    indexerBaseUrl: INDEXER_BASE_URL,
    indexerApiKey: undefined,
    ...overrides,
  };
}

describe("migrateApiConfig — indexer key", () => {
  it("fills in a missing indexer key with the build-time default", () => {
    const state = makeState({ indexerApiKey: undefined });
    const migrated = migrateApiConfig(state);
    expect(state.indexerApiKey).toBe(DEFAULT_INDEXER_API_KEY);
    expect(migrated).toBe(true);
  });

  it("snaps users off the leaked v0.1.5-v0.2.0 indexer key", () => {
    const state = makeState({ indexerApiKey: LEAKED_INDEXER_API_KEY });
    const migrated = migrateApiConfig(state);
    expect(state.indexerApiKey).toBe(DEFAULT_INDEXER_API_KEY);
    expect(state.indexerApiKey).not.toBe(LEAKED_INDEXER_API_KEY);
    expect(migrated).toBe(true);
  });

  it("preserves a user-supplied custom key untouched", () => {
    const custom = "arch_live_some-user-specific-privileged-key";
    const state = makeState({ indexerApiKey: custom });
    migrateApiConfig(state);
    expect(state.indexerApiKey).toBe(custom);
  });

  it("preserves the build-time default when it's already set", () => {
    const state = makeState({ indexerApiKey: DEFAULT_INDEXER_API_KEY });
    migrateApiConfig(state);
    expect(state.indexerApiKey).toBe(DEFAULT_INDEXER_API_KEY);
  });

  it("the leaked key constant is the exact v0.1.5-v0.2.0 hardcoded value", () => {
    // Regression: if someone "improves" the constant they will silently
    // break the migration for every existing install. Lock the literal
    // here so any future edit shows up as a test diff that needs
    // explicit justification.
    expect(LEAKED_INDEXER_API_KEY).toBe(
      "arch_live_28FvKem4QudQx0uczFunu4plqIo1rwWpiajtkrkj2PVhSllF",
    );
  });
});
