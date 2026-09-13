# CH3 end-to-end tests

The real web client, in Chromium, against a real CH3 stack that this suite
boots, seeds and pairs itself. No provider CLI runs, no credential is needed,
and no agent turn is spent: every flow works on seeded conversations.

```bash
npm run test:e2e             # the whole suite, headless
npm run test:e2e:ui          # Playwright's UI mode: pick tests, watch, time-travel
npx playwright test e2e/find-in-conversation.spec.ts   # one file
npx playwright test --headed --debug                   # step through with the inspector
```

Requirements: the workspace installed (`vp i`) and a Chromium build Playwright
can find. `npx playwright install chromium` fetches one into the Playwright
browser cache; the visual harness's Chromium is the same build, so a machine that
runs `npm run visual` already has it.

## What a run does

Everything before the first test happens in `global-setup.ts`, and none of it
is new: the stack, the fixtures and the pairing exchange are the visual
harness's (`scripts/visual/`). There is one way to boot a private CH3 stack in
this repository and both harnesses use it.

1. **Boot.** `startDevStack` runs `scripts/dev-runner.ts dev --home-dir
artifacts/e2e/stack-home` with `CH3CODE_DEV_INSTANCE=ch3-e2e`. The instance
   name seeds the port offset, so this stack never collides with a hand-run
   `npm run dev` or with a visual run. The ports are read from the
   `[dev-runner]` line in `artifacts/e2e/dev-stack.log`, never assumed.
