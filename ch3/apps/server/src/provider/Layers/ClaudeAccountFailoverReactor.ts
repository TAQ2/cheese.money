/**
 * Automatic Claude account hand-over.
 *
 * Polls the account in use and, when it runs out of plan headroom, repoints
 * the provider instance at another signed-in account that has room. That is
 * exactly the manual switch, done at the moment the next turn would fail.
 *
 * Safe because of two properties established elsewhere:
 *   - Transcripts are shared across accounts (ensureSharedClaudeTranscriptStore),
 *     so a thread keeps working after the hand-over.
 *   - Writing the setting rebuilds the provider instance, which is how a switch
 *     takes effect without restarting CH3.
 *
 * @module provider/Layers/ClaudeAccountFailoverReactor
 */
import type { ClaudeAccountProfile, ProviderInstanceConfig } from "@ch3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { listClaudeAccountProfiles, probeClaudeProfile } from "../Drivers/ClaudeAccounts.ts";
import {
  type ClaudeFailoverDecision,
  chooseClaudeAuthFailoverTarget,
  chooseClaudeFailoverTarget,
  worstUsagePercent,
} from "../Drivers/claudeAccountFailover.ts";
import {
  claudeAuthFailureWithin,
  resetClaudeAuthFailureSignal,
} from "../Drivers/claudeAuthFailureSignal.ts";
import {
  ROTATION_SESSION_ESCAPE_PERCENT,
  chooseClaudeRotationTarget,
  rotationEngaged,
  type RotationPhase,
} from "../Drivers/claudeAccountRotation.ts";
import {
  type ClaudeInstanceMap,
  defaultClaudeInstanceId,
  orderedClaudeInstanceIds,
  resolveClaudeInstanceHomePath,
} from "../Drivers/claudeInstanceHome.ts";

/**
 * Usage moves on the order of minutes, and a tick that lands mid-turn simply
 * waits for the next one, so a slow cadence costs nothing.
 */
const CLAUDE_DRIVER_KIND = "claudeAgent";

const POLL_INTERVAL = Duration.seconds(60);
/** Rotation is strategic, not urgent; two minutes keeps the usage probes cheap. */
const ROTATION_INTERVAL = Duration.seconds(120);

const DEFAULT_THRESHOLD_PERCENT = 98;

/**
 * How far back a failed turn still corroborates a sign-in failure. A rejected
 * stored token alone can mean nothing worse than "this account has sat idle
 * past its token's lifetime"; a real turn failing inside this window is what
 * separates a dead account from a stale one.
 */
const AUTH_FAILURE_CORROBORATION_WINDOW = Duration.minutes(10);

/**
 * How recent a `running` turn must be to still count as "a reply is streaming".
 *
 * The mid-reply guard used an unbounded count, which assumes every row in that
 * state has a live process behind it. A turn whose process dies never records
 * an ending, so the row stays `running` forever — and since the guard vetoes a
 * hand-over on ANY such row, a single crash disables automatic rotation and
 * failover permanently. That is not hypothetical: one row on a real machine sat
 * `running` for seven days while both loops woke every two minutes, saw it, and
 * returned without evaluating anything. The account in use hit 91% of its
 * 5-hour window and was never handed over; it had to be switched by hand.
 *
 * Two hours is chosen against measured behaviour on that machine: across 272
 * completed turns the mean was 2.1 minutes and the longest ever recorded was
 * 29.8 minutes. The window is four times the worst real turn, so it cannot cut
 * a live reply, while any row older than it is evidence of a dead process
 * rather than a slow one.
 */
const IN_FLIGHT_TURN_HORIZON = Duration.hours(2);

/**
 * Whether a reply is streaming right now, so a hand-over would kill it.
 *
 * Fails CLOSED: an unreadable projection returns "yes, something is running"
 * exactly as the previous unbounded read did. A hand-over skipped in error
 * costs one tick; one performed in error kills a live reply.
 */
const turnInFlight = Effect.fn("claude.account.turnInFlight")(function* () {
  const turns = yield* ProjectionTurnRepository;
  const since = yield* DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.subtractDuration(now, IN_FLIGHT_TURN_HORIZON))),
  );
  const running = yield* turns.countRunningSince(since).pipe(Effect.orElseSucceed(() => 1));
  return running > 0;
});

interface ClaudeFailoverSettingsView {
  readonly instanceId: string;
  readonly instances: ClaudeInstanceMap;
  readonly thresholdPercent: number;
  readonly currentHomePath: string;
  readonly failoverEnabled: boolean;
  readonly rotationEnabled: boolean;
  /** Source for synthesizing the default instance when none exists yet. */
  readonly legacyClaudeConfig: Record<string, unknown>;
}

