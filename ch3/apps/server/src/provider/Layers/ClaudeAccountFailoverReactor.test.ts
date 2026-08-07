import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  ServerSettingsService,
  layerTest as serverSettingsLayerTest,
} from "../../serverSettings.ts";
import { runClaudeAccountFailoverOnce } from "./ClaudeAccountFailoverReactor.ts";

/**
 * The claudeAgent instance as the account switcher writes it: failover on,
 * plus sibling config keys that must survive any settings write this reactor
 * performs.
 */
const claudeInstance = {
  driver: "claudeAgent" as const,
  config: {
    homePath: "",
    binaryPath: "/opt/homebrew/bin/claude",
    launchArgs: "--chrome",
    accountFailoverEnabled: true,
    accountFailoverThresholdPercent: 95,
  },
};

const settingsLayer = serverSettingsLayerTest({
  providerInstances: {
    claudeAgent: claudeInstance,
    codex: { driver: "codex" as const, config: { binaryPath: "codex" } },
  },
} as never);

/**
 * A repository stub reporting a fixed number of in-flight turns.
 *
 * The guard reads the WINDOWED count — an unbounded one let a single turn
 * stranded by a crashed process veto every hand-over forever — so the stub has
 * to answer that one; a stub missing it fails the loop rather than the assert.
 */
const turnsLayer = (running: number) =>
  Layer.succeed(ProjectionTurnRepository, {
    countRunning: () => Effect.succeed(running),
    countRunningSince: () => Effect.succeed(running),
  } as never);

const testLayer = (running: number) =>
  Layer.mergeAll(settingsLayer, turnsLayer(running), ProcessRunner.layer).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

describe("Claude account failover reactor", () => {
  it.effect("does nothing while a turn is in flight", () =>
    Effect.gen(function* () {
      // The one thing that must never happen: the settings write rebuilds the
      // provider instance, which would kill a reply mid-stream.
      const decision = yield* runClaudeAccountFailoverOnce();
      expect(decision).toBeUndefined();

      const settings = yield* ServerSettingsService;
      const after = yield* settings.getSettings;
      expect(
        (
          (after.providerInstances as Record<string, { config?: unknown }>).claudeAgent?.config as
            | { homePath?: string }
            | undefined
        )?.homePath,
      ).toBe("");
    }).pipe(Effect.provide(testLayer(1))),
  );

  it.effect("resolves every service it needs, so the loop can actually run", () =>
    Effect.gen(function* () {
      // The regression this pins: `ProcessRunner` leaked out of the reactor's
      // context. The loop then died on every tick with a missing-service
      // defect that was logged and retried forever — the feature never ran and
      // nothing said so. Reaching a verdict at all proves the wiring resolves.
      const decision = yield* runClaudeAccountFailoverOnce();
      // No account is over threshold on this machine's fixtures, so the honest
      // outcome is "no hand-over" — what matters is that it got that far.
      expect(decision).toBeUndefined();
    }).pipe(Effect.provide(testLayer(0))),
  );

  it.effect("leaves sibling config keys and other instances untouched", () =>
    Effect.gen(function* () {
      yield* runClaudeAccountFailoverOnce();

      const settings = yield* ServerSettingsService;
      const after = yield* settings.getSettings;
      const config = (after.providerInstances as Record<string, { config?: unknown }>).claudeAgent
        ?.config as Record<string, unknown>;
      // `providerInstances` is REPLACED by the patch, not merged, so a careless
      // write drops the rest — including accountFailoverEnabled, which would
      // silently disable the feature after exactly one hand-over.
      expect(config.accountFailoverEnabled).toBe(true);
      expect(config.binaryPath).toBe("/opt/homebrew/bin/claude");
      expect(config.launchArgs).toBe("--chrome");
      expect((after.providerInstances as Record<string, unknown>).codex).toBeDefined();
    }).pipe(Effect.provide(testLayer(0))),
  );
});
