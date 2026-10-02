// Node-pool vitest config for apps/oma-vault (better-sqlite3 + mockttp need
// real Node; the root config runs workerd). The root vitest config excludes
// apps/oma-vault/** so these files are not collected twice.
//
// Run with:
//   pnpm --filter @open-managed-agents/oma-vault test

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