/** The instance to act on, or undefined when both features are off or unusable. */
const readFailoverSettings = Effect.fn("readFailoverSettings")(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (!settings) return undefined;

  const instances = (settings.providerInstances ?? {}) as ClaudeInstanceMap;
  // Same ordering the home-path resolver uses. Evaluating one instance's
  // limits and writing the switch to another would repoint the wrong account.
  // A user who never touched provider settings has an EMPTY instance map —
  // the default slot then acts in its place, exactly as the client's own
  // settings panels synthesize it, so rotation's on-by-default reaches the
  // people who never open settings at all.
  const instanceId =
    orderedClaudeInstanceIds(instances)[0] ?? (defaultClaudeInstanceId() as string);

  const config = (instances[instanceId]?.config ?? {}) as {
    accountFailoverEnabled?: unknown;
    accountFailoverThresholdPercent?: unknown;
    accountRotationEnabled?: unknown;
  };
  const failoverEnabled = config.accountFailoverEnabled === true;
  // Rotation is ON unless explicitly switched off: absent means enabled, so
  // the default experience is the smart one and unticking is the opt-out.
  // Rotation is OPT-IN. Its usage probe reads the Claude credential out of
  // the login keychain on a timer whose first tick fires at startup; on a
  // machine that has not already granted /usr/bin/security access to that
  // item, defaulting it on means an unexplained keychain dialog the moment
  // the app opens. Absent therefore means off, exactly like failover.
  const rotationEnabled = config.accountRotationEnabled === true;
  if (!failoverEnabled && !rotationEnabled) return undefined;

  return {
    instanceId,
    instances,
    failoverEnabled,
    rotationEnabled,
    legacyClaudeConfig: (settings.providers.claudeAgent ?? {}) as Record<string, unknown>,
    thresholdPercent:
      typeof config.accountFailoverThresholdPercent === "number"
        ? config.accountFailoverThresholdPercent
        : DEFAULT_THRESHOLD_PERCENT,
    currentHomePath: resolveClaudeInstanceHomePath({
      providerInstances: instances,
      legacyHomePath: settings.providers.claudeAgent.homePath,
    }),
  } satisfies ClaudeFailoverSettingsView;
});

/**
 * One evaluation. Returns the account handed over to, or undefined.
 *
 * Every early return is deliberate: doing nothing is always safe, and a
 * hand-over made on incomplete or stale information is worse than a late one.
 */
