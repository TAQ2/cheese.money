/**
 * Live Electron proof that the Claude sign-in stays inside CH3.
 *
 * Unit tests on the predicate passed while the app was still throwing the
 * sign-in out to the system browser, because they asserted against a URL the
 * CLI had stopped issuing. This harness runs a REAL Electron window, calls the
 * REAL `window.open` a renderer calls, and watches what Electron actually does
 * — so a URL the predicate misses shows up here as `openExternal` being hit.
 *
 * Run: apps/desktop/node_modules/.bin/electron \
 *        apps/desktop/scripts/claude-oauth-window-harness.cjs
 * Exits 0 when every assertion holds, 1 otherwise.
 *
 * CommonJS on purpose: an ESM Electron main entry with top-level await never
 * reaches `app.whenReady()` here and the harness hangs with no output.
 */
const { app, BrowserWindow, session, shell } = require("electron");
const { execFileSync } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const outDir = mkdtempSync(path.join(tmpdir(), "ch3-oauth-harness-"));
// The rules under test are TypeScript; transpile the modules the app itself
// imports rather than restating them here — a harness carrying its own copy of
// a rule cannot catch the rule being wrong.
const compile = (relativePath, name) => {
  const outfile = path.join(outDir, `${name}.cjs`);
  execFileSync(
    path.join(REPO_ROOT, "node_modules/.bin/esbuild"),
    [
      path.join(REPO_ROOT, relativePath),
      "--bundle",
      "--platform=node",
      "--external:electron",
      "--format=cjs",
      `--outfile=${outfile}`,
    ],
    { stdio: "pipe" },
  );
  return require(outfile);
};
const { isClaudeOAuthSignInUrl } = compile(
  "apps/desktop/src/window/claudeOAuthUrl.ts",
  "claudeOAuthUrl",
);
const { openClaudeSignInWindow } = compile(
  "apps/desktop/src/window/claudeSignInWindow.ts",
  "claudeSignInWindow",
);

/** Exactly what `claudeAuthenticate` returned when probed on 2026-08-15. */
const AUTOMATIC_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A64503%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz";
const LEGACY_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a";
const UNRELATED_URL = "https://ch3.codes/docs";

const results = [];
const check = (name, condition) => {
  results.push({ name, ok: Boolean(condition) });
};

/** Records every attempt to hand a URL to the system browser. */
const shelled = [];
shell.openExternal = async (url) => {
  shelled.push(url);
};

app.commandLine.appendSwitch("use-mock-keychain");
// Never touch the developer's real Electron profile: this harness plants a
// cookie to prove the sign-in window cannot see it.
app.setPath("userData", path.join(outDir, "userdata"));

/** Every sign-in window the handler built, with the session it browses in. */
const created = [];

const openFromRenderer = async (window, url) => {
  created.length = 0;
  shelled.length = 0;
  await window.webContents.executeJavaScript(
    `window.open(${JSON.stringify(url)}, "_blank"); true;`,
    true,
  );
  // Window creation is a round trip through the browser process.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { created: [...created], shelled: [...shelled] };
};

app
  .whenReady()
  .then(async () => {
    // Stand in for the cookie a completed sign-in leaves behind. Planted in the
    // DEFAULT session, which is where the opener browses and where the old
    // child window browsed with it.
    await session.defaultSession.cookies.set({
      url: "https://claude.ai/",
      name: "sessionKey",
      value: "first-account-cookie",
    });

    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });

    // The handler under test, the same shape DesktopWindow installs — including
    // the deny-and-build-it-ourselves, which is the only path on which the
    // partition is honoured.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isClaudeOAuthSignInUrl(url)) {
        const signIn = openClaudeSignInWindow({
          url,
          show: false,
          // Read off the window itself, not off the value the module returned:
          // the claim is about the session Electron actually gave it.
          configure: (child) => {
            created.push({ url, session: child.webContents.session });
          },
        });
        // Never let the window actually reach the network: the assertion is
        // that CH3 built an isolated app window, not that claude.com is up.
        setTimeout(() => {
          if (!signIn.window.isDestroyed()) signIn.window.destroy();
        }, 200);
        return { action: "deny" };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });

    await window.loadURL("data:text/html,<title>harness</title>");

    const current = await openFromRenderer(window, AUTOMATIC_URL);
    check("current CLI url opens an in-app window", current.created.length === 1);
    check("current CLI url never reaches the system browser", current.shelled.length === 0);

    const legacy = await openFromRenderer(window, LEGACY_URL);
    check("legacy claude.ai url still opens in-app", legacy.created.length === 1);
    check("legacy claude.ai url never reaches the system browser", legacy.shelled.length === 0);

    const unrelated = await openFromRenderer(window, UNRELATED_URL);
    check("an unrelated link still opens externally", unrelated.shelled.length === 1);
    check("an unrelated link opens no app window", unrelated.created.length === 0);

    // ── Session isolation ────────────────────────────────────────────────
    // The reason this harness exists in its current form. Asserting the option
    // was PASSED proves nothing: Electron accepts `partition` in
    // `overrideBrowserWindowOptions` and silently ignores it on the
    // `window.open` path. These assertions read the session the window ended
    // up with.
    const first = await openFromRenderer(window, AUTOMATIC_URL);
    const second = await openFromRenderer(window, AUTOMATIC_URL);
    const firstWindow = first.created[0];
    const secondWindow = second.created[0];

    check("the sign-in window gets a session at all", Boolean(firstWindow && secondWindow));
    if (firstWindow && secondWindow) {
      check(
        "the sign-in window does NOT browse in the app's default session",
        firstWindow.session !== session.defaultSession,
      );
      check(
        "the sign-in session is in-memory, not written to disk",
        firstWindow.session.storagePath === null,
      );
      const plantedForOpener = await session.defaultSession.cookies.get({ domain: "claude.ai" });
      check("the planted cookie really is in the default session", plantedForOpener.length === 1);
      const firstCookies = await firstWindow.session.cookies.get({ domain: "claude.ai" });
      check("the sign-in window sees no claude.ai cookie", firstCookies.length === 0);
      check(
        "a second sign-in gets a DIFFERENT session from the first",
        firstWindow.session !== secondWindow.session,
      );
      // The user agent has to survive the new session, or sign-in pages refuse
      // the window outright and the isolation is worth nothing.
      check(
        "the sign-in session still hides Electron from the page",
        !firstWindow.session.getUserAgent().includes("Electron/") &&
          !firstWindow.session.getUserAgent().includes("ch3/"),
      );
    }

    for (const { name, ok } of results) {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    }
    const failed = results.filter((entry) => !entry.ok).length;
    console.log(`${results.length - failed}/${results.length} assertions passed`);
    app.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error("harness failed:", error);
    app.exit(1);
  });
