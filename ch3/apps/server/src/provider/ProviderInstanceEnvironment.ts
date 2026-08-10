import type { ProviderInstanceEnvironment } from "@ch3tools/contracts";

/**
 * The Node flag the desktop shell forces onto the SERVER's own runtime, in
 * `DesktopBackendConfiguration`, so CH3's own HTTPS works on a managed Mac
 * whose TLS interception is only trusted by the system store.
 *
 * It travels in `NODE_OPTIONS`, and an environment variable is inherited by
 * every descendant — so a flag chosen for one Node process silently lands on
 * every provider CLI the server spawns. Those are not this Node runtime:
 * `claude` and `opencode` ship as Bun binaries that read `NODE_OPTIONS` and
 * handle this flag differently, and the result is not a no-op but a hard
 * break — every HTTPS call fails with "Unable to connect to API: SSL
 * certificate verification failed", regardless of account or model.
 *
 * Verified directly against the installed CLI: the identical `claude -p`
 * command succeeds with a clean environment and fails with this single flag
 * present. It surfaced as thread-title generation failing on every attempt
 * while chat turns kept working — the Claude SDK drops `NODE_OPTIONS` outright
 * when it spawns, so only CH3's own direct spawns carried it.
 *
 * Stripped here rather than at the source because the server genuinely wants
 * the flag for itself; what it must not do is impose a private runtime choice
 * on third-party binaries that manage their own trust store.
 */
const SERVER_ONLY_NODE_OPTION = "--use-system-ca";

/**
 * Removes {@link SERVER_ONLY_NODE_OPTION} while preserving anything the USER
 * put in `NODE_OPTIONS` — the desktop shell appends to that value rather than
 * replacing it, so an unrelated flag (`--max-old-space-size`, say) is sharing
 * the variable and must survive. An emptied variable is deleted rather than
 * left blank, so a child sees "unset" exactly as it would have without CH3.
 */
function withoutServerOnlyNodeOptions(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nodeOptions = env["NODE_OPTIONS"];
  if (nodeOptions === undefined || !nodeOptions.includes(SERVER_ONLY_NODE_OPTION)) {
    return env;
  }

  const retained = nodeOptions
    .split(/\s+/)
    .filter((option) => option.length > 0 && option !== SERVER_ONLY_NODE_OPTION)
    .join(" ");

  const next: NodeJS.ProcessEnv = { ...env };
  if (retained.length > 0) {
    next["NODE_OPTIONS"] = retained;
  } else {
    delete next["NODE_OPTIONS"];
  }
  return next;
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitizedBaseEnv = withoutServerOnlyNodeOptions(baseEnv);
  if (!environment || environment.length === 0) {
    return sanitizedBaseEnv;
  }

  // Applied AFTER the strip so an explicit per-instance NODE_OPTIONS still
  // wins: the user configuring the variable by hand is stating an intent
  // about the child, which is precisely what this function must not override.
  const next: NodeJS.ProcessEnv = { ...sanitizedBaseEnv };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}
