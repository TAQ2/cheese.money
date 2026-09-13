// @effect-diagnostics nodeBuiltinImport:off - Host-side test setup drives the filesystem directly.

/**
 * Boot, seed and pair — once per run, before the first test.
 *
 * The stack, the fixtures and the pairing exchange are the visual harness's
 * own (`scripts/visual/`): there is one way to boot a private CH3 stack in
 * this repo and this suite uses it rather than growing a second one. What is
 * added here is only the hand-off to the tests — the stack's address and the
 * seeded ids go to `artifacts/e2e/stack.json`, the paired session cookie to a
 * Playwright storage state file — and the teardown that kills the stack's
 * process group when the run ends.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { chromium, request } from "@playwright/test";

import { exchangePairingCredential } from "../scripts/visual/browser.ts";
import { seedVisualFixtures } from "../scripts/visual/fixtures.ts";
import { issuePairingCredential, startDevStack } from "../scripts/visual/stack.ts";
import { E2E_ARTIFACTS_DIR, REPO_ROOT, STACK_INFO_PATH, type StackInfo } from "./fixtures.ts";

const STACK_HOME_DIR = NodePath.join(E2E_ARTIFACTS_DIR, "stack-home");
const STACK_LOG_PATH = NodePath.join(E2E_ARTIFACTS_DIR, "dev-stack.log");
const STORAGE_STATE_PATH = NodePath.join(E2E_ARTIFACTS_DIR, "storage-state.json");
/** Seeds the port offset, so this stack never collides with a hand-run or visual one. */
const DEV_INSTANCE = "ch3-e2e";
const BOOT_TIMEOUT_MS = 240_000;

/**
 * The warm-up's own bound, per call.
 *
 * Nothing else bounds it. {@link BOOT_TIMEOUT_MS} belongs to `startDevStack`
 * and is spent before this runs, and `playwright.config.ts` sets no
 * `globalTimeout`, so a warm-up left on Playwright's 30s default was the only
 * thing in global setup that could fail a run — and it did, being SHORTER than
 * the 60s per-test budget it exists to protect.
 *
 * So: comfortably above that per-test budget, because a warm-up that is merely
 * slow must not fail a run a test would have survived; and finite, because a
 * dev server that never answers must not hang CI forever.
 */
const PER_TEST_TIMEOUT_MS = 60_000;
const WARMUP_TIMEOUT_MS = PER_TEST_TIMEOUT_MS * 2;

export default async function globalSetup(): Promise<() => Promise<void>> {
  // A fresh home per run is what makes the fixtures deterministic; the log is
  // kept because CI uploads it when the run fails.
  await NodeFSP.rm(STACK_HOME_DIR, { recursive: true, force: true });
  await NodeFSP.rm(STACK_INFO_PATH, { force: true });
  await NodeFSP.rm(STORAGE_STATE_PATH, { force: true });
  await NodeFSP.mkdir(E2E_ARTIFACTS_DIR, { recursive: true });

  const stack = await startDevStack({
    repoRoot: REPO_ROOT,
    homeDir: STACK_HOME_DIR,
    instance: DEV_INSTANCE,
    logPath: STACK_LOG_PATH,
    timeoutMs: BOOT_TIMEOUT_MS,
  });
  try {
    if (stack.stateDir === null) {
      throw new Error("The booted stack reported no state directory.");
    }
    const fixtures = await seedVisualFixtures({ stateDir: stack.stateDir });

    // The same exchange the pairing screen performs, on a request context whose
    // cookie jar becomes every test's storage state.
    const credential = await issuePairingCredential({
      repoRoot: REPO_ROOT,
      stateDir: stack.stateDir,
      webUrl: stack.webUrl,
    });
    const api = await request.newContext({ baseURL: stack.webUrl });
    try {
      await exchangePairingCredential({ request: api, webUrl: stack.webUrl, credential });
      const session = await api.get("/api/auth/session");
      if (!(await session.text()).includes('"authenticated":true')) {
        throw new Error("Pairing succeeded but the session is still unauthenticated.");
      }
      await api.storageState({ path: STORAGE_STATE_PATH });
    } finally {
      await api.dispose();
    }

    // Vite's dev server compiles a route's module graph on its first request.
    // Left uncompiled, that cost lands on whichever test first navigates to a
    // thread — cheap on a fast machine, but enough on a loaded CI runner to
    // occasionally blow past a single test's 60s budget. Paying it here takes
    // it off every test's clock and keeps their timing deterministic whatever
    // order they run in.
    //
    // Both timeouts are stated rather than defaulted, and the reason is in
    // WARMUP_TIMEOUT_MS: Playwright's 30s default is shorter than the budget
    // this exists to protect, so the fix for a flake became a failure of its
    // own on a loaded runner — which is exactly what CI showed.
    const warmupBrowser = await chromium.launch();
    try {
      const warmupPage = await warmupBrowser.newPage({ storageState: STORAGE_STATE_PATH });
      await warmupPage.goto(`${stack.webUrl}/${fixtures.environmentId}/${fixtures.threadId}`, {
        timeout: WARMUP_TIMEOUT_MS,
      });
      await warmupPage
        .getByTestId("composer-editor")
        .waitFor({ state: "visible", timeout: WARMUP_TIMEOUT_MS });
    } finally {
      await warmupBrowser.close();
    }

    const info: StackInfo = {
      webUrl: stack.webUrl,
      stateDir: stack.stateDir,
      logPath: STACK_LOG_PATH,
      environmentId: fixtures.environmentId,
      threadId: fixtures.threadId,
      longThreadId: fixtures.longThreadId,
      storageStatePath: STORAGE_STATE_PATH,
    };
    await NodeFSP.writeFile(STACK_INFO_PATH, `${JSON.stringify(info, null, 2)}\n`);
    process.stdout.write(
      `[e2e] stack ready at ${stack.webUrl} · ${String(fixtures.threadCount)} threads seeded (environment ${fixtures.environmentId})\n`,
    );
  } catch (error) {
    await stack.stop();
    throw error;
  }

  return async () => {
    await stack.stop();
  };
}
