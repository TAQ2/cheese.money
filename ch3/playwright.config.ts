import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e suite: the real web client in Chromium against a real, freshly booted
 * CH3 stack seeded with deterministic fixtures. `e2e/global-setup.ts` boots
 * the stack, seeds it and pairs a browser session before the first test;
 * `e2e/README.md` explains how to run, extend and debug it.
 *
 * One worker, no retries, by design: the tests share one stack and one
 * database, and a test that only passes on its second attempt is a bug in the
 * test, not a flake to paper over.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Generated output lives beside the visual harness's, outside every package's
  // compile graph — see the note on ARTIFACTS_DIR in scripts/visual/visual.ts.
  outputDir: "./artifacts/e2e/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ...(process.env.CI ? ([["github"]] as const) : []),
    ["list"],
    ["html", { outputFolder: "./artifacts/e2e/report", open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    contextOptions: { reducedMotion: "reduce" },
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium" }],
});
