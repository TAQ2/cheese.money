/**
 * The `claude` shim: a terminal follows the selected account, always.
 *
 * `CLAUDE_CONFIG_DIR` is fixed into a shell's environment when it spawns, so a
 * terminal opened before an account switch went on running `claude` as the
 * account it was born with — including the long-lived shells an orchestration
 * run lives in. The symptom is brutal and silent: the app shows the selected
 * account with plenty of headroom while the run dies against an exhausted
 * account's limit.
 *
 * A process's environment cannot be changed from outside, so the fix is to
 * resolve the account when `claude` is actually invoked rather than when the
 * shell started. A directory holding one executable named `claude` goes first
 * on the terminal's PATH; it reads the app's settings, exports the selected
 * account, and execs the real binary. Nothing needs to cooperate — not the
 * shell, not the orchestrator, not a script written months ago.
 *
 * Two things put the shim on a PATH, and they are different in reach. CH3
 * prepends its directory to every terminal it spawns itself, which needs
 * nothing from the user. A shell CH3 did not spawn — the tmux session an
 * orchestration run lives in, a plain Terminal window — only follows the
 * selected account once that directory is on its PATH, which is one line the
 * person adds to their shell profile. `claudeShimPathLine` is that line, shown
 * in the Claude account panel so it is copied rather than remembered.
 *
 * CH3 writes the shim and nothing else. It does not edit anybody's shell
 * configuration: a tool that rewrites `~/.zshrc` unasked is one bad release
 * away from taking someone's terminal with it.
 *
 * @module claudeAccountShim
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * The resolver, as a standalone script.
 *
 * It re-implements `resolveClaudeInstanceHomePath` rather than importing it:
 * this runs as a bare Node process from a shell, with no bundler and no
 * workspace resolution. The rule is small and pinned by tests on both sides —
 * the shim's own test asserts the two agree.
 */
/**
 * The session tools the shim turns off, as the resolver reports them.
 *
 * A token list rather than JSON because the reader is POSIX `sh`: `case`
 * matching on a space-padded string is the whole parser, and a value that
 * needs quoting can never appear in it.
 */
export const CLAUDE_SESSION_TOOL_TOKENS = {
  artifact: "artifact:off",
  chrome: "chrome:off",
  connectors: "connectors:off",
} as const;

export function claudeAccountResolverScript(settingsPath: string): string {
  return `'use strict';
// Prints the CLAUDE_CONFIG_DIR the app currently has selected, or the word
// "default" when the default home is selected (which the CLI expects UNSET,
// not set to ~/.claude — an explicit value makes it look for config INSIDE
// the folder). Exits non-zero, printing nothing, when the answer is unknown.
//
// Those last two must never be confused. They were: both printed nothing, so
// a resolver that could not read the settings looked exactly like "use the
// default account", and the terminal silently switched accounts mid-run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const CLAUDE_DRIVER = "claudeAgent";
try {
  const raw = fs.readFileSync(${JSON.stringify(settingsPath)}, "utf8");
  const settings = JSON.parse(raw);
  const instances = settings.providerInstances ?? {};
  const ids = Object.keys(instances).filter((id) => instances[id]?.driver === CLAUDE_DRIVER);
  const enabledFirst = [
    ...ids.filter((id) => instances[id]?.enabled !== false),
    ...ids.filter((id) => instances[id]?.enabled === false),
  ];
  const defaultId = CLAUDE_DRIVER;
  const ordered = enabledFirst.includes(defaultId)
    ? [defaultId, ...enabledFirst.filter((id) => id !== defaultId)]
    : enabledFirst;
  let home = "";
  let accountId = ordered.length > 0 ? ordered[0] : undefined;
  for (const id of ordered) {
    const candidate = instances[id]?.config?.homePath;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      home = candidate.trim();
      accountId = id;
      break;
    }
  }
  // An instance that exists but stores no homePath means the default home,
  // and must not fall through to the legacy block.
  if (home === "" && ordered.length === 0) {
    const legacy = settings.providers?.claudeAgent?.homePath;
    if (typeof legacy === "string") home = legacy.trim();
  }
  // Second line: which session tools this account has switched OFF.
  //
  // Read from the instance the home came from, NOT from the first one. Those
  // differ whenever an earlier instance stores no homePath — it means the
  // default home, so the loop above walks past it — and reading the switches
  // off the wrong one is a switch that does nothing: the person edits the
  // account they are using and every terminal keeps ignoring them, while an
  // account they never selected quietly governs the session. With no instance
  // at all there is nobody to ask and every tool stays as the CLI would have
  // it.
  const primary = accountId === undefined ? {} : (instances[accountId]?.config ?? {});
  const off = [];
  if (primary.artifactToolEnabled !== true) off.push(${JSON.stringify(CLAUDE_SESSION_TOOL_TOKENS.artifact)});
  if (primary.chromeIntegrationEnabled !== true) off.push(${JSON.stringify(CLAUDE_SESSION_TOOL_TOKENS.chrome)});
  if (primary.claudeAiConnectorsEnabled !== true) off.push(${JSON.stringify(CLAUDE_SESSION_TOOL_TOKENS.connectors)});
  // Third line: the binary the app itself runs. Read from the default
  // instance, where the installer records it — accounts are separate
  // instances and carry homes, not binaries. Empty when nobody recorded one.
  const configuredBinary = String(instances[CLAUDE_DRIVER]?.config?.binaryPath ?? "").trim();
  process.stdout.write(
    (home === ""
      ? "default"
      : path.resolve(home.startsWith("~") ? path.join(os.homedir(), home.slice(1)) : home)) +
      "\\n" +
      off.join(" ") +
      "\\n" +
      configuredBinary,
  );
} catch {
  // Unknown, not "default": the caller keeps whatever it already had.
  process.exit(1);
}
`;
}

