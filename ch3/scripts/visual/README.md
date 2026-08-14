# CH3 visual testing suite

Screenshot-and-assert harness so an agent can _see_ that a UI change rendered,
instead of trusting a unit test and a hopeful commit message.

One command boots a private dev stack, pairs itself, seeds deterministic
fixtures, captures every core surface, asserts the structure is present and the
console is clean, diffs against stored baselines, and tears everything down.

```bash
npm run visual            # capture + compare against baselines
npm run visual:update     # accept the current rendering as the new baseline
node scripts/visual/visual.ts --list    # flags + the view catalogue
```

Exit code is 0 only when every view passed. Skips are printed and recorded in
`report.json` — they are never silent, and they never turn the run green by
omission.

## What it captures

| id                 | surface                                                       |
| ------------------ | ------------------------------------------------------------- |
| `draft-landing`    | Empty draft thread: composer + inbox sidebar                  |
| `sidebar-inbox`    | Inbox sidebar with seeded threads, snoozed/settled shelves    |
| `sidebar-projects` | Projects sidebar, threads grouped under their project         |
| `thread-chat`      | A seeded conversation (user turn, assistant answer, composer) |
| `settings-general` | Settings shell on the General panel                           |
| `kanban-board`     | Kanban board: 7 columns, cards in both lanes, WIP dropdowns   |
| `kanban-metrics`   | Kanban board with the flow-metrics panel open                 |

Every view runs two kinds of assertion:

- **Structural** — the `checks` list in `views.ts`; each is a selector plus a
  minimum match count. This is what catches "the board rendered but every card
  vanished", which a pixel diff alone would report as a large, unexplained blob.
- **Console cleanliness** — any `console.error` or uncaught page error during
  the view fails it, and the messages are printed and stored.

## How a run is wired

