# Provider drivers

Why this file exists: to record the rules that govern code touching a developer's real provider
accounts — the credentials and home directories that CH3 can destroy but cannot restore.

The source of truth for _what each driver does_ is the driver file. This file is for _why the
account-handling code is as defensive as it is_, and it is mostly a record of bugs that were
expensive to find.

## Contract / behavior callers rely on

- **One driver per shipped provider** — Claude, Codex, Cursor, Grok, OpenCode. Each translates
  its CLI's native protocol into orchestration events. A provider-shaped feature needs a
  decision per driver, **even when the decision is "not supported here"** — an unstated omission
  is how a feature ends up half-shipped. `RETIRED_PROVIDER_DRIVER_KINDS` is empty: nothing is
  retired today, and the mechanism stays so a kind can be withdrawn from every user-facing
  surface without breaking an existing `settings.json`.
- **Claude and OpenCode install themselves at boot when missing.** `requiredProviderInstall.ts`
  forks an `npm install -g` (or the bun/pnpm/yarn equivalent) for those two at server startup,
  reaching `registry.npmjs.org`, because "Claude Code is not installed" is not an actionable
  message for someone who does not work in a terminal. It reuses the update path's command rather
  than adding a second one, is never fatal, and skips any provider the user switched off. Adding a
  driver to `REQUIRED_PROVIDER_DRIVERS` means every install on every machine reaches out for it —
  treat that list as a decision, not a default.
- **An update is judged by re-running the binary, never by the command's exit code.** Provider
  updaters are third-party CLIs and some report failure while exiting 0 — `opencode upgrade` does
  exactly that when GitHub's anonymous API quota is spent, which is why "OpenCode keeps offering an
  update I can never install" was invisible for so long. `providerMaintenanceRunner.ts` records the
  version before the command, re-probes after it, and `providerUpdateOutcome.ts` decides from the
  two. A verdict of `failed` also **fails the effect**, carrying the updater's own words: the
  recorded `updateState` and the caller's channel must never disagree, which is the bug that made
  `ClaudeCliInstaller` ignore this runner's result outright. The judgement lives in the runner, not
  in a driver, because every mechanism (npm, pnpm, bun, vite-plus, Homebrew, native) fails in ways
  its exit code does not describe and one question catches all of them.