/**
 * The launcher.
 *
 * POSIX sh, because it must run under whatever shell the terminal uses. The
 * shim's own directory is stripped from PATH before looking for the real
 * `claude`, so it cannot find itself and recurse.
 */
export function claudeShimScript(input: {
  readonly shimDir: string;
  readonly nodePath: string;
  readonly resolverPath: string;
}): string {
  return `#!/bin/sh
# CH3: run \`claude\` as the account selected in the app right now, not the
# one that happened to be selected when this shell started.
shim_dir=${JSON.stringify(input.shimDir)}
clean_path=$(printf '%s' "$PATH" | awk -v d="$shim_dir" -F: '{out="";for(i=1;i<=NF;i++){if($i!=d){out=out (out==""?"":":") $i}}print out}')
resolved=$(ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(input.nodePath)} ${JSON.stringify(input.resolverPath)} 2>/dev/null)
resolver_status=$?
# Line 1 is the account, line 2 the session tools to switch off, line 3 the
# binary the app is configured to run. Split rather than parsed: a resolver
# too old to print a line leaves it empty, and an empty line asks for nothing.
selected=$(printf '%s\\n' "$resolved" | sed -n 1p)
session_tools=$(printf '%s\\n' "$resolved" | sed -n 2p)
configured_claude=$(printf '%s\\n' "$resolved" | sed -n 3p)
# The binary the app records outranks whatever this shell's PATH finds: the
# installer may have just upgraded into ~/.local/bin — a directory GUI-spawned
# shells and fresh machines do not have on PATH at all — while an older copy
# still shadows it. This is the same precedence the driver itself uses. PATH
# is the fallback, so a machine with no recorded binary behaves as before.
real_claude=""
# Absolute paths only: the recorded value may be bare \`claude\` (the default),
# and testing that with -x would resolve against this shell's cwd — a file
# named claude in the working directory must never be what gets executed.
case "$configured_claude" in
  /*) [ -x "$configured_claude" ] && real_claude="$configured_claude" ;;
esac
if [ -z "$real_claude" ]; then
  real_claude=$(PATH="$clean_path" command -v claude 2>/dev/null)
fi
if [ -z "$real_claude" ]; then
  echo "ch3: could not find 'claude' — nothing on PATH and no binary recorded in CH3 settings" >&2
  exit 127
fi
if [ "$resolver_status" -ne 0 ] || [ -z "$selected" ]; then
  # The account is UNKNOWN — settings unreadable, or the app bundle moved
  # under us mid-update. Keep whatever this shell already had and say so.
  # Silently unsetting here would drop a long orchestration run onto the
  # default account and burn the wrong plan.
  echo "ch3: could not read the selected Claude account; using CLAUDE_CONFIG_DIR=\${CLAUDE_CONFIG_DIR:-<default>}" >&2
elif [ "$selected" = "default" ]; then
  # The default home is selected: the CLI wants this UNSET.
  unset CLAUDE_CONFIG_DIR
else
  CLAUDE_CONFIG_DIR="$selected"
  export CLAUDE_CONFIG_DIR
fi
PATH="$clean_path"
export PATH
# A tool costs its definition in the context window before anybody calls it,
# so the ones nobody here asked for are switched off by default and turned
# back on per account in Settings. Environment variables where the CLI has
# them, because they cannot be mis-quoted and an older CLI ignores what it
# does not know.
case " $session_tools " in
  *" ${CLAUDE_SESSION_TOOL_TOKENS.artifact} "*)
    CLAUDE_CODE_DISABLE_ARTIFACT=1
    export CLAUDE_CODE_DISABLE_ARTIFACT
    ;;
esac
case " $session_tools " in
  *" ${CLAUDE_SESSION_TOOL_TOKENS.connectors} "*)
    ENABLE_CLAUDEAI_MCP_SERVERS=false
    export ENABLE_CLAUDEAI_MCP_SERVERS
    ;;
esac
# Chrome has no environment variable, only \`--no-chrome\`, and a flag this CLI
# has never heard of is an error before the session starts — every terminal
# broken, by a default nobody chose. So it is passed only when this binary
# advertises it. \`--help\` costs about a tenth of a second against a session
# that takes seconds to come up, and it re-answers itself after an upgrade
# rather than trusting a version number.
case " $session_tools " in
  *" ${CLAUDE_SESSION_TOOL_TOKENS.chrome} "*)
    if "$real_claude" --help </dev/null 2>/dev/null | grep -q -- '--no-chrome'; then
      set -- --no-chrome "$@"
    fi
    ;;
esac
exec "$real_claude" "$@"
`;
}