1. **Stack.** `stack.ts` spawns `scripts/dev-runner.ts dev --home-dir
<artifacts>/stack-home` in its own process group, with
   `node_modules/.bin` prepended to `PATH` (dev-runner spawns `vp`, which is not
   on an agent's PATH) and `CH3CODE_DEV_INSTANCE=ch3-visual`.
   dev-runner picks its own ports from a hash of that instance name, so a visual
   run never collides with a hand-run dev stack or the installed app. The ports
   are read back out of dev-runner's own startup line — nothing here hardcodes
   them. Teardown is a process-group kill (SIGTERM, then SIGKILL), because the
   stack is dev-runner → `vp` → vite + server.
2. **Fixtures.** `fixtures.ts` seeds projections directly (see below).
3. **Auth.** See the pairing gotcha below.
4. **Capture.** `visual.ts` walks `VISUAL_VIEWS`, runs each view's steps, waits
   for transient overlays to clear, asserts, and screenshots.
5. **Compare.** `compare.ts` diffs against `artifacts/visual/baselines/`.

## The pairing gotcha (read this before debugging auth)

The server prints a pairing URL at startup:

```
Authentication required. Open CH3 using the pairing URL.
  pairingUrl: http://localhost:8146/pair#token=X64ZER64GQ9D
```

**That token is one-time and is consumed by the first client that redeems it.**
Scraping it from the log works exactly once and then fails confusingly on every
later run against the same state dir. Do not build on it.

Instead the suite mints its own credential on demand:

```bash
node apps/server/src/bin.ts auth pairing create --base-dir <home> --json
```

and POSTs it to `/api/auth/browser-session`, which is the same exchange the real
`/pair` screen performs. The resulting session cookie is saved with Playwright's
`storageState` to `artifacts/visual/storage-state.json`.

Reuse is checked first: the run calls `/api/auth/session` and only mints a new
credential when that reports unauthenticated. The log line says which path was
taken (`paired with a fresh credential` vs `reused saved session`).

**Where the saved session actually helps.** A normal `npm run visual` wipes
`stack-home` and the storage state before booting, because a fresh database is
what makes the fixtures — and therefore the baselines — deterministic. A new
database means the old cookie is worthless anyway. The saved session pays off on
runs that share a state dir, which is the fast iteration loop:

```bash
npm run visual -- --keep-stack                       # leaves the stack running
npm run visual -- --attach http://localhost:8146 \
  --state-dir artifacts/visual/stack-home/userdata \
  --only kanban-board                                # reuses the cookie, seconds
```

`ch3 auth pairing create` can only address `<home>/userdata` (via `--base-dir
<home>`) or the default `~/.ch3/dev` (via `--dev-url`). `pairingCliArguments()`
encodes exactly that and returns `null` for anything else rather than minting a
token against the wrong database — if you see that error, pass a reachable
`--state-dir`.

## Fixtures, and what they are not

The dev stack starts empty, and an empty app only proves the empty states
render. `fixtures.ts` writes the projection tables directly, reusing
`scripts/mobile-showcase-environment.ts` (the seeder behind the App Store
screenshots) rather than inventing a second fixture vocabulary. On top of it
sits a small Kanban overlay: stages, card types, a deadline, and one snoozed
thread, so all seven board columns are populated.

`snoozed` and `settled` are _derived_ by the board from the snooze/settle
lifecycle, so the overlay produces them by snoozing a thread and by leaving the
showcase's settled threads alone — never by writing a stage id that does not
exist in the contract.

**Stated plainly:** seeding bypasses the event log, so the projections are
self-consistent but have no `orchestration_events` behind them. Every view here
reads projections, so this is invisible to them; it would matter only to a view
that replays history. Nothing runs a provider CLI, so no view captures a live
agent turn.

Seeding is destructive (the showcase seeder clears the projection tables first),
so it only happens for a stack the run owns, or when `--seed` is passed
explicitly. It also refuses any state dir not named `<home>/userdata`.

## Baselines and diff precision

First run for a view writes the baseline and reports `created`. Later runs diff
against it.

The comparison is real pixel work (`pngjs`), not a byte or file-size heuristic:
PNG encoders may emit different bytes for identical images, so a byte delta
cannot tell "the button moved" from "zlib picked a different block split".

Two knobs, both documented in `compare.ts`:

- **Channel tolerance** (24/255, fixed). A pixel counts as changed only once a
  channel moves further than this. Absorbs anti-aliasing and subpixel text.
- **Ratio tolerance** (`--tolerance`, default `0.005` = 0.5% of pixels). The
  view fails on the _proportion_ of changed pixels, so a blinking caret or a
  one-minute-older relative timestamp does not fail a view, while a moved panel
  does.

When a view exceeds tolerance the run writes `<view>.diff.png` (baseline in
washed-out gray, changed pixels in magenta) and `<view>.baseline.png` next to
the capture, so the three can be flipped through side by side.

**Baselines are per-machine.** Font rasterisation differs across hosts and OS
versions; a baseline recorded on one machine will not match another. They are
gitignored for that reason. Re-record with `npm run visual:update` after an
intentional UI change, and eyeball the diff before you do.

## Artifacts

Everything generated lands in **`<repo>/artifacts/visual/`** (gitignored),
_not_ in this directory:

```
artifacts/visual/
  baselines/<view>.png          accepted renderings
  runs/<ISO-timestamp>/
    <view>.png                  this run's capture
    <view>.diff.png             only when over tolerance
    <view>.baseline.png         the baseline it was compared against
    report.json                 machine-readable result for every view
  latest-run.json               copy of the most recent report
  storage-state.json            saved browser session
  stack-home/                   the dev stack's CH3CODE home (userdata, workspace)
  dev-stack.log                 full dev-runner + server output
```

This location is deliberate. A run seeds a workspace containing real source
files; under `scripts/visual/` those files join the `@ch3tools/scripts` compile
graph and `tsgo --noEmit` fails on them — `.gitignore` does not shield `tsc`.
Keeping generated state outside every package's globs is what makes the suite
safe to run before a typecheck. **Do not move artifacts back under `scripts/`.**

`dev-stack.log` is the first place to look when a run fails to boot; the server
logs its migrations, port, and provider health checks there.

## Adding a view

One entry in `VISUAL_VIEWS` (`views.ts`) — no runner changes:

```ts
{
  id: "settings-providers",              // names the baseline file; must be unique
  summary: "Provider list with health badges.",
  path: () => "/settings/providers",
  requiresFixtures: true,                // skipped, loudly, when not seeded
  steps: [{ kind: "waitFor", selector: '[data-testid="provider-row"]' },
          { kind: "settle", millis: 750 }],
  checks: [{ label: "provider rows", selector: '[data-testid="provider-row"]', minimum: 1 }],
}
```

Steps are `click`, `clickUntil`, `waitFor`, `waitForAbsent`, `settle`.
`path` receives the seeded `environmentId` / `threadId`. Set `viewport` to
override the run-wide size (the board views do, for width).

**Use `clickUntil`, not `click`, for anything that toggles state.** It clicks
until an `until` selector matches and then re-checks that it still matches. A
plain "click it only if it looks unset" test is a trap against a React app, and
cost this suite a 180-second timeout before it was fixed — see the flakiness
notes.

Then record the baseline for just that view:

```bash
npm run visual:update -- --only settings-providers
```

Prefer `data-testid` selectors over text or CSS classes — they survive copy
edits and restyling, which is the whole point of asserting structure separately
from pixels.

## Flakiness notes

Handled already:

- **Animations and transitions** are zeroed, and the caret is made transparent,
  by an init script injected before every document (`browser.ts`). It is an init
  script rather than a style tag because a style tag dies on the next navigation
  and this suite navigates per view.
- **Toasts** are hidden — they arrive on their own schedule.
- **The "Reconnect this environment" banner** is waited out (best effort, 10s)
  before capture. It is never _required_ to disappear: an overlay that stays put
  is a real rendering and the diff should say so.
- **Sidebar mode** is set per view rather than inherited from whatever the
  previous view left behind, since it is a persisted client setting. The
  `aria-pressed="false"` selector makes that click idempotent.
- **Ports** are read from dev-runner's startup line, never assumed.

- **Two SPA races that a one-shot presence test loses**, both real, both hit
  during development of this suite:
  1. Steps begin right after `domcontentloaded`, when React has not mounted.
     "Click the button if it is present" finds nothing, skips the click without
     a word, and the run then waits out its entire timeout for a state nothing
     ever requested.
  2. Client settings hydrate asynchronously and the sidebar renders its
     pre-hydration default first, so the toggle briefly reports a mode that is
     about to be replaced.

  `clickUntil` converges on the state instead of sampling it once, which is
  immune to both. Reach for it whenever a step changes state.

Still worth knowing:

- **Relative timestamps** ("2 minutes ago") advance during a run. They are small
  and stay well under the ratio tolerance, but a view built mostly of timestamps
  would need a fixed clock. Measured drift on an unchanged app: 0.000% for the
  settings, chat and board views, and 0.16%–0.32% for the three views showing
  relative times, against a 0.5% default tolerance. That is real but not vast
  headroom — if a timestamp-heavy view starts flapping, raise `--tolerance` for
  the run rather than re-recording a baseline you have not inspected.
- **Provider status banners are part of the baseline.** A missing provider CLI
  ("Codex CLI (`codex`) is not installed or not on PATH") renders a banner over
  the main pane. It is stable for a given machine, and is one more reason
  baselines do not travel between hosts. It is deliberately _not_ hidden: it is
  real UI, and hiding it would blind the suite to changes in it.
- **First boot is slow** — Vite compiles the app on the first request. The
  default boot timeout is 240s (`--boot-timeout`), and the first capture of a
  run absorbs the initial compile. Raise both on a loaded machine.
- **The dev stack must not be run concurrently with itself.** Two runs share
  `stack-home` and the hashed ports. Run them one at a time.

## Requirements

- A Chromium in the Playwright browser cache (`~/Library/Caches/ms-playwright`
  on macOS). The suite prefers `chromium_headless_shell` and falls back to full
  Chromium. Install one with:
  `node node_modules/.pnpm/node_modules/playwright-core/cli.js install chromium`
- `playwright-core`, already present transitively. It is loaded _by path_ at run
  time, not by specifier, because pnpm does not link a transitive dependency
  into the root `node_modules` — `browser.ts` resolves it and types it
  structurally, so nothing is added to `package.json` for it.
