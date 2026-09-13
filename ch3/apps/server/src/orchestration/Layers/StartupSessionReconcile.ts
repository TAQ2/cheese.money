import { CommandId, type ThreadId } from "@ch3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * What a thread's error banner says about a reply the previous server took
 * with it. Plain about what happened and what to do, because the alternative
 * — "Working" forever — is what people saw.
 */
export const ORPHANED_TURN_ERROR =
  "CH3 restarted while this reply was in progress, so the reply was lost. Send your message again to continue.";

export interface StartupSessionReconcileResult {
  readonly interruptedThreadIds: ReadonlyArray<ThreadId>;
  readonly stoppedBindingCount: number;
}

/**
 * Settle every session the previous server process left running.
 *
 * Provider processes are children of the server: none survives a restart, a
 * crash or a ⌘Q. The graceful path marks their bindings stopped in a
 * finalizer, but a finalizer needs a graceful exit, and the projection's
 * session row is only ever moved by a `thread.session-set` event that the
 * dead process was supposed to send. So a turn that was running when the app
 * quit came back after the relaunch still "running", the row still said
 * "Working", the reaper skipped it *because* it had an active turn, and it
 * stayed that way until the next message forced a resume — eight minutes on
 * the day this was written, and unbounded in general.
 *
 * Runs once, before the reactors start, so the first thing a reconnecting
 * client sees is an interrupted turn with a banner that says what to do.
 * Every projected session in `starting` or `running` becomes `interrupted`
 * with {@link ORPHANED_TURN_ERROR}; every runtime binding not already stopped
 * is stopped. Resume cursors are untouched — the directory merges them — so
 * the next message continues the conversation.
 *
 * Except the threads in `options.except`: those are sessions the provider
 * service has just reattached to a process that outlived the restart. Their
 * projection is still true and their binding is live, so both are left alone.
 */
export const reconcileOrphanedSessionsAtStartup = Effect.fn("reconcileOrphanedSessionsAtStartup")(
  function* (options?: {
    readonly except?: ReadonlySet<ThreadId>;
  }): Effect.fn.Return<
    StartupSessionReconcileResult,
    never,
    OrchestrationEngineService | ProjectionSnapshotQuery | ProviderSessionDirectory | Crypto.Crypto
  > {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;
    const now = DateTime.formatIso(yield* DateTime.now);

    let stoppedBindingCount = 0;
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    const except = options?.except ?? new Set<ThreadId>();
    for (const binding of bindings) {
      if (binding.status === "stopped") continue;
      if (except.has(binding.threadId)) continue;
      const providerInstanceId = binding.providerInstanceId;
      if (providerInstanceId === undefined) continue;
      yield* directory
        .upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.startup.reconcile",
            lastRuntimeEventAt: now,
          },
        })
        .pipe(
          Effect.map(() => {
            stoppedBindingCount += 1;
          }),
          Effect.catch((error) =>
            Effect.logWarning("startup reconcile could not stop a stale provider binding", {
              threadId: binding.threadId,
              error,
            }),
          ),
        );
    }

    const threads = yield* snapshots.getShellSnapshot().pipe(
      Effect.map((snapshot) => snapshot.threads),
      Effect.orElseSucceed(() => []),
    );
    const interruptedThreadIds: ThreadId[] = [];
    for (const thread of threads) {
      if (except.has(thread.id)) continue;
      const session = thread.session;
      if (!session || (session.status !== "running" && session.status !== "starting")) continue;
      const commandId = CommandId.make(
        `server:startup-reconcile:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
      );
      yield* engine
        .dispatch({
          type: "thread.session.set",
          commandId,
          threadId: thread.id,
          session: {
            ...session,
            status: "interrupted",
            activeTurnId: null,
            lastError: ORPHANED_TURN_ERROR,
            // A synthetic message, not a `runtime.error` event's
            // classification; any prior class no longer describes it.
            lastErrorClass: null,
            updatedAt: now,
          },
          createdAt: now,
        })
        .pipe(
          Effect.map(() => {
            interruptedThreadIds.push(thread.id);
          }),
          Effect.catch((error) =>
            Effect.logWarning("startup reconcile could not interrupt an orphaned session", {
              threadId: thread.id,
              error,
            }),
          ),
        );
    }

    if (interruptedThreadIds.length > 0 || stoppedBindingCount > 0) {
      yield* Effect.logInfo("startup reconcile settled sessions the previous server left running", {
        interruptedThreadIds,
        stoppedBindingCount,
      });
    }
    return { interruptedThreadIds, stoppedBindingCount };
  },
);
