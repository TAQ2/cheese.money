/**
 * Closes out background tasks that the previous process never got to finish.
 *
 * A task is reported done by the process running it. When that process dies —
 * crash, reboot, or an ordinary CH3 restart — every task still in flight
 * loses the only thing that could ever have reported it, and its `task.started`
 * activity stays open forever. The agent strip under the composer treats
 * started-without-completed as "still running", deliberately (a background task
 * outlives its turn, so "the assistant spoke since" is not a sound signal), so
 * those entries sit there with their timers counting up, surviving app restarts
 * and reboots because the row is what is stale, not the view.
 *
 * Nothing in-process can fix that, which is the whole point: the fix has to run
 * in the NEXT process. On boot, any task still open is dead — unless its
 * thread's CLI runs behind a keeper that outlived the restart, in which case
 * the task is exactly as alive as it looks and its own notification will
 * close it. Those threads are read off disk (a keeper's meta file and a live
 * pid), not from the reattach, so this pass does not depend on when the
 * reattach runs. Every other open task gets a closing activity appended.
 *
 * Marked `stopped` rather than `completed` or `failed`: the runtime contract's
 * three outcomes are completed/failed/stopped, and "the process holding it went
 * away" is a stop from outside. Claiming it completed would invent a success
 * that may not have happened, and claiming it failed would invent an error.
 *
 * @module orchestration/Layers/TaskReconciler
 */
import { CommandId, EventId } from "@ch3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

/**
 * A bound on how many closing rows one boot may append.
 *
 * A machine that has been crashing for months could hold a great many open
 * tasks, and appending an unbounded number of commands is the kind of startup
 * work that turns a slow boot into a hung one. The oldest are closed first
 * (the query orders ascending), so a truncated pass still makes progress and
 * the next boot finishes the job.
 */
export const TASK_RECONCILER_MAX_PER_BOOT = 500;

/**
 * Close the task rows a previous server left open, keeping only the threads
 * whose sessions this boot actually took back.
 *
 * The keep-set is passed in rather than guessed from the keeper directory,
 * because guessing was wrong in the direction that never recovers. Reattach
 * admits a keeper on more than a live pid — the socket has to be there, and
 * some instance has to still want it — and a thread that failed either of
 * those extra tests was kept anyway, boot after boot, by a pid check that kept
 * on passing. Its tasks stayed open with nothing left to close them: this
 * function is `listOpenTasks`'s only reader.
 */
export const reconcileOpenTasks = Effect.fn("orchestration.taskReconciler.run")(function* (
  kept: ReadonlySet<string>,
) {
  const activities = yield* ProjectionThreadActivityRepository;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const allOpen = yield* activities.listOpenTasks.pipe(Effect.orElseSucceed(() => []));
  if (allOpen.length === 0) {
    return 0;
  }

  const open = allOpen.filter((task) => !kept.has(task.threadId));
  if (kept.size > 0) {
    yield* Effect.log("orchestration.taskReconciler.kept", {
      threads: kept.size,
      tasksLeftOpen: allOpen.length - open.length,
    });
  }
  if (open.length === 0) {
    return 0;
  }

  const closing = open.slice(0, TASK_RECONCILER_MAX_PER_BOOT);
  if (closing.length < open.length) {
    // Never truncate silently: a reader seeing the strip still populated
    // deserves to know the pass was capped rather than wrong.
    yield* Effect.logWarning("orchestration.taskReconciler.truncated", {
      open: open.length,
      closing: closing.length,
    });
  }

  let closed = 0;
  for (const task of closing) {
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orElseSucceed(() => `${task.taskId}`));
    const appended = yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:task-reconcile:${uuid}`),
        threadId: task.threadId,
        createdAt,
        activity: {
          id: EventId.make(`task-reconcile:${uuid}`),
          tone: "info",
          kind: "task.completed",
          summary: "Task stopped",
          payload: {
            taskId: task.taskId,
            status: "stopped",
            // Says WHY it is being closed. Without this the row reads as a
            // normal stop and the restart it actually records is invisible.
            summary: "Stopped when CH3 restarted.",
            detail: "Stopped when CH3 restarted.",
          },
          turnId: task.turnId,
          createdAt,
        },
      })
      // One unappendable row must not abandon the rest: a thread deleted
      // between the query and the dispatch is the ordinary case here.
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (appended) closed += 1;
  }

  yield* Effect.log("orchestration.taskReconciler.closed", { closed, open: open.length });
  return closed;
});

/**
 * Runs once at boot. Failure is logged and swallowed — a tidy-up pass must
 * never be the reason the server does not come up.
 */
