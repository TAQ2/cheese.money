// Visual tier — geometry assertions on a REAL rendered page at every CSS breakpoint.
// A separate config from playwright.config.ts on purpose: this tier renders a real page at every
// breakpoint against a build or a live origin, so it must never be dragged into the e2e/CI gate.
//   npm run test:visual                                        (pre-deploy: local production build)
//   VISUAL_BASE_URL={{PROD_ORIGIN}} npm run test:visual   (post-deploy proof: served pixels)
import { defineConfig } from "@playwright/test";

// One pixel below and at/above every CSS breakpoint — tier-flip bugs hide exactly there.
const VIEWPORTS = [280, 390, 768, 1024, 1279, 1440, 1920];

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: /.*\.visual\.spec\.ts/,
  fullyParallel: true,
  retries: 0,
  timeout: 45_000, // a live origin under a parallel matrix is slower than a local e2e run
  reporter: [["list"]],
  use: {
    // Default to the local production build so the tier gates BEFORE deploy; point it at the live
    // origin for the post-deploy proof capture.
    baseURL: process.env.VISUAL_BASE_URL ?? "http://localhost:{{DEV_PORT}}",
    // animations are the #1 flake source in visual capture (BrowserContextOptions, not a
    // top-level test option — the typed config rejects the flat form).
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: VIEWPORTS.map((width) => ({
    name: `${width}px`,
    use: { viewport: { width, height: 900 } },
  })),
  // Only start a server when testing the local build; an explicit VISUAL_BASE_URL means a
  // already-running target (localhost dev server, staging, or production).
  webServer: process.env.VISUAL_BASE_URL
    ? undefined
    : {
        // Prefer a data-deterministic build (fixtures/seed, no live data source) so the geometry
        // fence never depends on today's inventory.
        command: "{{BUILD_AND_START_CMD}}",
        url: "http://localhost:{{DEV_PORT}}",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
