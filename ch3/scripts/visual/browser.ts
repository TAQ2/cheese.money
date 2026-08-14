// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Host-side browser automation resolves Node paths and drives Playwright directly.

/**
 * The browser tier.
 *
 * `playwright-core` and a Chromium build are already present in this repo's
 * install (transitively, plus the ms-playwright cache), so nothing is added to
 * package.json for it. It is loaded by path at run time and typed by the
 * structural interfaces below — importing `playwright-core` by specifier would
 * fail, because pnpm does not link a transitive dependency into the root
 * `node_modules`.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

interface PlaywrightLocator {
  count: () => Promise<number>;
  first: () => PlaywrightLocator;
  click: (options?: { readonly timeout?: number }) => Promise<void>;
  waitFor: (options?: {
    readonly state?: "attached" | "detached" | "visible" | "hidden";
    readonly timeout?: number;
  }) => Promise<void>;
}

interface PlaywrightConsoleMessage {
  type: () => string;
  text: () => string;
}

export interface PlaywrightPage {
  goto: (
    url: string,
    options?: { readonly waitUntil?: "domcontentloaded" | "load"; readonly timeout?: number },
  ) => Promise<unknown>;
  setViewportSize: (size: Viewport) => Promise<void>;
  waitForTimeout: (millis: number) => Promise<void>;
  screenshot: (options: { readonly path?: string; readonly fullPage?: boolean }) => Promise<Buffer>;
  locator: (selector: string) => PlaywrightLocator;
  url: () => string;
  on: (event: string, handler: (payload: unknown) => void) => void;
}

interface PlaywrightRequestContext {
  post: (
    url: string,
    options: { readonly data: unknown; readonly failOnStatusCode?: boolean },
  ) => Promise<{ status: () => number; text: () => Promise<string> }>;
  get: (url: string) => Promise<{ status: () => number; text: () => Promise<string> }>;
}

interface PlaywrightContext {
  newPage: () => Promise<PlaywrightPage>;
  addInitScript: (script: { readonly content: string }) => Promise<void>;
  storageState: (options: { readonly path: string }) => Promise<unknown>;
  readonly request: PlaywrightRequestContext;
  close: () => Promise<void>;
}

interface PlaywrightBrowser {
  newContext: (options: {
    readonly viewport: Viewport;
    readonly deviceScaleFactor?: number;
    readonly reducedMotion?: "reduce" | "no-preference";
    readonly storageState?: string;
    readonly colorScheme?: "light" | "dark";
  }) => Promise<PlaywrightContext>;
  close: () => Promise<void>;
}

interface PlaywrightModule {
  readonly chromium: {
    launch: (options: {
      readonly headless?: boolean;
      readonly executablePath?: string;
      readonly args?: ReadonlyArray<string>;
    }) => Promise<PlaywrightBrowser>;
  };
}

const PLAYWRIGHT_CANDIDATES = [
  "node_modules/playwright-core/index.mjs",
  "node_modules/.pnpm/node_modules/playwright-core/index.mjs",
];

async function exists(path: string): Promise<boolean> {
  return await NodeFSP.access(path).then(
    () => true,
    () => false,
  );
}

export async function resolvePlaywrightModulePath(repoRoot: string): Promise<string> {
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    const absolute = NodePath.join(repoRoot, candidate);
    if (await exists(absolute)) return absolute;
  }
  throw new Error(
    `playwright-core not found under ${repoRoot} (looked in ${PLAYWRIGHT_CANDIDATES.join(", ")}). ` +
      `Re-run the workspace install.`,
  );
}

function browsersRoot(): string {
  const configured = NodeProcess.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured.length > 0) return configured;
  const home = NodeOS.homedir();
  return NodeProcess.platform === "darwin"
    ? NodePath.join(home, "Library/Caches/ms-playwright")
    : NodePath.join(home, ".cache/ms-playwright");
}

function chromiumBinarySuffixes(): ReadonlyArray<string> {
  if (NodeProcess.platform === "darwin") {
    const arch = NodeProcess.arch === "arm64" ? "arm64" : "x64";
    return [
      `chrome-headless-shell-mac-${arch}/chrome-headless-shell`,
      `chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
    ];
  }
  const arch = NodeProcess.arch === "arm64" ? "-arm64" : "";
  return [
    `chrome-headless-shell-linux${arch}/chrome-headless-shell`,
    `chrome-linux${arch}/chrome`,
    `chrome-linux/chrome`,
  ];
}

/**
 * Installed Chromium builds, newest first. Headless shells sort ahead of full
 * Chromium: a screenshot run wants the smaller, faster binary.
 */
export async function findChromiumExecutables(root: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []);
  const builds = entries
    .filter((entry) => entry.isDirectory() && /^chromium(_headless_shell)?-\d+$/.test(entry.name))
    .map((entry) => {
      const revision = Number.parseInt(entry.name.split("-").at(-1) ?? "0", 10);
      return {
        name: entry.name,
        revision,
        headlessShell: entry.name.startsWith("chromium_headless_shell"),
      };
    })
    .sort((a, b) =>
      a.headlessShell === b.headlessShell
        ? b.revision - a.revision
        : Number(b.headlessShell) - Number(a.headlessShell),
    );
  const found: Array<string> = [];
  for (const build of builds) {
    for (const suffix of chromiumBinarySuffixes()) {
      const candidate = NodePath.join(root, build.name, suffix);
      if (await exists(candidate)) found.push(candidate);
    }
  }
  return found;
}

