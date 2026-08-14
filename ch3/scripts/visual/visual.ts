#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off - Host-side screenshot harness drives Node subprocesses, timers, and the filesystem directly.

/**
 * CH3 visual testing suite.
 *
 *   npm run visual            # capture every view, compare against baselines
 *   npm run visual:update     # accept the current rendering as the baseline
 *
 * The run is self-contained: it boots its own dev stack on its own ports in its
 * own state directory, pairs itself, seeds deterministic fixtures, captures each
 * surface, asserts structure plus a clean console, diffs against the baseline,
 * and tears the stack down again. See README.md.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import {
  ensureAuthenticated,
  launchVisualBrowser,
  type VisualBrowser,
  type Viewport,
} from "./browser.ts";
import { comparePngBuffers, DEFAULT_RATIO_TOLERANCE, type ComparisonResult } from "./compare.ts";
import { seedVisualFixtures, VISUAL_THREAD_ID, type VisualFixtures } from "./fixtures.ts";
import { attachDevStack, issuePairingCredential, startDevStack, type DevStack } from "./stack.ts";
import { VISUAL_VIEWS, VOLATILE_SELECTORS, type ViewContext, type ViewSpec } from "./views.ts";

const SUITE_DIR = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO_ROOT = NodePath.resolve(SUITE_DIR, "../..");
/**
 * Generated state lives at the repo root, beside the App Store screenshots, and
 * deliberately NOT under `scripts/visual/`. A run seeds a workspace containing
 * real source files; inside `scripts/` those files join the package's own
 * compile graph and `tsgo --noEmit` fails on them (gitignore does not shield
 * tsc). Keeping the output outside every package's globs is what makes the
 * suite safe to run before a typecheck.
 */
const ARTIFACTS_DIR = NodePath.join(REPO_ROOT, "artifacts/visual");
const BASELINE_DIR = NodePath.join(ARTIFACTS_DIR, "baselines");
const RUNS_DIR = NodePath.join(ARTIFACTS_DIR, "runs");
const STACK_HOME_DIR = NodePath.join(ARTIFACTS_DIR, "stack-home");
const STORAGE_STATE_PATH = NodePath.join(ARTIFACTS_DIR, "storage-state.json");
const DEV_INSTANCE = "ch3-visual";
const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };

interface CliOptions {
  readonly update: boolean;
  readonly attachUrl: string | null;
  readonly stateDir: string | null;
  readonly seed: boolean;
  readonly only: ReadonlySet<string>;
  readonly keepStack: boolean;
  readonly tolerance: number;
  readonly viewport: Viewport;
  readonly bootTimeoutMs: number;
  readonly navigationTimeoutMs: number;
  readonly list: boolean;
}

function write(line: string): void {
  NodeProcess.stdout.write(`${line}\n`);
}

function parseViewport(value: string): Viewport {
  const match = /^(?<width>\d+)x(?<height>\d+)$/.exec(value.trim());
  const width = Number.parseInt(match?.groups?.width ?? "", 10);
  const height = Number.parseInt(match?.groups?.height ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Invalid --viewport '${value}'. Use WIDTHxHEIGHT, e.g. 1440x900.`);
  }
  return { width, height };
}

export function parseCliOptions(argv: ReadonlyArray<string>): CliOptions {
  let update = false;
  let attachUrl: string | null = null;
  let stateDir: string | null = null;
  let seed = false;
  let keepStack = false;
  let list = false;
  let tolerance = DEFAULT_RATIO_TOLERANCE;
  let viewport = DEFAULT_VIEWPORT;
  let bootTimeoutMs = 240_000;
  let navigationTimeoutMs = 180_000;
  const only = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${String(argument)} needs a value.`);
      index += 1;
      return value;
    };
    switch (argument) {
      case "--update":
      case "-u":
        update = true;
        break;
      case "--attach":
        attachUrl = next();
        break;
      case "--state-dir":
        stateDir = NodePath.resolve(next());
        break;
      case "--seed":
        seed = true;
        break;
      case "--only":
        for (const id of next().split(",")) {
          if (id.trim().length > 0) only.add(id.trim());
        }
        break;
      case "--keep-stack":
        keepStack = true;
        break;
      case "--tolerance":
        tolerance = Number.parseFloat(next());
        break;
      case "--viewport":
        viewport = parseViewport(next());
        break;
      case "--boot-timeout":
        bootTimeoutMs = Number.parseInt(next(), 10) * 1_000;
        break;
      case "--navigation-timeout":
        navigationTimeoutMs = Number.parseInt(next(), 10) * 1_000;
        break;
      case "--list":
        list = true;
        break;
      case "--help":
      case "-h":
        list = true;
        break;
      default:
        throw new Error(`Unknown argument '${String(argument)}'. Run with --list for usage.`);
    }
  }

  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
    throw new Error("--tolerance must be a ratio between 0 and 1.");
  }
  return {
    update,
    attachUrl,
    stateDir,
    seed,
    only,
    keepStack,
    tolerance,
    viewport,
    bootTimeoutMs,
    navigationTimeoutMs,
    list,
  };
}

