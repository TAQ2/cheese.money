/**
 * Keep-warm loop for signed-in Claude accounts nobody has selected.
 *
 * Every 25 minutes this asks ONE such account for a short riddle on Haiku 4.5,
 * moving to the next account each tick. The riddle is incidental; the traffic
 * is the point. An account that is signed in but not selected transacts
 * nothing, so its rolling session window never turns over and its stored
 * credential goes unexercised until the moment failover tries to hand real
 * work to it — the worst possible moment to find out it needs signing in
 * again. A cheap ask on a timer turns that surprise into a logged row.
 *
 * Nothing about this surfaces in the UI. It creates no thread, no session and
 * no activity row: it is a subprocess, a database insert, and silence. That is
 * deliberate — a keep-warm probe that produced conversation entries would bury
 * the user's actual work under machine chatter.
 *
 * The selected account is deliberately never asked. Real work already keeps
 * its window turning, so a riddle there spends quota to achieve what is
 * happening anyway.
 *
 * @module provider/Layers/ClaudeAccountRiddleReactor
 */
import type { ClaudeAccountProfile, ProviderInstanceEnvironment } from "@ch3tools/contracts";
import * as NodeOS from "node:os";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ClaudeAccountRiddleRepository } from "../../persistence/ClaudeAccountRiddles.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { listClaudeAccountProfiles } from "../Drivers/ClaudeAccounts.ts";
import { CLAUDE_AI_MCP_SERVERS_OFF, makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  RIDDLE_INTERVAL_MS,
  RIDDLE_MODEL,
  RIDDLE_PROMPT,
  RIDDLE_TIMEOUT_MS,
  chooseRiddleTarget,
  parseRiddleReply,
  retiredRiddleHomePaths,
} from "../Drivers/claudeAccountRiddle.ts";
import {
  type ClaudeInstanceMap,
  defaultClaudeInstanceId,
  orderedClaudeInstanceIds,
  resolveClaudeInstanceHomePath,
} from "../Drivers/claudeInstanceHome.ts";

const RIDDLE_INTERVAL = Duration.millis(RIDDLE_INTERVAL_MS);

/**
 * Stdout is one riddle. A model that ignores the format and rambles must not
 * be able to push a megabyte into SQLite.
 */
const MAX_RIDDLE_OUTPUT_BYTES = 64 * 1024;

interface RiddleSettingsView {
  readonly enabled: boolean;
  readonly currentHomePath: string;
  readonly binaryPath: string;
  readonly environment: ProviderInstanceEnvironment | undefined;
}

/**
 * ON unless explicitly switched off — and only while the Claude instance
 * itself is on.
 *
 * The instance check is not redundant. `orderedClaudeInstanceIds` sorts
 * disabled instances last rather than dropping them, so on a machine where the
 * Claude provider is switched off entirely it still returns one, and a feature
 * that defaults ON would go on spawning the CLI against that user's accounts
 * forever. Failover and rotation share the gap harmlessly because they are
 * opt-IN; this one is opt-OUT, so it has to check.
 *
 * The opt-out default is itself the opposite of those two. Their opt-in exists
 * because their usage probe reads the Claude credential out of the login
 * keychain on a timer whose first tick fires at startup, which produces an
 * unexplained keychain dialog the moment the app opens. This loop's first tick
 * is delayed a full interval, so nothing it does can be mistaken for part of
 * launch. It does still read the credential when it spawns the CLI — the
 * dialog is deferred, not abolished.
 */
const readRiddleSettings = Effect.fn("readRiddleSettings")(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (!settings) return undefined;

  const instances = (settings.providerInstances ?? {}) as ClaudeInstanceMap;
  // Same instance the home-path resolver picks, for the same reason as
  // failover: reading one instance's settings and acting on another's
  // accounts would warm the wrong fleet.
  const instanceId =
    orderedClaudeInstanceIds(instances)[0] ?? (defaultClaudeInstanceId() as string);
  const instance = instances[instanceId];
  const config = (instance?.config ?? {}) as {
    accountRiddleKeepWarmEnabled?: unknown;
    binaryPath?: unknown;
  };

  return {
    enabled: instance?.enabled !== false && config.accountRiddleKeepWarmEnabled !== false,
    currentHomePath: resolveClaudeInstanceHomePath({
      providerInstances: instances,
      legacyHomePath: settings.providers.claudeAgent.homePath,
    }),
    binaryPath:
      typeof config.binaryPath === "string" && config.binaryPath.trim().length > 0
        ? config.binaryPath.trim()
        : (settings.providers.claudeAgent.binaryPath ?? "claude"),
    environment: instance?.environment,
  } satisfies RiddleSettingsView;
});

