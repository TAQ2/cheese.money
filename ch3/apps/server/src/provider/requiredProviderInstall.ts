/**
 * Install the providers CH3 cannot run without, when they are missing.
 *
 * CH3 is used by people who do not work in a terminal. For them, "Claude
 * Code is not installed" is not an actionable message — it is a dead app with
 * an instruction they have no way to follow. So the first launch on a machine
 * without it installs it rather than reporting it.
 *
 * Two different jobs, and they are not symmetrical:
 *
 *   - **Claude Code** goes through {@link ClaudeCliInstaller}, which judges the
 *     result by running the binary and falls back to Anthropic's native
 *     installer on a machine with no package manager at all.
 *   - **OpenCode** goes through the maintenance runner's npm command, which is
 *     all it has. A machine with no package manager cannot have it, and
 *     OpenCode is not the spine of the product.
 *
 * **Once per server, and never fatal.** It runs forked from the runtime scope,
 * not from a connection's, because a native install can take minutes and a
 * laptop lid closing must not cancel it halfway. If it fails — no network, a
 * locked global prefix — the provider stays uninstalled and the app behaves
 * exactly as it did before this existed.
 *
 * Deliberately not attempted for a provider the user has disabled: switching a
 * provider off is a decision, and installing it anyway would override it.
 *
 * @module requiredProviderInstall
 */
import type { ProviderDriverKind } from "@ch3tools/contracts";
import * as Effect from "effect/Effect";

import { ClaudeCliInstaller } from "./ClaudeCliInstaller.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";

/**
 * The drivers a working CH3 needs on the machine.
 *
 * Claude is the product's spine — every default model and the response styles
 * assume it. OpenCode carries whatever models its own config points at.
 */
export const REQUIRED_PROVIDER_DRIVERS: ReadonlyArray<string> = ["claudeAgent", "opencode"];

/**
 * Install any required provider this machine is missing.
 *
 * Total: every failure is logged and swallowed. The caller forks this and
 * forgets it.
 */
export const installMissingRequiredProviders = Effect.fn("installMissingRequiredProviders")(
  function* () {
    const providerRegistry = yield* ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner;
    const claudeInstaller = yield* ClaudeCliInstaller;

    const snapshots = yield* providerRegistry.getProviders;

    for (const driver of REQUIRED_PROVIDER_DRIVERS) {
      const snapshot = snapshots.find((candidate) => candidate.driver === driver);
      // No snapshot at all means this build does not ship the driver — nothing
      // to install, and nothing worth complaining about.
      if (!snapshot) continue;
      // Switched off on purpose. Leave it.
      if (!snapshot.enabled) continue;

      if (driver === "claudeAgent") {
        // Asked even when the registry believes it is installed: the registry
        // decides that by resolving a name on the PATH, and the PATH a
        // GUI-launched app inherited is not the one the person's terminal has.
        // The installer probes, and a probe that succeeds costs one `--version`.
        yield* claudeInstaller.ensureInstalled({ reason: "startup" });
        continue;
      }

      if (snapshot.installed) continue;

      yield* Effect.logInfo("Installing a required provider that is missing.", {
        provider: driver,
      });
      yield* runner.updateProvider(driver as ProviderDriverKind).pipe(
        Effect.tap(() =>
          Effect.logInfo("Required provider install finished.", { provider: driver }),
        ),
        // The app still runs; the provider simply stays unavailable and the
        // existing "not installed" surface explains it.
        Effect.catch((cause) =>
          Effect.logWarning("Could not install a required provider.", { provider: driver, cause }),
        ),
      );
    }
  },
);