- **No CH3 credential is handed to an update subprocess.** These spawns are arbitrary
  third-party binaries (npm lifecycle scripts, Homebrew formulae, a vendor's installer), so
  nothing the app holds goes into their environment — and `opencode upgrade` ignores
  `GITHUB_TOKEN`/`GH_TOKEN` anyway.
- **Complexity belongs at this boundary.** Drivers absorb the mess of several different CLIs so
  that orchestration upstream stays pure. Do not leak provider-specific branching into the
  decider.
- **CH3 holds no provider credentials of its own.** It drives CLIs the engineer has already
  installed and signed into. Credentials live in the OS keychain and in per-account home
  directories; there is no `.credentials.json` in any account directory and Electron Safe
  Storage is deliberately disabled.
- **Account home directories are addressed through `claudeProfileConfigPath`**, never by hand.

## Decisions worth remembering

- **The config path for the default profile is not inside the profile directory.** The Claude
  CLI keeps the default account's config at `~/.claude.json` — _beside_ the `~/.claude`
  directory, not within it. A hand-rolled `path.join(homePath, ".claude.json")` is correct for
  every named profile and **wrong for the default one**, which is the account most people use
  most. This is why every caller goes through `claudeProfileConfigPath` and why a reviewer
  caught the first version of the onboarding repair doing it by hand.

- **Deletion re-checks its precondition at the moment it deletes.** `discardAbandonedLoginDirectory`
  re-reads the directory's own `.claude.json` immediately before removing it and refuses any
  directory whose `oauthAccount.email` is non-empty.

  The bug this prevents is worth stating in full, because it is the sharpest example in this
  codebase of why scheduling-time checks are insufficient: attempt 1 creates `~/.claude-2` and
  is cancelled; the user retries into the same folder and completes sign-in; five minutes later
  attempt 1's timeout fires and recursively deletes the now-live account, credentials and all.
  Every individual step was reasonable. The flaw was that the decision to delete was made when
  the directory was empty and executed when it was not.

  **Generalize this: any path in this repo that deletes a directory or database must re-read
  its precondition at the moment it acts.** Alongside the guard there is a real
  `claude.cancelAccountLogin` RPC, so cancelling actually aborts the CLI session rather than
  leaving a timer armed.

- **A sign-out that cannot read its own identity spares the shared credential.** The Claude
  CLI keeps one credential per _account_, not per config directory, so a custom directory
  signed into the same account as the default home is served by the default's legacy
  `Claude Code-credentials` Keychain item. `signOutClaudeAccount` deletes that legacy item only
  when nothing else is signed into the identity — and an identity it could not read counts as
  "something else might be", never as "nobody is".

  The failure this prevents looks like nothing at all from the panel: a `~/.claude.json` with
  no `oauthAccount` renders as **Not signed in**, so signing that row out reads as a no-op, and
  the delete took the credential every borrowing directory depended on. Those accounts went
  unauthorized minutes later with no action taken against them. The two automatic callers in
  the login-cleanup path reach the same code, so the guard belongs in `signOutClaudeAccount`
  rather than at the click.

- **Programmatic sign-in must also mark the profile onboarded.** CH3 writes a valid
  credential without ever running the CLI's interactive first-run flow, so `.claude.json` ends
  up with an `oauthAccount` but no `hasCompletedOnboarding`. An interactive `claude` in a
  terminal then reads that as a brand-new user and walks the theme-picker-and-login path —
  **with a perfectly good credential sitting unused right next to it**. That is the whole bug
  behind "the terminal asked me to log in again". `markClaudeProfileOnboarded` runs after a
  successful login _and_ as a repair pass in `listClaudeAccountProfiles`, so profiles created by
  older builds get fixed too.

  **Known and deliberately not fixed**: `hasCompletedOnboarding` is only one of two first-run
  gates. `projects[<cwd>].hasTrustDialogAccepted` still blocks a first `claude` in a new working
  directory. The orchestrator answers that prompt automatically so orchestrated runs pass, and
  auto-stamping trust was declined — silently marking a directory as trusted on a developer's
  behalf is a security decision that belongs to them, not to this code.

- **Usage reads stop on an idle machine, and a refused read keeps the last numbers.**
  `Drivers/claudeUsagePollGate.ts` holds both halves. The failover and rotation loops ask it
  before spending anything: eight minutes with no foreground client lease and no turn inside the
  window, and the tick returns without a single read. **The activity stamp is written only when
  activity is actually observed** — a client lease or a running turn. Stamping it whenever the
  gate answered "yes" refreshed the window on every tick, so the idle time never exceeded the
  sixty-second poll interval and the suspension could not engage at all: 240 polls over four idle
  hours, none suspended. Every read of that stamp must stay downstream of a real signal. A running turn counts as activity on
  purpose — an unattended overnight run still needs the hand-over that only a usage read can
  trigger. Anything the user does wakes it on the next tick.

  When the endpoint does refuse a read with a 429, `fetchClaudeAccountUsage` serves the last
  reading it has at any age, stamped with `readAt`, rather than reporting nothing. Two different
  questions were sharing one answer: _what do I show_ (the last numbers, dated — a blank meter
  reads as "0%") and _what may I act on_ (`isDecisionGradeUsage`, still `USAGE_STALE_MS`). The
  reactor drops non-decision-grade readings before any hand-over rule sees them, so an hour-old
  number can appear in the panel and still never move an account.

  The keep-warm loop below is deliberately outside this gate: its whole job is to transact on a
  schedule while nobody is working.

- **Usage reads go out one at a time, a beat apart, and a 429 pauses only the account that
  earned it.** The panel that read "usage read rate limited — retrying" on five of six rows was
  first blinded by a burst: opening it probed every profile at once, six reads left inside a few
  milliseconds, and five came back 429. `fetchClaudeAccountUsage` passes every endpoint read
  through one semaphore with `USAGE_READ_SPACING_MS` between reads, reports `retryAtMs` so a row
  can say when its next read is instead of "retrying", and persists readings and pauses to
  `<state>/claude-usage-cache.json` so a restart does not come up blank and re-read everything.
  The first fix then paused EVERY account on any 429, on the theory that the bucket was
  machine-wide. It is not. One paced read per account from one shell on 2026-09-02: the first
  account 429'd with `retry-after: 246`, and three others all returned 200 inside the same ten
  seconds. The bucket is per account, and an account signed in on more than one machine is read
  by all of them, so one can be hot all day through no fault of this one. The single pause
  turned that into six blank rows: the first 429 in list order stopped every read behind it, and
  each panel open repeated it. `usagePausedUntilByKey` holds one pause per account key;
  the panel names the limited account and reads the rest.

- **The plan-usage numbers have two transports, and the second one is why polling was never
  going to be enough.** Polling is structurally weakest exactly when the number matters most:
  the 429 bucket is per account, so the account actively running agents is the account too
  rate-limited to be asked about. Observed on 2026-09-02 — five of six accounts read fine
  minutes ago, the account doing the work was 8.7 hours stale, and every
  `pausedUntilByKey` instant was already in the past. CH3 was not stuck waiting; it was
  retrying and being refused for nine hours.

  The CLI already streams the same numbers. `rate_limit_event` arrives on the session's own
  stdio during a normal turn, carries Anthropic's server-side `utilization` (the same quantity
  `/api/oauth/usage` returns, not a local estimate), costs no request, and cannot earn a
  penalty. `ClaudeAdapter` folds it into the same cache the poll fills via
  `recordClaudeRateLimitEvent`. Three things about it are not obvious and were all established
  from real payloads in `<state>/logs/provider/`, never assumed:

  1. **The stream reports a FRACTION, 0–1, where the endpoint reports 0–100.** The SDK type
     documents no scale. Across 1787 logged events the largest `utilization` ever seen is 1.01,
     and the decisive pairing is one account, identified uniquely by its window reset
     instants: its last event before a successful poll read `five_hour: 0.99, seven_day: 0.61`
     and the poll moments later recorded `sessionPercent: 100, weekPercent: 61`. Reading the
     fraction as a percent would show `0%` on a full account; the reverse would show `2800%`.
  2. **The numbers are under `rate_limit_info.unifiedWindows`, keyed `five_hour`, `seven_day`
     and `seven_day_overage_included`** — not the flat `SDKRateLimitInfo` the SDK type suggests,
     and `resetsAt` is epoch SECONDS here where the endpoint sends ISO. Overage is ignored: it
     is a separate allowance with no field on a reading, and folding it into the weekly figure
     would overstate what the plan window has left. `rate_limit_info` is `{}` on 49 of those
     events and those are dropped — zeroes would make an exhausted account look like the safest
     failover target.
  3. **No event has ever carried a per-model window.** The Fable figure still comes only from
     the poll. That is why a reading now keeps an instant PER WINDOW rather than one for the
     record, and why `ClaudeAccountUsage.readAt` is the older of the SESSION and WEEK instants
     with `modelWeekReadAt` stamped separately. Folding the per-model window into `readAt` would
     hold the whole reading at the age of the last successful poll — numbers taken forty seconds
     ago displayed as nine hours old, and, worse, every event-sourced reading pushed past
     `USAGE_STALE_MS` so `isDecisionGradeUsage` refuses it and the hand-over stalls, which is
     the exact failure this path exists to end. `claudeAccountFailover` reads `sessionPercent`
     and `weekPercent` only, so the two windows the stream refreshes are precisely the two that
     decide anything.

  **The account an event belongs to is resolved once, at session start, from the very
  `CLAUDE_CONFIG_DIR` the process was spawned with** — never from settings read later, because
  switching accounts repoints the instance and spawns a new process while the live session keeps
  drawing on the account it started under. When the config file names nobody the event is
  DROPPED with a WARN and never written under a guessed key: filing a busy account's numbers in
  another account's slot produces a panel that lies about which account has capacity left, which
  is worse than the stale label being fixed.

  The poll skip falls out of this rather than being a rule of its own: an event moves the
  record's newest instant, so `fetchClaudeAccountUsage` finds a reading inside `USAGE_FRESH_MS`
  and never spends the request. Self-correcting — an account with no events has nothing to move
  it and is read exactly as before, so a turn that runs without emitting events does not starve.