/**
 * Ask one account for a riddle and log whatever came back.
 *
 * Never fails: the loop's whole value is that it keeps running unattended, so
 * a dead account, a missing binary or an unwritable table each produce a row
 * or a warning, not a broken loop.
 */
const askOneRiddle = Effect.fn("claude.account.riddle.ask")(function* (input: {
  readonly profile: ClaudeAccountProfile;
  readonly binaryPath: string;
  readonly environment: ProviderInstanceEnvironment | undefined;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const riddles = yield* ClaudeAccountRiddleRepository;

  // CLAUDE_CONFIG_DIR is the only knob that repoints the CLI at another
  // account, and it is set for THIS subprocess alone — the selected account
  // and every running session are untouched.
  //
  // Layered on top of `mergeProviderInstanceEnvironment`, not on raw
  // process.env: the desktop shell forces `NODE_OPTIONS=--use-system-ca` onto
  // the server for its own TLS, and that variable is inherited by every
  // descendant. The Claude CLI is a Bun binary that reads NODE_OPTIONS and
  // breaks hard on that flag — every HTTPS call fails with "SSL certificate
  // verification failed" — so a spawn that skips the strip cannot work at all
  // in the packaged app. See ProviderInstanceEnvironment.ts.
  const environment = yield* makeClaudeEnvironment(
    { homePath: input.profile.homePath },
    {
      ...mergeProviderInstanceEnvironment(input.environment),
      // Belt and braces with --strict-mcp-config below: this is the switch
      // that stops the CLI reaching for Claude.ai-hosted MCP servers. Applied
      // after the account's own environment on purpose — a keep-warm riddle
      // is not a session, so it loads no MCP whatever the account prefers.
      ...CLAUDE_AI_MCP_SERVERS_OFF,
    },
  );

  const startedAt = yield* DateTime.now;
  const result = yield* runner
    .run({
      command: input.binaryPath,
      args: [
        // `-p` is print mode: one prompt, one reply, no interactive session
        // and no transcript the user will later find in their history.
        "-p",
        RIDDLE_PROMPT,
        "--model",
        RIDDLE_MODEL,
        // This runs unattended, every 25 minutes, against an account nobody
        // is watching. It must be a plain text call and nothing else. Without
        // these the CLI boots every MCP server the user has configured — and
        // `ensureSharedClaudeMcpServers` deliberately copies those into every
        // profile — plus the whole Bash/Read/Write/Edit set, to tell a riddle.
        // MCP startup alone can outlast this tick's timeout.
        "--mcp-config",
        '{"mcpServers":{}}',
        "--strict-mcp-config",
        "--tools",
        "",
      ],
      env: environment,
      // A neutral directory on purpose: the CLI reads CLAUDE.md, .mcp.json and
      // project settings from its cwd, and the server's own working directory
      // is somebody's repository. A keep-warm probe must not inherit a
      // project's context.
      cwd: NodeOS.tmpdir(),
      // Written and closed immediately. Left unset, the child is handed a pipe
      // the parent never ends, and the CLI waits on it: "no stdin data
      // received in 3s, proceeding without it" — three seconds burned every
      // tick, and that warning lands at the FRONT of stderr, which is the
      // field a human reads to find out why an account failed.
      stdin: "",
      timeout: Duration.millis(RIDDLE_TIMEOUT_MS),
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: MAX_RIDDLE_OUTPUT_BYTES,
      outputMode: "truncate",
    })
    .pipe(Effect.result);
  const finishedAt = yield* DateTime.now;
  const durationMs = DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt);

  const account = {
    accountHomePath: input.profile.homePath,
    accountDisplayPath: input.profile.displayPath,
    accountEmail: input.profile.email ?? null,
    accountOrganization: input.profile.organizationName ?? null,
    model: RIDDLE_MODEL,
    durationMs,
  };

  const row =
    result._tag === "Failure"
      ? {
          ...account,
          status: "failed" as const,
          riddle: null,
          answer: null,
          rawOutput: null,
          failure: String(result.failure),
        }
      : result.success.timedOut
        ? {
            ...account,
            status: "failed" as const,
            riddle: null,
            answer: null,
            rawOutput: null,
            failure: `Timed out after ${RIDDLE_TIMEOUT_MS}ms`,
          }
        : result.success.code !== 0
          ? {
              ...account,
              status: "failed" as const,
              riddle: null,
              answer: null,
              // Kept on the failure path too: when an account needs signing in
              // again, the CLI says so on stderr and this row is the only
              // place that message survives.
              rawOutput: result.success.stdout.trim() || null,
              failure:
                result.success.stderr.trim() ||
                `Claude exited with code ${String(result.success.code)}`,
            }
          : (() => {
              const raw = result.success.stdout.trim();
              const parsed = parseRiddleReply(raw);
              return {
                ...account,
                status: "answered" as const,
                riddle: parsed?.riddle ?? null,
                answer: parsed?.answer ?? null,
                rawOutput: raw || null,
                failure: null,
              };
            })();

  yield* riddles
    .record({ ...row, askedAt: startedAt })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("claude.account.riddle.record-failed", { cause }),
      ),
    );

  yield* Effect.logDebug("claude.account.riddle.asked", {
    account: input.profile.displayPath,
    status: row.status,
    durationMs,
  });
  return row.status;
});