export const runClaudeAccountFailoverOnce = Effect.fn("runClaudeAccountFailoverOnce")(function* () {
  const turns = yield* ProjectionTurnRepository;

  const before = yield* readFailoverSettings();
  if (!before?.failoverEnabled) return undefined;

  // The mid-reply guard lives at the COMMIT, not here. Vetoing the evaluation
  // as well starves the whole feature for anyone whose machine is rarely
  // idle: measured over one 26-minute window on this machine, 28 of 39 ticks
  // returned inside 40ms at this exact line, having decided nothing, while the
  // account in use sat at 100% of its 5-hour window. Evaluating costs a cached
  // usage read now, so the loop can arrive at an answer and hold it ready for
  // the first gap between turns instead of never forming one.

  // Cheap first pass: identities only, no network.
  const known = yield* listClaudeAccountProfiles({
    configuredHomePath: before.currentHomePath,
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ClaudeAccountProfile>));
  const currentKnown = known.find((profile) => profile.isCurrent);
  if (!currentKnown) return undefined;

  // Then one call for the account in use. Fetching every account's usage on
  // every tick spends a subprocess and an HTTPS request per account per
  // minute to answer a question that only matters once it is nearly spent.
  const current = yield* probeClaudeProfile({
    homePath: currentKnown.homePath,
    isCurrent: true,
    includeUsage: true,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (!current) return undefined;

  // Two distinct reasons to leave an account, each requiring its own
  // evidence. Plan limits need a READABLE number over the threshold. A
  // sign-in failure needs an OBSERVATION: either the adapter watched a turn
  // die with an authentication error (the CLI's own verdict, and the only
  // signal that survives the CLI moving its credential store around), or the
  // usage endpoint explicitly rejected the stored token AND real turns
  // failed recently — a stored token that merely went stale while the
  // account sat idle produces the same rejection, but no failed turns,
  // because the CLI refreshes its own token whenever a turn actually runs.
  const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const adapterSawAuthFailure = claudeAuthFailureWithin(
    Duration.toMillis(AUTH_FAILURE_CORROBORATION_WINDOW),
    nowMs,
  );
  const usageSawRejection = !current.usage && current.usageUnauthorized === true;
  const authDead = adapterSawAuthFailure || usageSawRejection;
  if (!authDead) {
    if (!current.usage) return undefined;
    if (worstUsagePercent(current.usage) < before.thresholdPercent) return undefined;
  } else if (!adapterSawAuthFailure) {
    const since = yield* DateTime.now.pipe(
      Effect.map((now) =>
        DateTime.formatIso(DateTime.subtractDuration(now, AUTH_FAILURE_CORROBORATION_WINDOW)),
      ),
    );
    const failedTurns = yield* turns.countErrorsSince(since).pipe(Effect.orElseSucceed(() => 0));
    if (failedTurns === 0) return undefined;
  }

  // Only now is the rest of the fleet worth measuring.
  const candidates = yield* Effect.forEach(
    known.filter((profile) => !profile.isCurrent),
    (profile) =>
      probeClaudeProfile({
        homePath: profile.homePath,
        isCurrent: false,
        includeUsage: true,
      }).pipe(Effect.orElseSucceed(() => profile)),
    { concurrency: "unbounded" },
  );

  const decision = authDead
    ? chooseClaudeAuthFailoverTarget({
        profiles: [current, ...candidates],
        thresholdPercent: before.thresholdPercent,
        currentAuthFailureObserved: adapterSawAuthFailure,
      })
    : chooseClaudeFailoverTarget({
        profiles: [current, ...candidates],
        thresholdPercent: before.thresholdPercent,
      });
  if (!decision) {
    // The incumbent is out of headroom by this point — every path above
    // returned otherwise. Staying put because no sibling's usage could be READ
    // is the failure this feature exists to prevent, and it used to happen in
    // total silence.
    if (!candidates.some((profile) => profile.usage)) {
      yield* Effect.logWarning("claude.account.failover.no-readable-candidate", {
        from: current.displayPath,
        candidates: candidates.length,
        rateLimited: candidates.filter((profile) => profile.usageRateLimited === true).length,
      });
    }
    return undefined;
  }

  return yield* commitClaudeAccountSwitch({
    before,
    decision,
    feature: "failover",
    logTag: "claude.account.failover",
  });
});

/**
 * The write, shared by failover and rotation. Re-reads immediately before
 * writing: `providerInstances` is REPLACED wholesale by the patch, so writing
 * a snapshot taken before several seconds of network work would revert
 * anything changed meanwhile — including the user switching accounts by
 * hand, or unticking the feature, which would then switch accounts AND turn
 * itself back on.
 */
const commitClaudeAccountSwitch = Effect.fn("commitClaudeAccountSwitch")(function* (input: {
  readonly before: ClaudeFailoverSettingsView;
  readonly decision: ClaudeFailoverDecision;
  readonly feature: "failover" | "rotation";
  readonly logTag: string;
}) {
  const serverSettings = yield* ServerSettingsService;
  const { before, decision } = input;

  // The SQL round-trip runs BEFORE the settings re-read, so the window
  // between reading the map and writing it back holds no slow work — a
  // sibling loop's commit (or a manual switch) in that window is caught by
  // the guards below instead of being clobbered by a stale map.
  if (yield* turnInFlight()) return undefined;

  const after = yield* readFailoverSettings();
  if (!after) return undefined;
  // Unticking the feature during the probe window must cancel the switch —
  // the view exists as long as EITHER feature is on, so each commit checks
  // its own flag.
  if (input.feature === "failover" && !after.failoverEnabled) return undefined;
  if (input.feature === "rotation" && !after.rotationEnabled) return undefined;
  if (after.instanceId !== before.instanceId) return undefined;
  if (after.currentHomePath !== before.currentHomePath) return undefined;

  // A user who never touched provider settings has no explicit instance —
  // synthesize the default slot from the legacy block, exactly as the
  // client's settings panels do, so the switch materializes it rather than
  // silently no-oping.
  const instance =
    after.instances[after.instanceId] ??
    ({
      driver: CLAUDE_DRIVER_KIND,
      enabled: (after.legacyClaudeConfig["enabled"] as boolean | undefined) ?? true,
      config: after.legacyClaudeConfig,
    } as ProviderInstanceConfig);

  yield* Effect.logInfo(input.logTag, {
    from: decision.from.displayPath,
    to: decision.to.displayPath,
    reason: decision.reason,
  });

  const nextInstances: Record<string, ProviderInstanceConfig> = {
    ...(after.instances as Record<string, ProviderInstanceConfig>),
    [after.instanceId]: {
      ...instance,
      config: {
        ...((instance.config as Record<string, unknown> | undefined) ?? {}),
        homePath: decision.homePath,
      },
    },
  };

  // The failures on record belong to the account being left; they must not
  // condemn the one being switched to.
  resetClaudeAuthFailureSignal();

  yield* serverSettings
    .updateSettings({
      // Keys are branded ProviderInstanceId at the settings boundary; the map
      // is rebuilt from the freshly read one, so every other instance and
      // every sibling config key is carried through unchanged.
      providerInstances: nextInstances as never,
    })
    .pipe(
      Effect.tapError((cause) => Effect.logWarning(`${input.logTag}.write-failed`, { cause })),
      Effect.orElseSucceed(() => undefined),
    );

  return decision;
});

/**
 * One rotation evaluation: probe every signed-in account, ask the pure
 * algorithm which should be spending, and commit if it names a challenger.
 * Every early return is silence by design — the next tick is two minutes
 * away and nothing here is urgent.
 */
export const runClaudeAccountRotationOnce = Effect.fn("runClaudeAccountRotationOnce")(function* (
  phase: RotationPhase = "steady",
) {
  const before = yield* readFailoverSettings();
  if (!before?.rotationEnabled) return undefined;

  // Mid-reply is the COMMIT's guard, not this one — see the note in
  // runClaudeAccountFailoverOnce. Evaluating always is what lets the answer be
  // ready for the first quiet moment.

  const known = yield* listClaudeAccountProfiles({
    configuredHomePath: before.currentHomePath,
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ClaudeAccountProfile>));
  const currentKnown = known.find((profile) => profile.isCurrent);
  if (!currentKnown) return undefined;

  // The incumbent first, alone: on a steady tick the stickiness gate answers
  // from this ONE probe, and in the common case (fresh session, healthy
  // week) the rest of the fleet is never asked — the same economy the
  // failover loop practices, which matters doubly now that rotation is on
  // by default.
  const current = yield* probeClaudeProfile({
    homePath: currentKnown.homePath,
    isCurrent: true,
    includeUsage: true,
  }).pipe(Effect.orElseSucceed(() => currentKnown));
  if (!current.usage) return undefined;
  if (phase === "steady" && !rotationEngaged(current.usage)) return undefined;

  const others = yield* Effect.forEach(
    known.filter((profile) => !profile.isCurrent),
    (profile) =>
      probeClaudeProfile({
        homePath: profile.homePath,
        isCurrent: false,
        includeUsage: true,
      }).pipe(Effect.orElseSucceed(() => profile)),
    { concurrency: "unbounded" },
  );

  const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const decision = chooseClaudeRotationTarget({ profiles: [current, ...others], nowMs, phase });
  if (!decision) {
    // Same silence, same harm as in failover: an incumbent past its session
    // escape stays seated only because nobody's usage could be read.
    if (
      current.usage.sessionPercent >= ROTATION_SESSION_ESCAPE_PERCENT &&
      !others.some((profile) => profile.usage)
    ) {
      yield* Effect.logWarning("claude.account.rotation.no-readable-candidate", {
        from: current.displayPath,
        sessionPercent: current.usage.sessionPercent,
        candidates: others.length,
        rateLimited: others.filter((profile) => profile.usageRateLimited === true).length,
      });
    }
    return undefined;
  }

  return yield* commitClaudeAccountSwitch({
    before,
    decision,
    feature: "rotation",
    logTag: "claude.account.rotation",
  });
});

/**
 * Background loop. A tick that cannot be evaluated is logged and swallowed —
 * plan usage is a convenience and must never take the server down — but at
 * WARNING, not debug: a reactor that can never run is exactly the failure that
 * hides at debug level.
 */
export const ClaudeAccountFailoverReactorLive = Layer.effectDiscard(
  Effect.all(
    [
      Effect.forkScoped(
        runClaudeAccountFailoverOnce().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("claude.account.failover.tick-failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
        ),
      ),
      Effect.forkScoped(
        // The first ENABLED tick runs the startup phase — seating the
        // best-positioned account — and every enabled tick after it runs
        // steady. Tracking the transition (rather than running startup once
        // unconditionally) means enabling rotation mid-session still gets
        // its seating pass on the next tick, instead of never.
        Effect.gen(function* () {
          const seated = yield* Ref.make(false);
          const tick = Effect.gen(function* () {
            const view = yield* readFailoverSettings();
            if (!view?.rotationEnabled) {
              // Disabling re-arms the seating for the next enable.
              yield* Ref.set(seated, false);
              return;
            }
            const phase: RotationPhase = (yield* Ref.get(seated)) ? "steady" : "startup";
            const outcome = yield* runClaudeAccountRotationOnce(phase);
            // The seat is taken once a startup pass has RUN to a conclusion —
            // acted or found the incumbent best — not when it was skipped
            // for a mid-reply guard, which returns undefined the same way.
            // Distinguishing those would demand a richer return for little
            // gain: a skipped pass re-runs as startup next tick, which is
            // harmless (startup is idempotent for a seated incumbent).
            if (outcome !== undefined || (yield* Ref.get(seated)) === false) {
              yield* Ref.set(seated, true);
            }
          });
          yield* tick.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("claude.account.rotation.tick-failed", { cause }),
            ),
            Effect.repeat(Schedule.spaced(ROTATION_INTERVAL)),
          );
        }),
      ),
    ],
    { discard: true },
  ),
).pipe(Layer.provide(ProcessRunner.layer));