type ViewStatus = "passed" | "failed" | "skipped";

interface ViewResult {
  readonly id: string;
  readonly status: ViewStatus;
  readonly url: string;
  readonly reason?: string;
  readonly failures: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
  readonly screenshot?: string;
  readonly comparison?: ComparisonResult;
  readonly durationMs: number;
}

async function runSteps(
  browser: VisualBrowser,
  view: ViewSpec,
  navigationTimeoutMs: number,
): Promise<void> {
  for (const step of view.steps ?? []) {
    switch (step.kind) {
      case "click":
        await browser.page.locator(step.selector).first().click({ timeout: 15_000 });
        break;
      case "clickUntil": {
        // Confirmation delay: long enough that a pre-hydration rendering has
        // been replaced, short enough to cost nothing when the state is real.
        const confirmMs = 400;
        const satisfied = async (): Promise<boolean> =>
          (await browser.page.locator(step.until).count()) > 0;
        const deadline = Date.now() + navigationTimeoutMs;
        for (;;) {
          if (await satisfied()) {
            await browser.page.waitForTimeout(confirmMs);
            if (await satisfied()) break;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `clickUntil gave up after ${String(navigationTimeoutMs)}ms: \`${step.until}\` never held (clicking \`${step.selector}\`).`,
            );
          }
          const target = browser.page.locator(step.selector);
          if ((await target.count()) > 0) {
            // A click landing mid-re-render is expected; the loop re-checks.
            await target
              .first()
              .click({ timeout: 15_000 })
              .catch(() => {});
          }
          await browser.page.waitForTimeout(250);
        }
        break;
      }
      case "waitFor":
        await browser.page
          .locator(step.selector)
          .first()
          .waitFor({ state: "visible", timeout: navigationTimeoutMs });
        break;
      case "waitForAbsent":
        await browser.page
          .locator(step.selector)
          .first()
          .waitFor({ state: "detached", timeout: navigationTimeoutMs });
        break;
      case "settle":
        await browser.page.waitForTimeout(step.millis);
        break;
    }
  }
}

/**
 * Best-effort wait for transient overlays (the "reconnect this environment"
 * banner is the known one) to clear. Never fails the view: an overlay that
 * stays put is a real rendering, and the diff should say so.
 */
async function waitForQuietFrame(browser: VisualBrowser, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let present = 0;
    for (const selector of VOLATILE_SELECTORS) {
      present += await browser.page.locator(selector).count();
    }
    if (present === 0 || Date.now() > deadline) return;
    await browser.page.waitForTimeout(500);
  }
}

async function captureView(input: {
  readonly browser: VisualBrowser;
  readonly view: ViewSpec;
  readonly context: ViewContext;
  readonly webUrl: string;
  readonly options: CliOptions;
  readonly runDir: string;
}): Promise<ViewResult> {
  const { browser, view, context, options } = input;
  const started = Date.now();
  const url = `${input.webUrl}${view.path(context)}`;

  if (view.requiresFixtures === true && !context.seeded) {
    return {
      id: view.id,
      status: "skipped",
      url,
      reason: "fixtures were not seeded for this run, and this view needs seeded data",
      failures: [],
      diagnostics: [],
      durationMs: Date.now() - started,
    };
  }

  const failures: Array<string> = [];
  browser.resetDiagnostics();
  await browser.page.setViewportSize(view.viewport ?? options.viewport);
  await browser.page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options.navigationTimeoutMs,
  });

  try {
    await runSteps(browser, view, options.navigationTimeoutMs);
  } catch (error) {
    failures.push(`step failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await waitForQuietFrame(browser, 10_000);

  for (const check of view.checks) {
    const count = await browser.page.locator(check.selector).count();
    if (count < check.minimum) {
      failures.push(
        `${check.label}: expected at least ${String(check.minimum)} match(es) for \`${check.selector}\`, found ${String(count)}`,
      );
    }
  }

  const screenshotPath = NodePath.join(input.runDir, `${view.id}.png`);
  const image = await browser.page.screenshot({ path: screenshotPath, fullPage: false });

  const diagnostics = [...browser.diagnostics];
  if (diagnostics.length > 0) {
    failures.push(`${String(diagnostics.length)} console/page error(s)`);
  }

  const comparison = await compareAgainstBaseline({
    view,
    image,
    runDir: input.runDir,
    options,
  });
  if (comparison.status === "changed" || comparison.status === "resized") {
    failures.push(
      comparison.status === "resized"
        ? `baseline is ${String(comparison.baselineSize?.width)}x${String(comparison.baselineSize?.height)}, capture is ${String(comparison.currentSize?.width)}x${String(comparison.currentSize?.height)}`
        : `${(comparison.ratio * 100).toFixed(3)}% of pixels changed (tolerance ${(options.tolerance * 100).toFixed(3)}%)`,
    );
  }

  return {
    id: view.id,
    status: failures.length === 0 ? "passed" : "failed",
    url,
    failures,
    diagnostics,
    screenshot: screenshotPath,
    comparison,
    durationMs: Date.now() - started,
  };
}

