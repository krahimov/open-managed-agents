// Vitest config local to @open-managed-agents/sandbox.
//
// The root vitest.config.ts pins everything to @cloudflare/vitest-pool-
// workers (workerd). The Daytona adapter and its fakes are Node-only code
// (dynamic-imports @daytonaio/sdk, Buffer-backed file syncs, real timers),
// so its tests run in the Node "forks" pool instead — same convention as
// apps/main-node and packages/session-runtime. The root config excludes
// packages/sandbox/tests/** so these files are not collected twice.
//
// Run with:
//   pnpm --filter @open-managed-agents/sandbox test

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
