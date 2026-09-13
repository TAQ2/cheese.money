import type { ServerProvider } from "@ch3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ClaudeCliInstaller } from "./ClaudeCliInstaller.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import { installMissingRequiredProviders } from "./requiredProviderInstall.ts";

/** Tagged, so the failure channel stays typed rather than collecting bare Errors. */
class InstallFailure extends Data.TaggedError("InstallFailure")<{ readonly detail: string }> {}

function snapshot(input: {
  driver: string;
  installed: boolean;
  enabled?: boolean;
}): ServerProvider {
  return {
    driver: input.driver,
    installed: input.installed,
    enabled: input.enabled ?? true,
  } as unknown as ServerProvider;
}

const harness = (
  providers: ReadonlyArray<ServerProvider>,
  options?: { readonly updateFails?: boolean },
) =>
  Effect.gen(function* () {
    const asked = yield* Ref.make<Array<string>>([]);
    const claudeChecks = yield* Ref.make<Array<string>>([]);
    const layer = Layer.mergeAll(
      Layer.succeed(ProviderRegistry, {
        getProviders: Effect.succeed(providers),
      } as unknown as ProviderRegistry["Service"]),
      Layer.succeed(ProviderMaintenanceRunner, {
        updateProvider: (target: unknown) =>
          options?.updateFails === true
            ? Effect.fail(new InstallFailure({ detail: "npm not found" }))
            : Ref.update(asked, (seen) => [...seen, String(target)]).pipe(
                Effect.as({ providers: [] }),
              ),
      } as unknown as ProviderMaintenanceRunner["Service"]),
      Layer.succeed(ClaudeCliInstaller, {
        ensureInstalled: (input: { readonly reason: string }) =>
          Ref.update(claudeChecks, (seen) => [...seen, input.reason]).pipe(
            Effect.as({ ok: true, binaryPath: "/tmp/claude", detail: "Claude Code is installed." }),
          ),
      } as unknown as ClaudeCliInstaller["Service"]),
    );
    yield* installMissingRequiredProviders().pipe(Effect.provide(layer));
    return { asked: yield* Ref.get(asked), claudeChecks: yield* Ref.get(claudeChecks) };
  });

it.effect("hands Claude Code to the installer that can actually verify it", () =>
  Effect.gen(function* () {
    // Asked even though the registry says it is installed: the registry decides
    // that by resolving a name on the PATH, and a GUI-launched app's PATH is
    // not the terminal's. The installer probes instead, which costs one
    // `--version` on a machine that is already fine.
    const { asked, claudeChecks } = yield* harness([
      snapshot({ driver: "claudeAgent", installed: true }),
    ]);

    assert.deepEqual(claudeChecks, ["startup"]);
    assert.deepEqual(asked, []);
  }),
);

it.effect("installs a missing OpenCode through the package manager", () =>
  Effect.gen(function* () {
    const { asked } = yield* harness([snapshot({ driver: "opencode", installed: false })]);

    assert.deepEqual(asked, ["opencode"]);
  }),
);

it.effect("leaves an installed OpenCode alone", () =>
  Effect.gen(function* () {
    const { asked } = yield* harness([snapshot({ driver: "opencode", installed: true })]);

    assert.deepEqual(asked, []);
  }),
);

it.effect("never installs a provider the user switched off", () =>
  Effect.gen(function* () {
    // Disabling a provider is a decision. Installing it anyway overrules it.
    const { asked, claudeChecks } = yield* harness([
      snapshot({ driver: "claudeAgent", installed: false, enabled: false }),
      snapshot({ driver: "opencode", installed: false, enabled: false }),
    ]);

    assert.deepEqual(asked, []);
    assert.deepEqual(claudeChecks, []);
  }),
);

it.effect("keeps starting when an install fails", () =>
  Effect.gen(function* () {
    // No package manager, no network, a locked global prefix. The app comes up
    // exactly as it did before: an install that cannot happen must not stop the
    // server.
    const result = yield* harness([snapshot({ driver: "opencode", installed: false })], {
      updateFails: true,
    }).pipe(Effect.exit);

    assert.ok(result._tag === "Success");
  }),
);
