import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror the build-time `define` tokens from wxt.config.ts so any
  // module that touches `state/types` at value-level (not just type-
  // level) doesn't ReferenceError on the unresolved bare identifier.
  // Tests never need the real keys; an empty string is fine.
  define: {
    __ARCH_BUILD_HUB_API_KEY__: JSON.stringify(""),
    __ARCH_BUILD_INDEXER_API_KEY__: JSON.stringify(""),
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