async function compareAgainstBaseline(input: {
  readonly view: ViewSpec;
  readonly image: Buffer;
  readonly runDir: string;
  readonly options: CliOptions;
}): Promise<ComparisonResult> {
  const baselinePath = NodePath.join(BASELINE_DIR, `${input.view.id}.png`);
  await NodeFSP.mkdir(BASELINE_DIR, { recursive: true });
  const baseline = await NodeFSP.readFile(baselinePath).catch(() => null);

  if (baseline === null || input.options.update) {
    await NodeFSP.writeFile(baselinePath, input.image);
    return {
      status: baseline === null ? "created" : "updated",
      changedPixels: 0,
      totalPixels: 0,
      ratio: 0,
    };
  }

  const pixels = comparePngBuffers(baseline, input.image);
  if (!pixels.sameSize) {
    return {
      status: "resized",
      changedPixels: pixels.changedPixels,
      totalPixels: pixels.totalPixels,
      ratio: 1,
      baselineSize: pixels.baselineSize,
      currentSize: pixels.currentSize,
    };
  }
  const changed = pixels.ratio > input.options.tolerance;
  if (changed && pixels.diffImage) {
    await NodeFSP.writeFile(
      NodePath.join(input.runDir, `${input.view.id}.diff.png`),
      pixels.diffImage,
    );
    await NodeFSP.copyFile(
      baselinePath,
      NodePath.join(input.runDir, `${input.view.id}.baseline.png`),
    );
  }
  return {
    status: changed ? "changed" : "match",
    changedPixels: pixels.changedPixels,
    totalPixels: pixels.totalPixels,
    ratio: pixels.ratio,
    baselineSize: pixels.baselineSize,
    currentSize: pixels.currentSize,
  };
}

async function resolveStack(options: CliOptions): Promise<DevStack> {
  if (options.attachUrl !== null) {
    write(`[visual] attaching to ${options.attachUrl}`);
    return await attachDevStack({
      webUrl: options.attachUrl,
      stateDir: options.stateDir,
      timeoutMs: 30_000,
    });
  }
  // A fresh state dir per run is what makes the fixtures (and therefore the
  // baselines) deterministic.
  await NodeFSP.rm(STACK_HOME_DIR, { recursive: true, force: true });
  await NodeFSP.rm(STORAGE_STATE_PATH, { force: true });
  const logPath = NodePath.join(ARTIFACTS_DIR, "dev-stack.log");
  write(
    `[visual] booting the dev stack (instance ${DEV_INSTANCE}, log ${NodePath.relative(REPO_ROOT, logPath)})`,
  );
  const stack = await startDevStack({
    repoRoot: REPO_ROOT,
    homeDir: STACK_HOME_DIR,
    instance: DEV_INSTANCE,
    logPath,
    timeoutMs: options.bootTimeoutMs,
  });
  write(`[visual] dev stack ready at ${stack.webUrl}`);
  return stack;
}