/**
 * One tick: pick whose turn it is, ask, log. Returns the account asked, or
 * undefined when the feature is off or no account qualifies.
 */
export const runClaudeAccountRiddleOnce = Effect.fn("runClaudeAccountRiddleOnce")(function* () {
  const view = yield* readRiddleSettings();
  if (!view?.enabled) return undefined;

  const riddles = yield* ClaudeAccountRiddleRepository;

  // Identities only — no usage probe, so nothing here reaches the keychain
  // the way rotation's scoring pass does.
  const profiles = yield* listClaudeAccountProfiles({
    configuredHomePath: view.currentHomePath,
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ClaudeAccountProfile>));

  // Read from the log, not from memory: a cursor would reset on every restart
  // and keep re-asking the first account while the last — the one most likely
  // to have gone stale — was never asked at all.
  const lastAsked = yield* riddles.lastAskedByAccount.pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<{ accountHomePath: string; askedAt: string }>),
  );
  // An account that fails every time is retired from the rotation. Failing
  // OPEN — an unreadable log retires nobody — because parking a working
  // account is the worse mistake: it is silent, and the feature exists to
  // exercise accounts nobody is watching.
  const outcomes = yield* riddles.recentOutcomes.pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<{ accountHomePath: string; status: string }>),
  );
  const target = chooseRiddleTarget({
    profiles,
    lastAskedByHomePath: new Map(lastAsked.map((row) => [row.accountHomePath, row.askedAt])),
    retiredHomePaths: retiredRiddleHomePaths(outcomes),
  });
  if (!target) return undefined;

  yield* askOneRiddle({
    profile: target,
    binaryPath: view.binaryPath,
    environment: view.environment,
  });
  return target;
});

/**
 * Background loop.
 *
 * The first tick is delayed a full interval rather than firing at startup.
 * Spawning the CLI reads the account's OAuth credential, and doing that in the
 * first seconds after launch is what makes a keychain dialog look like it came
 * from nowhere — the same failure that forces rotation to be opt-in. Waiting
 * 25 minutes costs nothing (an account idle at launch is still idle later) and
 * keeps startup silent.
 */
export const ClaudeAccountRiddleReactorLive = Layer.effectDiscard(
  Effect.forkScoped(
    runClaudeAccountRiddleOnce().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("claude.account.riddle.tick-failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced(RIDDLE_INTERVAL)),
      Effect.delay(RIDDLE_INTERVAL),
    ),
  ),
).pipe(Layer.provide(ProcessRunner.layer));
