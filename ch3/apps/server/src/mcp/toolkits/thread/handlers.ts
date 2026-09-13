import { CommandId } from "@ch3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DEFAULT_AGENT_WORKING_LEASE_SECONDS,
  ThreadAgentWorkingError,
  ThreadToolkit,
} from "./tools.ts";

export const ThreadToolkitLayer = ThreadToolkit.toLayer({
  thread_agent_working: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const engine = yield* OrchestrationEngineService;
      const crypto = yield* Crypto.Crypto;
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ThreadAgentWorkingError({
              message: `Could not mint a command id: ${String(cause)}`,
            }),
        ),
      );

      // Releasing wins over any ttl the caller also passed: "I am done" is
      // never ambiguous, and honouring the ttl instead would re-arm a lease
      // the caller was trying to drop.
      const releasing = input.working === false;
      const now = yield* DateTime.now;
      const ttlSeconds = input.ttlSeconds ?? DEFAULT_AGENT_WORKING_LEASE_SECONDS;
      const agentWorkingUntil = releasing
        ? null
        : DateTime.formatIso(DateTime.addDuration(now, `${ttlSeconds} seconds`));

      yield* engine
        .dispatch({
          type: "thread.kanban.update",
          commandId: CommandId.make(`server:thread-agent-working:${uuid}`),
          threadId: scope.threadId,
          agentWorkingUntil,
          // "user" rather than "classifier": the classifier branch exists to
          // stop a background model from moving a pinned card, and this is a
          // direct assertion from the process doing the work, not a guess.
          source: "user",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadAgentWorkingError({
                message: `Could not update the thread's agent-working lease: ${String(cause)}`,
              }),
          ),
        );

      return { threadId: String(scope.threadId), agentWorkingUntil };
    }),
});
