import { defineConfig } from "vitest/config";

// On-demand live integration tests. These hit the real COROS API and are NOT part
// of `npm test` (the default run only matches *.test.ts). Run with `npm run test:integration`
// and credentials in the environment:
//   COROS_TOKEN=... COROS_USERID=... COROS_REGION=us npm run test:integration
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.integration.ts"],
    testTimeout: 30000, // real network round trips
    hookTimeout: 30000,
  },
});