/** The probe's file name, beside `claude` in the shim directory. */
export const CLAUDE_ACCOUNT_PROBE_FILENAME = "ch3-claude-account";

/**
 * A second script beside the launcher that only *answers* which account the
 * launcher would run as — the directory, or `default` — and exits.
 *
 * For the one caller the launcher cannot reach: a process that is already
 * running. The orchestrator keeps one interactive `claude` per role alive for
 * a whole run, and a live process keeps the account it started with. Before
 * each call the orchestrator runs this probe and compares the answer with the
 * one it recorded when the role was launched; a different answer means the
 * person switched account in the app, and the role is relaunched through the
 * launcher so its next call runs on the new one. Same resolver, so the two
 * can never disagree about what "selected" means.
 *
 * Silent and non-zero when the account cannot be read, so a caller comparing
 * two answers never mistakes "unknown" for "changed".
 */
export function claudeAccountProbeScript(input: {
  readonly nodePath: string;
  readonly resolverPath: string;
}): string {
  return `#!/bin/sh
# CH3: print the Claude account selected in the app right now — the config
# directory \`claude\` would run as, or \`default\` — and nothing else.
resolved=$(ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(input.nodePath)} ${JSON.stringify(input.resolverPath)} 2>/dev/null) || exit 1
selected=$(printf '%s\\n' "$resolved" | sed -n 1p)
[ -n "$selected" ] || exit 1
printf '%s\\n' "$selected"
`;
}

/**
 * Write the shim, and answer whether it is there.
 *
 * Rewritten on every call rather than cached: the settings path is stable, but
 * a reinstall moves the Node binary underneath a stale script, and writing two
 * small files costs nothing next to spawning a shell.
 *
 * Windows returns `false` without writing — a POSIX `sh` launcher would not
 * run there, and the spawn-time `CLAUDE_CONFIG_DIR` still applies. A failed
 * write is not an error either: a shim that could not be written must never
 * cost somebody a terminal.
 */
