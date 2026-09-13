# Desktop window

Why this file exists: to record why the Claude sign-in URL rule lives in a module of its own,
and why the test that proves it works is a live Electron harness rather than a unit test.

The source of truth for _what the rule is_ is `claudeOAuthUrl.ts` — it is short, and its comments
carry the reasoning. This file is for the surrounding decisions.

## Contract / behavior callers rely on

- **A Claude sign-in URL opens in an in-app window; everything else opens in the system
  browser.** `isClaudeOAuthSignInUrl` is the whole decision, consulted by
  `DesktopWindow.ts`'s window-open handler.
- **The rule matches a host family and a path segment**: `https` only, hostname in
  `{claude.ai, claude.com}`, and `/oauth` as a **path segment** rather than a prefix.
- **The sign-in window is CH3's, not Electron's.** The handler returns `action: "deny"` and
  `claudeSignInWindow.ts` constructs the window, because that is the only way to choose its
  session. See the decision below — this is not a style preference.
- **Every sign-in attempt gets a fresh, empty, in-memory cookie jar.**
  `claudeSignInPartition.ts` mints a unique non-`persist:` partition per attempt, so no sign-in
  can see a previous one's cookies, within a run or across runs.
- **The sign-in window strips `Electron/<version>` and `ch3/<version>` from its user agent**,
  matching what `BrowserSession.ts` already did for browsing. Sign-in pages — Google's Workspace
  consent among them — refuse user agents they read as an embedded shell. The agent is set on the
  session as well as the contents, so SSO popups that inherit the session inherit it too.
- **There is exactly one import path for the rule.** `claudeOAuthUrl.ts` has no imports of its
  own and no re-export anywhere else.

## Decisions worth remembering

- **The rule is its own module so the harness can import the code the app runs.** This is the
  load-bearing decision in this directory. A harness that reimplements the predicate proves only
  that the harness agrees with itself; the whole point is to exercise **the same function** the
  window-open handler calls. The module has no imports precisely so it can be transpiled and
  loaded in isolation.

- **Segment matching, not prefix matching, and a host set, not a host.** The original predicate
  required `hostname === "claude.ai"` _and_ `pathname.startsWith("/oauth")`. The Claude CLI then
  moved its flow to `claude.com/cai/oauth/authorize`, which fails both conditions — so sign-in
  fell straight through to `shell.openExternal` and escaped to the system browser, which is the
  exact failure the interception exists to prevent.

  It is worth recording how this was established, because the obvious theory was wrong: a probe
  ran the real SDK's authenticate call with a logging `open`/`xdg-open` shim on `PATH`. The CLI
  returned both a manual and an automatic URL, **both on `claude.com`**, and **never invoked the
  shim** — no browser process count changed. The CLI opens no browser at all. The escaping tab
  was ours.

- **The host set is deliberately small.** `www.*` variants and `platform.claude.com` were
  considered and dropped: no observed URL uses them, and every extra host is surface area on a
  predicate that decides whether a credential-bearing page opens inside the app. Add a host when
  a real URL demands it, not in anticipation.

- **A marketing page that merely mentions oauth in a slug still opens externally**, because the
  rule requires the `/oauth/` segment rather than a substring. This is the reason segment
  matching was chosen over the looser `includes("oauth")` that would also have fixed the
  reported bug.

- **The handler DENIES the sign-in and builds the window itself, to own the session.** Signing a
  second Claude account in silently signed the first one back in: three config directories on the
  developer's machine ended up holding credentials for the same address, and the only symptom was
  the accounts list days later. The cause was the cookie jar — a window Electron opens for
  `window.open` is created from the **opener's** site instance and shares the opener's session, so
  the first sign-in's `claude.ai` cookie auto-authenticated every later one.

  The obvious repair does not work, and it fails **silently**: Electron accepts `partition` (and a
  `session` object) inside `overrideBrowserWindowOptions.webPreferences` and **ignores both** on
  the `window.open` path, because it only consults them when constructing a WebContents from
  scratch. Measured on Electron 41.5.0 rather than assumed — a probe planted a `claude.com` cookie
  in the default session and the "partitioned" child read it back, reporting
  `isDefaultSession=true`. Constructing the `BrowserWindow` in the main process is what honours
  `partition`; `GoogleWorkspaceAuth.ts` already used that shape for the Workspace consent screen.

  A quieter bug went with it: the user agent used to be stripped in `did-create-window`, which
  fires **after** Electron has begun loading, so the first request could still announce `Electron/`.
  Owning the construction means the agent is set before anything loads.

