import { WS_METHODS } from "@ch3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * The usage band's read cadence. One query per environment (all threads' bands
 * share it), so this is the WHOLE app's fallback poll of the rate-limited
 * usage endpoint — three minutes, per the design, versus the old 30s-per-open-
 * thread statusline poll. The stale window collapses a burst of band mounts
 * (opening several threads at once) into one read.
 */
const CLAUDE_USAGE_BAND_REFRESH_MS = 3 * 60_000;
const CLAUDE_USAGE_BAND_STALE_MS = 60_000;

/**
 * Claude account profiles: listing who each `CLAUDE_CONFIG_DIR` is signed in
 * as, and signing a new one in. All three run over the CLI's local control
 * channel — no model requests, no token cost.
 *
 * These are commands rather than polling queries: listing spawns one probe
 * per profile, so it runs when the user opens the switcher, not on a timer.
 */
export function createClaudeAccountEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    listProfiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude:list-account-profiles",
      tag: WS_METHODS.claudeListAccountProfiles,
    }),
    startLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude:start-account-login",
      tag: WS_METHODS.claudeStartAccountLogin,
    }),
    awaitLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude:await-account-login",
      tag: WS_METHODS.claudeAwaitAccountLogin,
    }),
    cancelLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude:cancel-account-login",
      tag: WS_METHODS.claudeCancelAccountLogin,
    }),
    signOut: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude:sign-out-account",
      tag: WS_METHODS.claudeSignOutAccount,
    }),
    /**
     * Read ONE account's usage now, past its freshness window and past the
     * pause the endpoint asked for.
     *
     * A command, never a query: nothing may put this on a timer. Automatic
     * retries inside a rate-limit penalty are what left an account's reading
     * nine hours old in the first place, so the only thing allowed to spend
     * one of these is a person pressing a button.
     */
    forceUsageRead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude:force-account-usage-read",
      tag: WS_METHODS.claudeForceAccountUsageRead,
    }),
    /**
     * Install the Claude Code CLI on the machine this environment runs on.
     *
     * A command rather than a query: it changes the machine, it can take
     * minutes, and nothing should re-run it on a refresh.
     */
    installCli: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:claude:install-cli",
      tag: WS_METHODS.claudeInstallCli,
    }),
    // The in-use account's usage, for the native band under the composer.
    // A query (auto-refreshing) rather than a command, keyed only by
    // environment, so it is one shared read fanned out to every thread's band.
    currentUsage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:claude:current-usage",
      tag: WS_METHODS.claudeCurrentAccountUsage,
      refreshIntervalMs: CLAUDE_USAGE_BAND_REFRESH_MS,
      staleTimeMs: CLAUDE_USAGE_BAND_STALE_MS,
    }),
  };
}
