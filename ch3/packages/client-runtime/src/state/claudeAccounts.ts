import { WS_METHODS } from "@ch3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

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
  };
}
