/**
 * Close background tasks that outlived the process that owned them.
 *
 * A background task belongs to the agent process the server spawned, and it is
 * reported finished by that process. When the server dies — a crash, a
 * reboot, a rebuilt binary — every agent under it dies too, and any task still
 * open at that moment loses the only thing that could ever have closed it. The
 * projection keeps the `task.started` row with no `task.completed` to answer
 * it, and the agent panel keeps rendering the entry with its timer running:
 * observed here with entries counting for over two weeks, and with a task
 * belonging to a command the user had explicitly rejected.
 *
 * So the reconciliation is exact rather than a guess: at boot, an open task is
 * a dead task, with no exceptions to reason about, because nothing the server
 * spawned survives the server. Each one gets the `task.completed` its owner
 * never sent, marked "stopped" — the runtime's word for ended from outside.
 *
 * Runs once, at startup, before any new task can be started.
 *
 * @module OpenBackgroundTaskReconciler
 */

import { CommandId, EventId } from "@ch3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const reconcileOpenBackgroundTasks = Effect.gen(function* () {
  const activities = yield* ProjectionThreadActivityRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const open = yield* activities.listOpenBackgroundTasks();
  if (open.length === 0) return;

  const now = yield* DateTime.now;
  const closedAt = DateTime.formatIso(now);

  yield* Effect.forEach(
    open,
    (task) =>
      Effect.gen(function* () {
        const uuid = yield* crypto.randomUUIDv4;
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:reconcile-open-task:${task.taskId}:${uuid}`),
          threadId: task.threadId,
          activity: {
            id: EventId.make(`reconciled-task-${task.taskId}`),
            createdAt: closedAt,
            tone: "info",
            kind: "task.completed",
            summary: "Task stopped",
            // Not attributed to a turn: the turn that started it is long over,
            // and this row records the server closing the books, not work.
            turnId: null,
            payload: { taskId: task.taskId, status: "stopped" },
          },
          createdAt: closedAt,
        });
        // One task that cannot be closed must not block the rest: a stuck
        // entry is the thing being fixed, so failing the whole sweep over one
        // of them would preserve the bug for every other thread.
      }).pipe(Effect.ignore),
    { discard: true },
  );

  yield* Effect.logInfo("closed background tasks orphaned by a previous run", {
    count: open.length,
  });
}).pipe(
  // Never block startup: the panel being wrong is a display problem, and a
  // server that refuses to boot over it would be a far worse one.
  Effect.catchCause((cause) =>
    Effect.logWarning("failed to reconcile orphaned background tasks", { cause }),
  ),
);

export const OpenBackgroundTaskReconcilerLive = Layer.effectDiscard(reconcileOpenBackgroundTasks);