- **The partition is ephemeral AND unique per attempt.** Dropping `persist:` makes the jar
  in-memory, which handles the cross-run case; but an in-memory session still lives as long as the
  app does, so a single fixed name would leak cookies between two sign-ins in one run — the
  reported failure, minus the restart. The uniqueness is not belt-and-braces.

- **Isolation is the fix; the server has the backstop.** `awaitClaudeAccountLogin` in
  `apps/server/src/provider/Drivers/ClaudeAccounts.ts` compares the address that actually signed in
  against the one the attempt was started for, and on a mismatch logs at ERROR with both addresses,
  strips the credential rather than leaving it in the wrong folder, and fails the sign-in with a
  message naming both. The original failure mode was silence, so the guard exists to make a
  recurrence loud even if the isolation is ever undone.

## Decisions NOT adopted (so nobody re-litigates them)

- **Routing the OAuth URL through the app's preview panel** — this was the _original_ cause of
  an earlier escape-to-browser bug, and the settings page has no thread to host a preview
  anyway. Rejected twice, once by consequence.
- **Keeping a re-export of the predicate** from the window module for convenience — deleted, so
  there is exactly one import path. Two import paths for one rule is the "second pattern beside
  the first" entropy this repo treats as the worst kind.
- **A broader `includes("oauth")` match** — would have fixed the reported symptom while opening
  unrelated pages inside the app. Rejected in favour of segment matching.
- **Proving the fix with a unit test alone** — a unit test over the predicate cannot show that
  the real `setWindowOpenHandler` consults it, which was the actual failure mode. The unit test
  exists; it is not the evidence.
- **Passing `partition` in `overrideBrowserWindowOptions.webPreferences`** — the natural one-line
  fix for the shared-cookie bug. Electron ignores it on the `window.open` path and says nothing.
  Do not reinstate it and delete the manual construction; the harness will catch you, which is
  why those assertions read `webContents.session` rather than the options that were passed.
- **A persisted (`persist:`) partition for the sign-in window** — would keep the wrong account's
  cookies on disk and carry them into the next run, which is the bug rather than a variation.

## When you change this

- **Run the live harness, and mutation-check it.** `apps/desktop/scripts/claude-oauth-window-harness.cjs`
  runs real Electron with a real `window.open` and a real `setWindowOpenHandler`, esbuild-transpiling
  the same module the app imports:

  ```sh
  env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron \
    apps/desktop/scripts/claude-oauth-window-harness.cjs
  ```

  It reports 13/13 assertions when the rule is correct, and with the old predicate restored it
  reports `FAIL current CLI url never reaches the system browser`.

  The isolation half was mutation-checked the same way: dropping `partition` from the window's
  `webPreferences` takes it to **7/13**, failing `the sign-in window does NOT browse in the app's
default session`, `the sign-in window sees no claude.ai cookie`, `a second sign-in gets a
DIFFERENT session from the first` and three more. The harness plants a `claude.ai` cookie in the
  default session precisely so those assertions have something to catch, and reads
  `webContents.session` rather than the options that were passed — because the option being
  accepted and the option taking effect are exactly what came apart here. **A harness that cannot
  fail proves nothing** — if you change the rule, break it deliberately once and confirm the
  harness notices.

  Two constraints learned the hard way: the harness must be **CommonJS**, because an ESM
  Electron main entry with top-level await hangs silently with no output; and
  `ELECTRON_RUN_AS_NODE=1` is exported in this environment, so `env -u` it or you get Node
  instead of Electron.

- **If the CLI moves its OAuth host again**, the fix is one entry in `CLAUDE_OAUTH_HOSTS` plus a
  harness assertion for the new URL. Do not widen the path rule to compensate.
- **The colocated unit test** is `DesktopWindow.test.ts`. It is necessary and not sufficient.
