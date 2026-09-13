import { ThreadId } from "@ch3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { reconcileOpenTasks } from "./TaskReconciler.ts";

const kept = ThreadId.make("thread-came-back");
const lost = ThreadId.make("thread-did-not");

const openTask = (threadId: ThreadId, taskId: string) => ({
  threadId,
  taskId,
  turnId: undefined,
});

const harness = () => {
  const dispatched: Array<{ threadId: string; taskId: string }> = [];
  const activities = {
    listOpenTasks: Effect.succeed([openTask(kept, "task-kept"), openTask(lost, "task-lost")]),
  } as unknown as typeof ProjectionThreadActivityRepository.Service;
  const engine = {
    dispatch: (command: {
      readonly threadId: string;
      readonly activity: { readonly payload: { readonly taskId: string } };
    }): Effect.Effect<void> =>
      Effect.sync(() => {
        dispatched.push({ threadId: command.threadId, taskId: command.activity.payload.taskId });
      }),
  } as unknown as typeof OrchestrationEngineService.Service;
  return {
    dispatched,
    layer: Layer.mergeAll(
      Layer.succeed(ProjectionThreadActivityRepository, activities),
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(Crypto.Crypto, {
        randomUUIDv4: Effect.succeed("00000000-0000-4000-8000-000000000000"),
      } as unknown as Crypto.Crypto),
    ),
  };
};

describe("reconcileOpenTasks", () => {
  /**
   * The keep-set is the boot's own reattach result, and nothing else. It used
   * to be inferred from a live keeper pid, which is a weaker test than the one
   * reattach applies: a keeper whose socket was gone, or whose provider
   * instance no longer existed, was never adopted and yet kept passing the pid
   * check on every boot — so its tasks stayed open with nothing left to close
   * them, this being `listOpenTasks`'s only reader.
   */
  it.effect("closes the tasks of a thread that did not come back", () =>
    Effect.gen(function* () {
      const test = harness();
      const closed = yield* reconcileOpenTasks(new Set<string>([kept])).pipe(
        Effect.provide(test.layer),
      );
      assert.equal(closed, 1);
      assert.deepEqual(test.dispatched, [{ threadId: lost, taskId: "task-lost" }]);
    }),
  );

  it.effect("leaves alone the tasks of a thread it did take back", () =>
    Effect.gen(function* () {
      const test = harness();
      yield* reconcileOpenTasks(new Set<string>([kept, lost])).pipe(Effect.provide(test.layer));
      assert.deepEqual(test.dispatched, []);
    }),
  );
});
