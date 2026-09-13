import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@ch3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ORPHANED_TURN_ERROR,
  reconcileOrphanedSessionsAtStartup,
} from "./StartupSessionReconcile.ts";

const now = "2026-09-02T19:29:15.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const instance = ProviderInstanceId.make("claudeAgent");

const shell = (
  id: string,
  session: null | {
    status: "starting" | "running" | "ready" | "stopped";
    activeTurnId: string | null;
  },
) => ({
  id: ThreadId.make(id),
  session:
    session === null
      ? null
      : {
          threadId: ThreadId.make(id),
          status: session.status,
          providerName: "claudeAgent",
          providerInstanceId: instance,
          runtimeMode: "full-access",
          activeTurnId: session.activeTurnId === null ? null : TurnId.make(session.activeTurnId),
          lastError: null,
          updatedAt: now,
        },
});

/**
 * The 2026-09-02 case: the app quit eight seconds into a turn, the relaunched
 * server projected the session still "running", the reaper skipped it for
 * having an active turn, and the row said "Working" until the next message.
 */
describe("reconcileOrphanedSessionsAtStartup", () => {
  it.effect("leaves a thread alone when its session was reattached to a live process", () => {
    const dispatched: Array<{ type: string; threadId: string }> = [];
    const threads = [
      shell("kept-alive", { status: "running", activeTurnId: "turn-kept" }),
      shell("truly-lost", { status: "running", activeTurnId: "turn-lost" }),
    ];
    const engine = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: { type: string; threadId: string }) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as never);
    const snapshots = Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 0, projects: [], threads, updatedAt: now }),
      getThreadShellById: () => Effect.succeed(Option.none()),
    } as never);
    const runtimeRepository = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directory = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository));

    return Effect.gen(function* () {
      const dir = yield* ProviderSessionDirectory;
      for (const id of ["kept-alive", "truly-lost"]) {
        yield* dir.upsert({
          threadId: ThreadId.make(id),
          provider: claude,
          providerInstanceId: instance,
          status: "running",
          resumeCursor: { resume: `session-${id}` },
          runtimePayload: { activeTurnId: `turn-${id}` },
        });
      }

      const result = yield* reconcileOrphanedSessionsAtStartup({
        except: new Set([ThreadId.make("kept-alive")]),
      });

      // Only the thread nobody reattached is settled; the kept one is still
      // running, in the projection and in the directory.
      expect(result.interruptedThreadIds).toEqual([ThreadId.make("truly-lost")]);
      expect(result.stoppedBindingCount).toBe(1);
      expect(dispatched.map((command) => command.threadId)).toEqual(["truly-lost"]);
      const kept = Option.getOrThrow(yield* dir.getBinding(ThreadId.make("kept-alive")));
      expect(kept.status).toBe("running");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(engine, snapshots, directory, runtimeRepository).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("interrupts every projected session still running and stops its binding", () => {
    const dispatched: Array<{ type: string; threadId: string; session?: unknown }> = [];
    const threads = [
      shell("running-mid-turn", { status: "running", activeTurnId: "turn-1" }),
      shell("starting", { status: "starting", activeTurnId: null }),
      shell("finished", { status: "ready", activeTurnId: null }),
      shell("never-started", null),
    ];
    const engine = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: { type: string; threadId: string; session?: unknown }) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as never);
    const snapshots = Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 0, projects: [], threads, updatedAt: now }),
      getThreadShellById: () => Effect.succeed(Option.none()),
    } as never);
    const runtimeRepository = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directory = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository));

    return Effect.gen(function* () {
      const dir = yield* ProviderSessionDirectory;
      // The binding the dead server left behind, with the cursor the next
      // message needs to continue the conversation.
      yield* dir.upsert({
        threadId: ThreadId.make("running-mid-turn"),
        provider: claude,
        providerInstanceId: instance,
        status: "running",
        resumeCursor: { resume: "session-abc" },
        runtimePayload: { activeTurnId: "turn-1" },
      });
      yield* dir.upsert({
        threadId: ThreadId.make("finished"),
        provider: claude,
        providerInstanceId: instance,
        status: "stopped",
        resumeCursor: { resume: "session-def" },
      });

      const result = yield* reconcileOrphanedSessionsAtStartup();

      expect(result.interruptedThreadIds).toEqual([
        ThreadId.make("running-mid-turn"),
        ThreadId.make("starting"),
      ]);
      expect(result.stoppedBindingCount).toBe(1);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.session.set",
        "thread.session.set",
      ]);
      const interrupted = dispatched[0]!.session as {
        status: string;
        activeTurnId: unknown;
        lastError: string;
        providerName: string;
      };
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.activeTurnId).toBeNull();
      expect(interrupted.lastError).toBe(ORPHANED_TURN_ERROR);
      // The rest of the session rides along: the provider is still known.
      expect(interrupted.providerName).toBe("claudeAgent");

      const binding = Option.getOrThrow(yield* dir.getBinding(ThreadId.make("running-mid-turn")));
      expect(binding.status).toBe("stopped");
      // Resume state is the one thing that must survive: it is how the next
      // message continues the conversation instead of starting over.
      expect(binding.resumeCursor).toEqual({ resume: "session-abc" });
      const untouched = Option.getOrThrow(yield* dir.getBinding(ThreadId.make("finished")));
      expect(untouched.status).toBe("stopped");
      expect(untouched.resumeCursor).toEqual({ resume: "session-def" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(engine, snapshots, directory, runtimeRepository).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

  it.effect("does nothing on a clean projection", () => {
    const dispatched: unknown[] = [];
    const engine = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: unknown) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: 1 });
      },
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as never);
    const snapshots = Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [shell("finished", { status: "ready", activeTurnId: null })],
          updatedAt: now,
        }),
    } as never);
    const runtimeRepository = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directory = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository));
    return Effect.gen(function* () {
      const result = yield* reconcileOrphanedSessionsAtStartup();
      expect(result).toEqual({ interruptedThreadIds: [], stoppedBindingCount: 0 });
      expect(dispatched).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(engine, snapshots, directory, runtimeRepository).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});
