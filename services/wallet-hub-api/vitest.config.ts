import { defineConfig } from "vitest/config";

// Scoped to unit tests that don't require Postgres. Integration
// suites that need a running DB can be added later under
// `test/integration/**` with their own config opting in to a
// docker-compose'd PG and skipped in plain `npm test`.
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