export const installClaudeAccountShim = Effect.fn("installClaudeAccountShim")(function* (input: {
  readonly shimDir: string;
  readonly settingsPath: string;
  readonly nodePath: string;
  readonly platform: string;
}): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  if (input.platform === "win32") return false;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolverPath = path.join(input.shimDir, "resolve-account.cjs");
  const launcherPath = path.join(input.shimDir, "claude");
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(input.shimDir, { recursive: true });
    // Launcher first, then resolver, and the order is the whole point. These
    // two are written one after the other, so an upgrade has a moment where
    // one is new and the other is old. A NEW launcher with an OLD resolver is
    // harmless: the old one prints a single line, the second line comes back
    // empty, and nothing is switched off. The reverse is not. An OLD launcher
    // captures the new resolver's BOTH lines into one variable and exports
    // `CLAUDE_CONFIG_DIR` as "default\nartifact:off …" — a directory that does
    // not exist, which is "Not logged in" in every terminal on the machine.
    yield* fileSystem.writeFileString(
      launcherPath,
      claudeShimScript({ shimDir: input.shimDir, nodePath: input.nodePath, resolverPath }),
    );
    yield* fileSystem.chmod(launcherPath, 0o755);
    yield* fileSystem.writeFileString(
      resolverPath,
      claudeAccountResolverScript(input.settingsPath),
    );
    // The probe reads the resolver, so it comes last: a probe that appears
    // before its resolver would answer "unknown" for a moment, which callers
    // treat as "do nothing" — harmless, but pointless.
    const probePath = path.join(input.shimDir, CLAUDE_ACCOUNT_PROBE_FILENAME);
    yield* fileSystem.writeFileString(
      probePath,
      claudeAccountProbeScript({ nodePath: input.nodePath, resolverPath }),
    );
    yield* fileSystem.chmod(probePath, 0o755);
    return true;
  }).pipe(Effect.orElseSucceed(() => false));
});

/**
 * The line a person adds to their shell profile so every terminal on the
 * machine — not only the ones CH3 opens — runs `claude` as the selected
 * account.
 *
 * `~/.zshrc` rather than `~/.zshenv` is the recommendation the panel carries:
 * a login shell runs `/etc/zprofile`, whose `path_helper` rebuilds PATH and
 * demotes anything prepended earlier, and `.zshrc` is the first file that runs
 * after it. That covers every interactive shell, tmux panes included. It does
 * not cover `cron` or `ssh host claude`, which read neither file; those keep
 * the account their environment already names.
 */
/**
 * The same environment a CH3 terminal gets: the shim first on `PATH`, and no
 * inherited `CLAUDE_CONFIG_DIR` left to outrank it.
 *
 * Used by anything CH3 spawns that will eventually run `claude` — a
 * terminal, and an orchestrator run, which is a long-lived shell script calling
 * the CLI dozens of times. Those runs used to inherit the app's own environment
 * and so resolved whatever `claude` the login shell had, on the *default*
 * account: a whole multi-repo run burned against an account nobody selected,
 * and every call in it failed on that account's weekly limit while the selected
 * one sat idle.
 *
 * The shim resolves the account **per launch of `claude`**. A run that starts a
 * fresh process per call follows a switch at its next call; the tmux
 * orchestrator, which keeps one process per role alive, follows it by asking
 * the probe beside the shim before each call and relaunching a role whose
 * account moved. Pinning `CLAUDE_CONFIG_DIR` at spawn could do neither.
 */
export function withClaudeAccountShimOnPath<Env extends Record<string, string | undefined>>(
  env: Env,
  shimDir: string,
): Env {
  const next = { ...env } as Record<string, string | undefined>;
  // Windows environment names are case-insensitive, so an inherited
  // `Claude_Config_Dir` is the SAME variable to the CLI while being a different
  // key here. Both spellings go, or the stale one wins.
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() === "CLAUDE_CONFIG_DIR") delete next[key];
  }
  const existing = next["PATH"] ?? next["Path"] ?? "";
  next["PATH"] = existing.length > 0 ? `${shimDir}:${existing}` : shimDir;
  return next as Env;
}

export function claudeShimPathLine(shimDir: string): string {
  return `export PATH="${shimDir}:$PATH"`;
}

/**
 * The line to show in the account panel, or `null` when there is no shim to
 * point at.
 *
 * Installs before answering rather than assuming boot succeeded. The panel is
 * opened rarely and the write is two small files, so the cost buys the one
 * thing the caller actually needs: telling somebody to put a directory first
 * on their `PATH` is only safe advice if there is a working `claude` in it.
 * A failed write — an unwritable home, a `chmod` that did not take — answers
 * `null` and the panel says nothing rather than something wrong.
 */
export const resolveTerminalShimPathLine = Effect.fn("resolveTerminalShimPathLine")(
  function* (input: {
    readonly shimDir: string;
    readonly settingsPath: string;
    readonly nodePath: string;
    readonly platform: string;
  }): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
    const installed = yield* installClaudeAccountShim(input);
    return installed ? claudeShimPathLine(input.shimDir) : null;
  },
);