async function main(): Promise<number> {
  const options = parseCliOptions(NodeProcess.argv.slice(2));
  if (options.list) {
    write("CH3 visual suite\n");
    write("  npm run visual                     capture + compare against baselines");
    write("  npm run visual:update              re-record the baselines");
    write("\nFlags:");
    write("  --only <ids>          comma-separated view ids");
    write("  --attach <url>        use an already-running stack instead of booting one");
    write("  --state-dir <dir>     that stack's '<home>/userdata' (needed for pairing/seeding)");
    write("  --seed                seed fixtures into an attached stack (destructive)");
    write("  --keep-stack          leave the booted stack running");
    write("  --tolerance <ratio>   changed-pixel ratio that still passes (default 0.005)");
    write("  --viewport WxH        run-wide viewport (default 1440x900)");
    write("  --boot-timeout <s>    stack boot timeout (default 240)");
    write("  --navigation-timeout <s>  per-navigation timeout (default 180)");
    write("\nViews:");
    for (const view of VISUAL_VIEWS) {
      write(`  ${view.id.padEnd(18)} ${view.summary}`);
    }
    return 0;
  }

  const runStamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const runDir = NodePath.join(RUNS_DIR, runStamp);
  await NodeFSP.mkdir(runDir, { recursive: true });

  const stack = await resolveStack(options);
  let browser: VisualBrowser | null = null;
  const results: Array<ViewResult> = [];
  let fixtures: VisualFixtures | null = null;
  let seedSkipReason: string | null = null;

  try {
    if (stack.stateDir === null) {
      seedSkipReason =
        "no state dir is known for the attached stack (pass --state-dir <home>/userdata)";
    } else if (stack.owned || options.seed) {
      write("[visual] seeding fixtures");
      fixtures = await seedVisualFixtures({ stateDir: stack.stateDir });
      write(
        `[visual] seeded ${String(fixtures.projectCount)} projects, ${String(fixtures.threadCount)} threads, ${String(fixtures.kanbanCardCount)} kanban cards (environment ${fixtures.environmentId})`,
      );
    } else {
      seedSkipReason = "attached to a stack this run does not own (pass --seed to overwrite it)";
    }
    if (seedSkipReason !== null) {
      write(`[visual] SKIPPING fixture seeding: ${seedSkipReason}`);
    }

    browser = await launchVisualBrowser({
      repoRoot: REPO_ROOT,
      viewport: options.viewport,
      storageStatePath: STORAGE_STATE_PATH,
    });
    write(`[visual] chromium: ${NodePath.basename(NodePath.dirname(browser.executablePath))}`);

    const auth = await ensureAuthenticated({
      browser,
      webUrl: stack.webUrl,
      mintCredential: async () => {
        if (stack.stateDir === null) {
          throw new Error(
            "Cannot pair: no state dir for the attached stack. Pass --state-dir <home>/userdata.",
          );
        }
        return await issuePairingCredential({
          repoRoot: REPO_ROOT,
          stateDir: stack.stateDir,
          webUrl: stack.webUrl,
        });
      },
    });
    if (!auth.authenticated) {
      throw new Error("Pairing succeeded but the session is still unauthenticated.");
    }
    write(
      `[visual] auth: ${auth.paired ? "paired with a fresh credential" : "reused saved session"}`,
    );
    await browser.saveStorageState(STORAGE_STATE_PATH);

    const context: ViewContext = {
      environmentId: fixtures?.environmentId ?? "",
      threadId: fixtures?.threadId ?? VISUAL_THREAD_ID,
      seeded: fixtures !== null,
    };

    const selected = VISUAL_VIEWS.filter(
      (view) => options.only.size === 0 || options.only.has(view.id),
    );
    if (selected.length === 0) {
      throw new Error(
        `--only matched no views. Known ids: ${VISUAL_VIEWS.map((v) => v.id).join(", ")}`,
      );
    }

    for (const view of selected) {
      const result = await captureView({
        browser,
        view,
        context,
        webUrl: stack.webUrl,
        options,
        runDir,
      });
      results.push(result);
      const comparison = result.comparison;
      const suffix =
        comparison === undefined
          ? ""
          : comparison.status === "match"
            ? ` · baseline match (${(comparison.ratio * 100).toFixed(3)}% drift)`
            : ` · baseline ${comparison.status}`;
      write(
        `[visual] ${result.status === "passed" ? "PASS" : result.status === "skipped" ? "SKIP" : "FAIL"} ${view.id} (${String(result.durationMs)}ms)${suffix}`,
      );
      for (const failure of result.failures) write(`         ! ${failure}`);
      for (const diagnostic of result.diagnostics) write(`         · ${diagnostic}`);
      if (result.reason !== undefined) write(`         · ${result.reason}`);
    }
  } finally {
    await browser?.close();
    if (options.keepStack && stack.owned) {
      write(`[visual] --keep-stack: the dev stack is still running at ${stack.webUrl}`);
    } else {
      await stack.stop();
      if (stack.owned) write("[visual] dev stack stopped");
    }
  }

  const report = {
    startedAt: runStamp,
    webUrl: stack.webUrl,
    viewport: options.viewport,
    tolerance: options.tolerance,
    update: options.update,
    seeded: fixtures !== null,
    seedSkipReason,
    fixtures,
    results,
  };
  await NodeFSP.writeFile(
    NodePath.join(runDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(ARTIFACTS_DIR, "latest-run.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  const failed = results.filter((result) => result.status === "failed");
  const skipped = results.filter((result) => result.status === "skipped");
  write("");
  write(
    `[visual] ${String(results.length - failed.length - skipped.length)} passed, ${String(failed.length)} failed, ${String(skipped.length)} skipped`,
  );
  write(`[visual] artifacts: ${NodePath.relative(REPO_ROOT, runDir)}`);
  write(`[visual] baselines: ${NodePath.relative(REPO_ROOT, BASELINE_DIR)}`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => {
      // Explicit exit: a killed dev stack can leave stray handles that would
      // otherwise keep this process alive after the report is written.
      NodeProcess.exit(code);
    },
    (error: unknown) => {
      NodeProcess.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      NodeProcess.exit(1);
    },
  );
}