2. **Seed.** `seedVisualFixtures` writes the projection tables of that private
   database: three projects, the eight showcase threads, the Kanban overlay, and
   `LONG_CONVERSATION` — forty settled turns built for the flows below, the
   last of which was sent with an image (`attachmentId`, whose bytes are
   written to the stack's `attachments/` directory). Same fixtures, same ids,
   every run.
3. **Pair.** `ch3 auth pairing create` mints a one-time credential against the
   stack's own state directory, and `exchangePairingCredential` trades it for the
   browser-session cookie on a Playwright request context. That cookie jar is
   saved as the storage state every test's browser context starts from.
4. **Hand-off.** The stack's address and the seeded ids are written to
   `artifacts/e2e/stack.json`; `fixtures.ts` reads it into the `stack` fixture
   and points `baseURL` and `storageState` at it.
5. **Teardown.** When the run ends, the stack's whole process group is killed by
   the PID captured at spawn. Nothing is found by name and nothing else on the
   machine is touched. The developer's own `~/.ch3` is never involved.

One worker, no retries. The tests share one stack and one database, and a flow
that only passes on its second attempt is a defect in the flow.

## The rules every test follows

- **Wait on state, never on time.** Playwright's auto-waiting locators and
  `expect(...)` assertions, `expect.poll` for values read out of the page, and
  `data-*` attributes the DOM already carries (`data-timeline-row-id`,
  `data-message-id`, `data-user-message-collapsed`, `data-palette-mode`,
  `data-default-project*`). No `waitForTimeout`. Where "a moment later" is the
  thing under test, the wait is two `requestAnimationFrame`s — layout passes,
  not wall-clock time.
- **A clean console is part of passing.** The `consoleGuard` fixture in
  `fixtures.ts` runs for every test and fails it if the page logged a
  `console.error` or threw an uncaught error. A spec that must tolerate a known
  message lists it in `test.use({ knownConsoleErrors: { "<why>": /pattern/ } })`
  — the reason is the key, so it cannot be left out. Two exist today:
  - `pairing.spec.ts`: Chromium reports the 401s an unpaired client receives.
    The refusal is the behaviour under test.
  - `keybindings.spec.ts`: a pre-existing React duplicate-key error from
    `KeybindingPill` splitting the `mod++` binding. Remove that entry when the
    component is fixed.
- **Every test names what it protects.** The comment above each test cites the
  commit whose regression it would catch, or the invariant it holds.
- **A known defect is an expected failure, not a deleted test.** Two tests carry
  `test.fail(true, reason)` today, each with the reason in the code: the first
  reveal after typing a find query into a folded, unmounted turn does not scroll
  (found by this suite; fix belongs in `MessagesTimeline.tsx`), and the
  scroll-to-end pill lands short on a long thread (`4bbcd6b1`, on
  `fix/mac-user-sweep`, not yet on this branch). Playwright fails the run when an
  expected failure passes, so the marker cannot outlive the fix unnoticed.

## What is covered, and what deliberately is not

| spec                           | protects                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing.spec.ts`              | The auth boundary: a bare origin and a deep link land on `/pair` with nothing rendered; a pairing URL pairs exactly once and a replayed token grants nothing.                 |
| `find-in-conversation.spec.ts` | `3f91e16f` / `b02594b9`: mod+f, an exact counter, reveal into a folded turn, a clipped user message and a Shiki code block, wrapping steps, Escape clearing `CSS.highlights`. |
| `scroll-to-end.spec.ts`        | `4bbcd6b1`: the pill reaches the last message of a long virtualised thread and holds there.                                                                                   |
| `command-palette.spec.ts`      | mod+k, title search that navigates, message-text search through the server's `searchThreads`, mod+shift+f content search, Escape closing each.                                |
| `sidebar.spec.ts`              | Exact inbox, shelf, projects-mode and kanban counts.                                                                                                                          |
| `rewind-attachments.spec.ts`   | Editing a message reopens it with the images it was sent with, each removable, and switching messages swaps them.                                                             |
| `keybindings.spec.ts`          | Settings → Keybindings lists `chat.findInThread` on the platform's mod+F.                                                                                                     |

Not covered, on purpose:

- **Anything that needs a live agent turn** — sending a prompt, streaming,
  approvals, checkpoints. Those need a provider CLI and real quota; this suite
  has neither and must never acquire them.
- **The model picker.** With no provider installed the composer renders
  "No provider available" instead of the picker, so "a reopened conversation
  keeps its model" cannot be observed here or in CI.
- **The Electron shell.** `apps/desktop/scripts/smoke-test.mjs` boots it;
  everything the shell wraps is exercised here through the web client.

## Adding a flow

1. Pick the bug or invariant first, and write it as the comment above the test.
   A flow that clicks through a happy path and asserts a heading exists is not
   worth its run time.
2. Import `test` and `expect` from `./fixtures.ts`, never from
   `@playwright/test` directly, so the stack, the paired session and the
   console guard apply.
3. Locate elements by role, label, placeholder or an existing `data-*`
   attribute. Add a `data-testid` to `apps/web/src` only when nothing present can
   address the element, and say so in the pull request.
4. If the seeded data cannot express the scenario, extend
   `scripts/visual/fixtures.ts` — the one fixture set both harnesses read — and
   expose what the test needs as a named constant, the way `LONG_CONVERSATION`
   does. Do not seed from a test.
5. Run the file twice. If it passed once and failed once, the test is wrong,
   not unlucky.

## When it fails

- **Locally:** `npx playwright show-report artifacts/e2e/report` opens the HTML
  report; each failure carries a screenshot and a trace
  (`npx playwright show-trace <trace.zip>`). `artifacts/e2e/dev-stack.log` is
  the server's and Vite's output, including the `[dev-runner]` address line;
  `artifacts/e2e/stack.json` says which ports and which environment id the run
  used.
- **In CI** (`.github/workflows/ci-e2e-tests.yml`): the same report, traces and
  stack log are uploaded as artifacts on failure. The workflow runs on pull
  requests to `main` that are not drafts, and on manual dispatch; it is its own
  workflow, not part of `ci.yaml` and not a required check.
- **Boot failures** surface before any test runs, as a global-setup error
  quoting `dev-stack.log`. The usual causes are an install that did not run
  (`vp i`) and a stale stack from an interrupted run still holding the ports —
  the runner scans past occupied ports, so the second is rare.
- **"the page logged errors during the test"** is the console guard. Read the
  message: a real error in the app is a real finding, and the fix belongs in the
  app, not in `knownConsoleErrors`.

## Layout

```
playwright.config.ts   one worker, no retries, traces on failure, output under artifacts/e2e/
e2e/global-setup.ts    boot → seed → pair → stack.json; returns the teardown
e2e/fixtures.ts        the extended `test`: stack, baseURL, storageState, console guard
e2e/*.spec.ts          one file per surface
e2e/tsconfig.json      `npx tsgo --noEmit -p e2e/tsconfig.json`
```