- **The cache file is version 2, and version 1 is migrated rather than discarded.** Every
  engineer has a v1 file on disk holding real readings; dropping it would put the panel back to
  blank-and-storm on the first launch after an update, which is the failure the file exists to
  prevent. A v1 record's single `atMs` becomes the instant of all three of its windows — exactly
  what it meant.

- **A forced read is the only thing allowed to break a pause, and only a person may ask for
  it.** There was previously no way to make a stale number try: the panel's "Try again" rendered
  solely when the profile list had never loaded, so an engineer looking at a nine-hour-old
  reading had no control at all. `claude.forceAccountUsageRead` (operate scope — it spends a
  rate-limited request against someone's account) clears that account's `usagePausedUntilByKey`
  entry and bypasses the freshness window. It is throttled to one forced read per account per
  `USAGE_FORCE_THROTTLE_MS`, because a button that can be mashed is an automatic retry with
  extra steps, and automatic retries inside a penalty are what produced the blackout. A refused
  force returns `usageForceRetryAt` rather than an error, and a forced read that 429s again says
  so in the panel instead of going quiet.

- **A 200 whose body will not parse is a shape change, not a hiccup, and says so.** Both used to
  render as the same blank, so if Anthropic moved the response shape the panel would look
  exactly like flaky wifi and nobody would investigate. `parseClaudeUsageResponse` returns
  `unrecognized`, which reaches the row as `usageShapeUnrecognized` and its own sentence: this
  one does not clear itself and needs a CH3 update.

- **`claudeAuthFailureSignal.ts`'s pattern match now has two callers, not one.** It exists
  because no probe can see a dead Claude sign-in from outside — the credential stores all look
  plausible even when the refresh token behind them is revoked, and the one reliable sighting is
  the CLI's own turn failure. `ClaudeAccountFailoverReactor` was its first caller, recording the
  failure time so the automatic hand-over has a trigger. `ClaudeAdapter.ts`'s `handleResultMessage`
  is the second, and it reaches the predicate through `recordClaudeAuthFailure`'s return value
  rather than calling it again: the recorder records only when the message IS an auth failure, so
  its answer already is the predicate's. That decides whether the `runtime.error` event a failed
  turn emits carries `class: "auth_error"` (versus the default `"provider_error"`), which is what
  lets the web client show a "Sign in" affordance instead of a dead-end raw CLI string. One predicate, one definition of "this looks like an auth failure";
  don't add a second regex at the emit site.

- **The keep-warm loop is the one account feature that defaults ON, and it spends quota.**
  `Layers/ClaudeAccountRiddleReactor.ts` spawns the Claude CLI every 25 minutes against one
  signed-in-but-unselected account and asks Haiku 4.5 for a riddle. The riddle is incidental; the
  traffic is the point — an account that transacts nothing never turns its session window over,
  so failover finds out the credential is stale at the moment it tries to hand it real work.

  **Two asymmetries worth knowing before you change it.** Failover and rotation are opt-IN
  because their usage probe reads the login keychain on a timer whose first tick fires at launch,
  producing an unexplained keychain dialog as the app opens; this loop defaults ON because its
  first tick is delayed a full interval, so nothing it does looks like part of startup. It still
  reads the credential when it spawns — the dialog is deferred, not abolished. And because it
  defaults ON it must check the Claude instance's own `enabled` flag, which the opt-in siblings
  can skip harmlessly: `orderedClaudeInstanceIds` sorts disabled instances last rather than
  dropping them, so on a machine with Claude switched off entirely it still returns one, and a
  default-ON feature would spawn against that user's accounts forever.

  It creates no thread, session or activity row, so the only evidence it ran is a log line and a
  `claude_account_riddles` row. The toggle is per instance in Settings
  (`accountRiddleKeepWarmEnabled`). A user asking "why is my quota moving when I am not working"
  is asking about this.

- **A tool call's input comes from the complete `assistant` message, not only from the stream.**
  The subagent roster names each delegation's model from the Agent call's `input.model`, and that
  field reached CH3 only through streamed `input_json_delta`s — which the CLI cut off
  mid-prompt for a background Agent launch, delivering the result thirty seconds before the
  complete message. The roster then fell back to the thread's model and a Sonnet subagent wore a
  Fable badge. `reconcileToolInputFromAssistantMessage` in `Layers/ClaudeAdapter.ts` now treats
  the assistant message's `tool_use` block as authoritative: one `item.updated` when it says more
  than the stream did, carrying the status the tool actually has (a finished call stays
  finished), and only for calls this session started — a subagent's own tool calls arrive as
  assistant messages too and are not ours. `settledTools` keeps completed calls addressable until
  the turn ends, because the late message can arrive after the result.

- **A Claude CLI runs behind a keeper and outlives the server.** A session's CLI used to be a
  child of the server, holding the server's pipes. Quit CH3 and one of two things happened:
  the CLI got SIGTERM and took its background agents with it, or — when the desktop's two-second
  grace ran out first and the server was SIGKILLed — the CLI kept running with nobody listening,
  the startup reconciler called its turn lost, and the next message started a second CLI on the
  same transcript. Both proven on this machine with a Haiku session: SIGTERM ends everything in
  under a second; an orphaned CLI finishes its turn, subagents included, and exits on its own.
  Now the SDK's `spawnClaudeCodeProcess` seam hands the spawn to
  `provider/keeper/ClaudeKeeper.ts`: a detached Node process (the script in
  `claudeKeeperScript.ts`, written to the shim directory at runtime like the account shim) owns
  the CLI's pipes, journals every stdout line under a sequence number, and serves that journal
  over a Unix socket in the temp directory. The server acknowledges each message it has
  processed; at shutdown `detachAll` closes the socket and nothing else; at boot `reattachAll`
  finds every live keeper under `<state>/claude-keepers/<threadId>/`, reconnects from the last
  acknowledged sequence, rebuilds the session on the turn recorded in `session.json`, and answers
  the SDK's `initialize` handshake from the keeper's cache of the first one. The startup
  reconciler leaves those threads alone, and so does the task reconciler — which now runs as its
  own `tasks.reconcile` startup phase _after_ the reattach and keeps exactly the threads that
  reattach returned, rather than guessing from a live keeper pid. The row stays "Working" because
  it is. What a keeper does **not** survive is its own executable being replaced: it runs the
  app's own binary under `ELECTRON_RUN_AS_NODE=1`, so installing a new `CH3.app` over the
  running one kills every live keeper and the CLI it holds — `detach` protects a session from the
  server exiting, not from that. See `docs/operations/desktop-build-install.md`. Proven in the dev server: a turn started at 03:23:48Z, the server SIGKILLed at
  03:24:15Z, the same turn completed at 03:25:43Z under the next server, and a subagent launched
  before the kill reported "subagent done" at 03:25:53Z, journal sequence 93 against a replay
  point of 68. An explicit Stop, a thread deletion and an account switch still kill the CLI
  through the keeper; only the server's own shutdown stopped doing so. Codex and OpenCode have
  no keeper and are stopped at shutdown as before.

- **Retiring a stale keeper waits to confirm the CLI it recorded is actually gone.** A fresh turn on a thread
  whose keeper the server could not reattach to calls `retireStaleClaudeKeeper` before spawning a
  new keeper on the same paths. It used to send the old keeper `SIGTERM` and move on without
  checking anything died: fine when the keeper is alive to run its own `retire()` (which does kill
  its CLI before exiting), but not when the keeper is already gone by some other path with no chance
  to. Caught live: an orphaned `claude` process (`ppid 1`, no keeper above it) still resuming the
  same session id a freshly spawned keeper had just been asked to resume, two processes racing one
  Claude session. `retireClaudeKeeper` now reaps a `cliPid` still alive in its meta file
  before returning, on **every** exit — retired, already gone, and both "not a keeper" returns,
  since a recycled pid or a `ps` lookup that timed out says nothing about the CLI and that is
  precisely the orphan state. What it waits for, bounded, is that CLI's death, not the keeper's:
  `SIGTERM`, poll to `RETIRE_CONFIRM_TIMEOUT`, then `SIGKILL`. It signals a pid only when that
  process's own command line still carries the recorded `cliSessionId`, the same reused-pid guard
  already used for the keeper pid itself.
  The worst case is bounded at roughly 20 s per keeper (two 5 s `ps` lookups plus the 10 s
  confirm), and that is the pathological case only: a real retire of a real keeper and CLI —
  spawn, handshake, retire and reap end to end — measures 222–246 ms in `ClaudeKeeper.test.ts`.
  A retire is sequential per keeper and inline in session start, so if that worst case is ever
  hit for real it is felt as a slow start, not a hang. What still kills a keeper without going
  through this path at all (a crash inside `claudeKeeperScript.ts`, an external `SIGKILL`) is open;
  every occurrence checked left an empty `keeper.log`, which argues against an in-process crash. The
  pid-liveness checks behind this are cheap (a signal-0 syscall, no process spawn), but the command
  line lookup used to verify each pid before signalling it is a real `ps` subprocess with no timeout
  of its own, and it runs on essentially every successful retire, not just a rare case, since real
  signal delivery across two separate OS processes is never as fast as the next line of this module's
  own code. CI caught that: bounded now (`boundedCommandLineOf`, `COMMAND_LINE_LOOKUP_TIMEOUT`), a
  slow or hung `ps` costs a bounded wait and a safe no-op instead of stalling a retire indefinitely.

- **A stopped session closes the background tasks it can no longer report.** A background agent
  lives inside the CLI process. When that process goes — an explicit stop (including the restart
  CH3 does between turns for a model change, a runtime-mode change, or `mcp/ClaudeMcpConfigChange`
  after an MCP install/remove), a crash, a restart on a provider with no keeper — nothing will ever
  send its `task_notification`, and the roster kept the
  row "running" with its timer climbing for the hour `ABANDONED_TASK_SILENCE_MS` waits. Observed
  on a real thread: the turn ended at 00:39:38, a fresh session started at 00:39:45, and the
  delegation launched at 00:34 sat live at 24 minutes. `openBackgroundTasks` on the session context
  remembers every `task_started` until its notification, and `stopSessionInternal` emits one
  `task.completed` with status `stopped` per survivor — the boot-time `TaskReconciler`'s
  vocabulary, for the same reason: a process going away is a stop from outside, not a completion
  nobody saw and not a failure nobody reported.

- **A shell task's pid is found by its output file, not by its command line.** The CLI writes a
  background shell's output to `…/tasks/<taskId>.output` and the shell keeps that file open as
  fd 1 for as long as it runs, so `lsof` restricted to shells names the process exactly, in
  ~60 ms. Three earlier attempts matched the Bash command text against a host-wide process
  sample: the shell's argv begins with a snapshot preamble the match never got past, the sample
  was up to 15 s stale, and the command only arrived on a later event than the task — so the
  chip landed on a minority of rows, and rarely in threads outside this repo.
  `BackgroundShellPidLookup` now takes the task id; ingestion asks it off the worker as the
  task starts (four tries over a second, for a slow spawn) and appends one `task.progress` row
  carrying only the pid, which the roster merges beside the task id it shows on every shell row.

- **Resolution failure must not silently change accounts.** The terminal shim's account resolver
  once printed nothing both when the default home was selected _and_ when it failed outright.
  The shim read empty output as "use the default" and unset `CLAUDE_CONFIG_DIR` — so an
  unreadable settings file silently moved a running terminal onto a different account. The
  resolver now prints the literal `default` for the default home and **exits non-zero** when it
  cannot tell; the shim checks the exit code and keeps the inherited value, warning on stderr.
  Ambiguity resolved as a guess is how you end up billing the wrong account.

- **"Installed" means current, and every surface runs the same binary.** A machine arrived with
  Claude Code v2.1.126: `--version` exited 0, the panel said Claude was fine, and every
  conversation on a current model died at turn start with `turn/setPermissionMode failed` —
  unreadable to the non-engineer sitting in front of it. `ClaudeCliInstaller` therefore holds
  every machine to a version floor (`MINIMUM_CLAUDE_FABLE_5_1_VERSION`, the newest model's
  requirement) and upgrades a stale binary through the same install path as a missing one, at
  startup, unattended. The shim's resolver also hands the recorded `binaryPath` to the shell
  shim (third output line), and the shim prefers it — absolute paths only — over whatever this
  shell's PATH finds: the auto-installer lands in `~/.local/bin`, which is on no GUI PATH, so
  the driver worked while terminals and orchestrator runs exited 127 on the very machines the
  auto-install exists for.

- **A turn never announces a setting the session already has.** `sendTurn` pushes the model, the
  response style and the permission mode down to the live CLI, and only the first two ever asked
  whether the value had actually changed. The permission mode was pushed unconditionally, so the
  first turn of every **cold start** told a CLI that had just been spawned under
  `bypassPermissions` that it was `bypassPermissions`. That round trip is the first thing in a
  turn that waits on the CLI, so a spawn that dies takes it down with it: the SDK rejects the
  pending control request, `sendTurn` reports `turn/setPermissionMode failed`, and the turn dies.
  Seven turns died that way in one day on one machine — every one on a cold start, none on a warm
  turn — and the tell was that resending the same text worked, because the failed start had
  already torn the dead session down. `currentPermissionMode` now tracks the mode in force the
  way `currentApiModelId` and `currentOutputStyle` already did, and a turn that would change
  nothing sends nothing. `plan` and the restore after it are unaffected: those are real changes.
  Nothing else can move the CLI's mode behind our back — `ExitPlanMode` is denied at the
  permission callback, so this module is the only writer.

  The user's message survives any of this: `thread.message-sent` is emitted and persisted before
  `sendTurn` is ever called, so a turn-start failure never loses the text, only the attempt to run
  it. What used to have "nothing retrying it" now does — the failed-turn activity carries the
  `messageId`, and the client's Retry button dispatches `thread.turn.retry`, which re-emits
  `thread.turn-start-requested` for that same message instead of appending a second one.

### The Artifact tool, Claude in Chrome and the claude.ai connectors ship OFF

A tool costs its definition in the context window before anybody calls it, so
the three the CLI enables by default and nobody here asked for are switched off,
per Claude account, in Settings. Each is a switch rather than a decision made for
everybody: turn it on and the next session carries it.

**Where the cost actually lands is not where the internet says it is.** Measured
on 2026-08-30 against CLI 2.1.251, in the shape CH3 really uses — an Agent SDK
session, `systemPrompt: preset claude_code`:

| session                             | total tokens | tools | Artifact present |
| ----------------------------------- | ------------ | ----- | ---------------- |
| baseline                            | 30,641       | 37    | no               |
| `enableArtifact: false`             | 30,641       | 37    | no               |
| `ENABLE_CLAUDEAI_MCP_SERVERS=false` | 30,575       | 33    | no               |

An SDK session never loads Artifact or Chrome — the CLI decides both by
entrypoint — so the switches change nothing for an agent turn today. They pay in
**interactive** sessions: a CH3 terminal, and every orchestrator agent, which
runs `claude` as a TUI in a tmux pane dozens of times in a single run.

The connectors are the smaller number and the bigger risk. Unauthorized they are
two stub tools each (`authenticate`, `complete_authentication`) worth ~80 tokens;
authorize Gmail or Drive once and that server brings its whole surface into every
session on the machine, wanted or not.

**Three mechanisms, because the CLI offers three and only three:**

- `CLAUDE_CODE_DISABLE_ARTIFACT=1` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` —
  environment variables, so they cannot be mis-quoted and an older CLI ignores
  what it does not read.
- `--no-chrome` — Chrome has no settings key and no environment variable, only
  the flag. An unknown flag is an error _before_ the session starts, so the shim
  passes it only when `claude --help` advertises it (~90 ms, re-answered after
  every upgrade rather than trusting a version number). A person's own `--chrome`
  comes after ours and wins.
- `enableArtifact: false` through the SDK's `settings`, which is the `--settings`
  layer: off in managed, `--settings` or user settings wins, so a stale file in
  somebody's home directory cannot turn it back on. Sent even though it is
  measurably inert today — a switch that governs the terminal and quietly exempts
  the agent is a half-truth we would pay for later.

`disableClaudeAiConnectors: true` is NOT used. It is a real settings key and it
was tried: passed through `--settings` it changes nothing, all six connector
tools still load. The environment variable is what works.

## Decisions NOT adopted (so nobody re-litigates them)

- **`$BROWSER=true` to stop the CLI opening a browser** — investigated and abandoned. A probe
  running the real SDK with a logging `open` shim showed the CLI opens **no browser at all**;
  the window came from CH3. `$BROWSER` is a Linux convention macOS ignores.
- **Auto-stamping `hasTrustDialogAccepted`** — would close the remaining first-run gate, and was
  declined deliberately. Trusting a directory is the developer's decision.
- **Seeding a `theme` value alongside `hasCompletedOnboarding`** — rejected. Only the key that
  actually gates the first-run path is written; guessing at a developer's theme preference is
  scope creep into their configuration.
- **Spawning terminals with a CH3 `ZDOTDIR`** so a hand-typed `claude` in a plain tmux pane
  picks up the shim — declined as too invasive. It injects into the user's shell startup and can
  break custom configs. What replaced it is the opposite trade: the shim now lives at a stable
  `<CH3 home>/bin`, is written at boot rather than only when a terminal opens, and the account
  panel shows the one `export PATH=…` line for `~/.zshrc`. The person adds it; CH3 never writes
  to a shell profile. `~/.zshrc` rather than `~/.zshenv` because a login shell runs
  `/etc/zprofile`, whose `path_helper` would demote the directory again — and `.zshrc` is the
  first file after it, which covers tmux panes. `cron` and `ssh host claude` still keep whatever
  account their environment names; that gap is known and accepted.

  The cost of getting this wrong is not theoretical. An overnight orchestration run spent six
  hours returning `Login expired · Please run /login` on every call, because its tmux shell held
  an account CH3 had long since switched away from, and each dead reply looked like a
  successful turn to the script driving it.

- **Treating `SECURITYSESSIONID` as the cause of terminal login prompts** — tested and
  disproven; the keychain is reachable under `env -i`.

## When you change this

- **Touching account directories**: assume the directory belongs to a signed-in account until
  you have re-read its config and proved otherwise, at the moment you act.
- **Adding a provider-shaped feature**: state the decision for every shipped driver in the PR, even
  where the decision is "not supported".
- **Changing sign-in**: verify against a real account in a real window, not only in unit tests.
  Every bug described above passed the test suite. The evidence bar for this directory is a live
  observation — a real terminal, a real Electron window, `ps eww` showing the environment a
  process actually received.
- **Changing how a Claude session is spawned or stopped**: the keeper is the one process that must
  never share a descriptor or a process group with the server. Prove a change with the dev
  server: start a turn with a background agent, `kill -9` the server by the pid that owns its
  port, restart, and read `claude.keeper.reattached` and the turn's `completed_at` from the
  projection. A test that only asserts on the fake query answers a different question.
- **Codex protocol drift**: `packages/effect-codex-app-server/src/_generated` is generated from
  the `openai/codex` app-server JSON schemas at the commit pinned by `UPSTREAM_REF` in
  `packages/effect-codex-app-server/scripts/generate.ts`. Codex adds enum values weekly, and a
  thread whose history holds a value the pinned schema does not know cannot be resumed at all
  (`Invalid payload for method 'thread/resume' during 'decode-payload'`). Upstream
  `pingdotgg/t3code` handles this with per-version compatibility overlays in the generator
  (#8346, #8447, #8897, #10373); when a new value shows up, check upstream first and
  cherry-pick, then prove it with
  `test/examples/codex-thread-resume-probe.ts` against the real CLI and a real thread.
- **The tests that enforce these contracts**: `ClaudeAccounts.test.ts`, `ClaudeHome.test.ts`,
  `claudeInstanceHome.test.ts`, `claudeAccountRotation.test.ts`, `claudeAccountFailover.test.ts`,
  and for the keeper `provider/keeper/ClaudeKeeper.test.ts` (real processes, a fake CLI) plus the
  "behind a keeper" block of `ClaudeAdapter.test.ts`.
  Note that `ClaudeAccountFailoverReactor.test.ts` reads the **real keychain and a live usage
  endpoint** — exclude it from ordinary runs; a test that needs the developer's real credentials
  is not a unit test.
