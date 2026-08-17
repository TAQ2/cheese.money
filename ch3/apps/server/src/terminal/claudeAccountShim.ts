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
 * @module claudeAccountShim
 */

/**
 * The resolver, as a standalone script.
 *
 * It re-implements `resolveClaudeInstanceHomePath` rather than importing it:
 * this runs as a bare Node process from a shell, with no bundler and no
 * workspace resolution. The rule is small and pinned by tests on both sides —
 * the shim's own test asserts the two agree.
 */
export function claudeAccountResolverScript(settingsPath: string): string {
  return `'use strict';
// Prints the CLAUDE_CONFIG_DIR the app currently has selected, or nothing at
// all when the default home is selected (which the CLI expects UNSET, not set
// to ~/.claude — an explicit value makes it look for config inside the folder).
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
  for (const id of ordered) {
    const candidate = instances[id]?.config?.homePath;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      home = candidate.trim();
      break;
    }
  }
  // An instance that exists but stores no homePath means the default home,
  // and must not fall through to the legacy block.
  if (home === "" && ordered.length === 0) {
    const legacy = settings.providers?.claudeAgent?.homePath;
    if (typeof legacy === "string") home = legacy.trim();
  }
  if (home !== "") {
    process.stdout.write(path.resolve(home.startsWith("~") ? path.join(os.homedir(), home.slice(1)) : home));
  }
} catch {
  // Silence is the honest answer: the caller leaves the inherited value alone.
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
real_claude=$(PATH="$clean_path" command -v claude 2>/dev/null)
if [ -z "$real_claude" ]; then
  echo "ch3: could not find the real 'claude' on PATH" >&2
  exit 127
fi
selected=$(ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(input.nodePath)} ${JSON.stringify(input.resolverPath)} 2>/dev/null)
if [ -n "$selected" ]; then
  CLAUDE_CONFIG_DIR="$selected"
  export CLAUDE_CONFIG_DIR
else
  # The default home is selected: the CLI wants this UNSET.
  unset CLAUDE_CONFIG_DIR
fi
PATH="$clean_path"
export PATH
exec "$real_claude" "$@"
`;
}
