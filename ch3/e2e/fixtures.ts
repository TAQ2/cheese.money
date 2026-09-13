// @effect-diagnostics nodeBuiltinImport:off - Host-side test fixtures read the filesystem directly.

/**
 * The `test` every spec imports: Playwright's, extended with the booted stack,
 * a paired session, and a console guard.
 *
 * The guard is the suite's standing rule — a flow passes only if the page
 * logged no `console.error` and threw no uncaught error while it ran. A spec
 * that must tolerate a known, pre-existing error names it in
 * `knownConsoleErrors` next to a comment saying what produces it; nothing is
 * excused silently.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { test as base, expect, type Page } from "@playwright/test";

import { issuePairingCredential } from "../scripts/visual/stack.ts";

export const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
export const E2E_ARTIFACTS_DIR = NodePath.join(REPO_ROOT, "artifacts/e2e");
/** Written by global setup; the only channel from the booted stack to the tests. */
export const STACK_INFO_PATH = NodePath.join(E2E_ARTIFACTS_DIR, "stack.json");

export interface StackInfo {
  readonly webUrl: string;
  readonly stateDir: string;
  readonly logPath: string;
  readonly environmentId: string;
  /** The showcase's two-message thread (`remote-command-center`). */
  readonly threadId: string;
  /** The forty-turn thread — `LONG_CONVERSATION` in scripts/visual/fixtures.ts. */
  readonly longThreadId: string;
  readonly storageStatePath: string;
}

export function readStackInfo(): StackInfo {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(STACK_INFO_PATH, "utf8");
  } catch {
    throw new Error(
      `${STACK_INFO_PATH} is missing: the stack was not booted. Run the suite through ` +
        `\`npm run test:e2e\` so e2e/global-setup.ts runs first.`,
    );
  }
  return JSON.parse(raw) as StackInfo;
}

/**
 * Collect what the page reports as broken. Attached by the console guard to the
 * default page; a spec that opens a second context attaches it by hand.
 */
export function watchConsole(page: Page): { readonly errors: ReadonlyArray<string> } {
  const errors: Array<string> = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return { errors };
}

/**
 * Console errors a spec knowingly tolerates, keyed by the reason they are
 * tolerated. A record rather than an array because `test.use` reads a
 * two-element array as Playwright's `[value, options]` tuple.
 */
export type KnownConsoleErrors = Readonly<Record<string, RegExp>>;

export function assertCleanConsole(
  errors: ReadonlyArray<string>,
  known: KnownConsoleErrors = {},
): void {
  const patterns = Object.values(known);
  const unexpected = errors.filter((entry) => !patterns.some((pattern) => pattern.test(entry)));
  expect(unexpected, "the page logged errors during the test").toEqual([]);
}

export const test = base.extend<{
  readonly stack: StackInfo;
  /** See `KnownConsoleErrors`. Default: none. */
  readonly knownConsoleErrors: KnownConsoleErrors;
  /** Mints a fresh one-time pairing credential against the booted stack. */
  readonly mintPairingCredential: () => Promise<string>;
  readonly consoleGuard: void;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture signature: depends on nothing, only `use`.
  stack: async ({}, use) => {
    await use(readStackInfo());
  },
  baseURL: async ({ stack }, use) => {
    await use(stack.webUrl);
  },
  storageState: async ({ stack }, use) => {
    await use(stack.storageStatePath);
  },
  knownConsoleErrors: [{}, { option: true }],
  mintPairingCredential: async ({ stack }, use) => {
    await use(() =>
      issuePairingCredential({
        repoRoot: REPO_ROOT,
        stateDir: stack.stateDir,
        webUrl: stack.webUrl,
      }),
    );
  },
  consoleGuard: [
    async ({ page, knownConsoleErrors }, use) => {
      const watched = watchConsole(page);
      await use();
      assertCleanConsole(watched.errors, knownConsoleErrors);
    },
    { auto: true },
  ],
});

export { expect };