export interface VisualBrowser {
  readonly page: PlaywrightPage;
  readonly context: PlaywrightContext;
  readonly executablePath: string;
  /** Console errors and page errors, in arrival order. */
  readonly diagnostics: ReadonlyArray<string>;
  readonly resetDiagnostics: () => void;
  readonly saveStorageState: (path: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Injected before every document: kills animations and hides the toast layer.
 * `addInitScript` rather than `addStyleTag` because a style tag dies on the next
 * navigation, and this suite navigates for every view.
 */
const STABILIZE_SCRIPT = `
(() => {
  const css = \`
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }
    [data-slot^="toast-portal"] { display: none !important; }
  \`;
  const apply = () => {
    if (!document.head || document.getElementById("ch3-visual-stabilize")) return;
    const style = document.createElement("style");
    style.id = "ch3-visual-stabilize";
    style.textContent = css;
    document.head.append(style);
  };
  apply();
  document.addEventListener("DOMContentLoaded", apply);
})();
`;

export async function launchVisualBrowser(input: {
  readonly repoRoot: string;
  readonly viewport: Viewport;
  readonly storageStatePath?: string;
  readonly colorScheme?: "light" | "dark";
}): Promise<VisualBrowser> {
  const modulePath = await resolvePlaywrightModulePath(input.repoRoot);
  const playwright = (await import(NodeURL.pathToFileURL(modulePath).href)) as PlaywrightModule;
  const candidates = await findChromiumExecutables(browsersRoot());
  if (candidates.length === 0) {
    throw new Error(
      `No Chromium build found under ${browsersRoot()}. Install one with ` +
        `\`node node_modules/.pnpm/node_modules/playwright-core/cli.js install chromium\`.`,
    );
  }

  let browser: PlaywrightBrowser | null = null;
  let executablePath = "";
  const failures: Array<string> = [];
  for (const candidate of candidates) {
    try {
      browser = await playwright.chromium.launch({ headless: true, executablePath: candidate });
      executablePath = candidate;
      break;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!browser) {
    throw new Error(`Could not launch Chromium.\n${failures.join("\n")}`);
  }

  const hasStoredState =
    input.storageStatePath !== undefined && (await exists(input.storageStatePath));
  const context = await browser.newContext({
    viewport: input.viewport,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: input.colorScheme ?? "light",
    ...(hasStoredState && input.storageStatePath !== undefined
      ? { storageState: input.storageStatePath }
      : {}),
  });
  await context.addInitScript({ content: STABILIZE_SCRIPT });
  const page = await context.newPage();

  let diagnostics: Array<string> = [];
  page.on("console", (message: unknown) => {
    const typed = message as PlaywrightConsoleMessage;
    if (typed.type() === "error") diagnostics.push(`console.error: ${typed.text()}`);
  });
  page.on("pageerror", (error: unknown) => {
    diagnostics.push(`pageerror: ${String(error)}`);
  });

  return {
    page,
    context,
    executablePath,
    get diagnostics() {
      return diagnostics;
    },
    resetDiagnostics: () => {
      diagnostics = [];
    },
    saveStorageState: async (path: string) => {
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await context.storageState({ path });
    },
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

export interface AuthOutcome {
  readonly authenticated: boolean;
  /** True when a fresh pairing credential had to be minted and exchanged. */
  readonly paired: boolean;
}

/**
 * Reach an authenticated browser context, in the order that costs least:
 * reuse the saved session cookie, and only mint a pairing credential when that
 * session is missing or expired. The cookie is issued by the same
 * `/api/auth/browser-session` exchange the real pairing screen performs.
 */
export async function ensureAuthenticated(input: {
  readonly browser: VisualBrowser;
  readonly webUrl: string;
  readonly mintCredential: () => Promise<string>;
}): Promise<AuthOutcome> {
  const sessionUrl = `${input.webUrl}/api/auth/session`;
  const existing = await input.browser.context.request.get(sessionUrl);
  if (existing.status() === 200) {
    const body = await existing.text();
    if (body.includes('"authenticated":true')) {
      return { authenticated: true, paired: false };
    }
  }

  const credential = await input.mintCredential();
  const exchange = await input.browser.context.request.post(
    `${input.webUrl}/api/auth/browser-session`,
    { data: { credential }, failOnStatusCode: false },
  );
  if (exchange.status() !== 200) {
    throw new Error(
      `Pairing exchange failed with HTTP ${String(exchange.status())}: ${await exchange.text()}`,
    );
  }
  const confirmed = await input.browser.context.request.get(sessionUrl);
  const body = await confirmed.text();
  return { authenticated: body.includes('"authenticated":true'), paired: true };
}
