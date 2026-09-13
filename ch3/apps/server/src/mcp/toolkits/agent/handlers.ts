import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  ProviderInstanceId,
  ThreadId,
} from "@ch3tools/contracts";
import { findMapleModel, MAPLE_MODELS, mapleModelSlug } from "@ch3tools/shared/mapleModels";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentToolkit, DEFAULT_WAIT_SECONDS, SpawnModelAgentError } from "./tools.ts";

const fail = (message: string) => new SpawnModelAgentError({ message });

export const AgentToolkitLayer = AgentToolkit.toLayer({
  spawn_model_agent: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const crypto = yield* Crypto.Crypto;

      // The catalogue accepts either the bare id ("glm-5-3-flash") or the
      // "maple/"-qualified slug OpenCode itself uses; reject anything that
      // resolves to neither, with the full valid list so the caller (an
      // agent, not a person) can retry with a real id instead of guessing.
      const mapleModel = findMapleModel(input.model);
      if (mapleModel === undefined) {
        return yield* fail(
          `"${input.model}" is not a Maple model. Valid ids: ${MAPLE_MODELS.map((model) => model.id).join(", ")}.`,
        );
      }

      const mintId = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => fail(`Could not mint an id: ${String(cause)}`)),
      );

      // The child is parented in the caller's own project, and inherits the
      // caller's runtime mode so a full-access caller does not accidentally
      // hand its delegate a stricter (or looser) approval regime than it
      // itself runs under. A caller thread that has vanished (deleted mid-
      // turn) is a hard failure — there is no project to parent the child
      // in — but a caller whose runtime mode cannot be read for some other
      // reason still gets a sane default rather than blocking delegation.
      const callerThread = yield* snapshots
        .getThreadShellById(scope.threadId)
        .pipe(
          Effect.mapError((cause) => fail(`Could not read the caller thread: ${String(cause)}`)),
        );
      if (Option.isNone(callerThread)) {
        return yield* fail(`Caller thread ${scope.threadId} was not found; cannot parent a child.`);
      }
      const projectId = callerThread.value.projectId;
      const runtimeMode = callerThread.value.runtimeMode ?? "full-access";

      const childThreadId = ThreadId.make(yield* mintId);
      const createCommandId = CommandId.make(`mcp:spawn-model-agent-create:${yield* mintId}`);
      const turnCommandId = CommandId.make(`mcp:spawn-model-agent-turn:${yield* mintId}`);
      const cleanupCommandId = CommandId.make(`mcp:spawn-model-agent-cleanup:${yield* mintId}`);
      const messageId = MessageId.make(yield* mintId);
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode"),
        model: mapleModelSlug(mapleModel.id),
      };

      const trimmedPrompt = input.prompt.trim();
      const promptSnippet =
        trimmedPrompt.length > 60 ? `${trimmedPrompt.slice(0, 60)}…` : trimmedPrompt;
      const title =
        input.title?.trim() ||
        (promptSnippet.length > 0 ? `${mapleModel.name}: ${promptSnippet}` : mapleModel.name);

      // Subscribed BEFORE dispatch, on purpose: `streamDomainEvents` is a hot
      // stream of new events only, so waiting to subscribe until after the
      // dispatch call returns leaves a window where the child's turn could
      // start and finish before anyone is listening, and the completion
      // event would be gone for good. Forking starts the stream consumer
      // running immediately; the dispatch below only happens once it is.
      // What "the child's turn is over" looks like on the event stream. The
      // checkpoint's `thread.turn-diff-completed` is the richest signal: it
      // names the assistant message and says whether the turn errored. But it
      // is emitted only for a git workspace and only after a `turn.completed`,
      // so a child in a non-git project, or one whose turn aborted, would never
      // produce it and the caller would sit out the whole window for a child
      // that had long finished. The session leaving `running` is the signal
      // the projector itself settles a turn on, so it is watched too — only
      // once the turn is seen underway, because a `ready` from the session
      // merely starting arrives before the turn does.
      interface ChildTurnOutcome {
        readonly status: "completed" | "error";
        readonly assistantMessageId: MessageId | null;
      }
      interface ChildTurnWatch {
        readonly underway: boolean;
        readonly done: Option.Option<ChildTurnOutcome>;
      }
      const advance = (watch: ChildTurnWatch, event: OrchestrationEvent): ChildTurnWatch => {
        if (Option.isSome(watch.done)) return watch;
        if (
          event.type === "thread.turn-start-requested" &&
          event.payload.threadId === childThreadId
        ) {
          return { ...watch, underway: true };
        }
        if (
          event.type === "thread.turn-diff-completed" &&
          event.payload.threadId === childThreadId
        ) {
          return {
            underway: true,
            done: Option.some({
              status: event.payload.status === "error" ? "error" : "completed",
              assistantMessageId: event.payload.assistantMessageId,
            }),
          };
        }
        if (event.type === "thread.session-set" && event.payload.threadId === childThreadId) {
          const session = event.payload.session;
          if (session.status === "running" || session.status === "starting") {
            return { ...watch, underway: true };
          }
          if (!watch.underway) return watch;
          const endedCleanly =
            (session.status === "idle" || session.status === "ready") && session.lastError === null;
          return {
            underway: true,
            done: Option.some({
              status: endedCleanly ? "completed" : "error",
              assistantMessageId: null,
            }),
          };
        }
        return watch;
      };
      const initialWatch: ChildTurnWatch = { underway: false, done: Option.none() };
      const waitFiber = yield* engine.streamDomainEvents.pipe(
        Stream.scan(initialWatch, advance),
        Stream.filter((watch) => Option.isSome(watch.done)),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );

      // Create the child thread, THEN start its turn. The `thread.turn.start`
      // command carries a `bootstrap.createThread` block, but the engine's
      // decider never expands it — only the WebSocket entry point does, in
      // `dispatchBootstrapTurnStart`. Dispatched straight into the engine, a
      // turn on a thread that was never created fails the decider's
      // "thread must exist" invariant, so the two commands are issued
      // explicitly here.
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: createCommandId,
          threadId: childThreadId,
          projectId,
          title,
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          // The child works where the caller works. A caller in a linked
          // worktree delegating "fix the failing test on this branch" must not
          // get a child that edits the primary checkout on another branch.
          branch: callerThread.value.branch ?? null,
          worktreePath: callerThread.value.worktreePath ?? null,
          createdAt,
        })
        .pipe(
          Effect.mapError((cause) =>
            fail(`Could not create the child agent's thread: ${String(cause)}`),
          ),
          // The child was never created; nobody will satisfy waitFiber.
          Effect.tapError(() => Fiber.interrupt(waitFiber)),
        );

      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: turnCommandId,
          threadId: childThreadId,
          message: { messageId, role: "user", text: input.prompt, attachments: [] },
          runtimeMode,
          interactionMode: "default",
          createdAt,
        })
        .pipe(
          Effect.mapError((cause) =>
            fail(`Could not start the child agent's turn: ${String(cause)}`),
          ),
          // The turn never started, so the child thread would sit empty. Drop
          // it, and stop the completion watcher that will now never fire.
          Effect.tapError(() =>
            Fiber.interrupt(waitFiber).pipe(
              Effect.andThen(
                engine
                  .dispatch({
                    type: "thread.delete",
                    commandId: cleanupCommandId,
                    threadId: childThreadId,
                  })
                  .pipe(Effect.ignore),
              ),
            ),
          ),
        );

      // Bounded wait: the tool call must return in finite time regardless of
      // how long the child's turn runs. `Effect.timeoutOption` interrupts the
      // *join*, not `waitFiber` itself, so it is interrupted explicitly right
      // after — otherwise a child that never completes leaves a fiber parked
      // on the hot stream forever.
      const waitSeconds = input.waitSeconds ?? DEFAULT_WAIT_SECONDS;
      const outcome = yield* Fiber.join(waitFiber).pipe(
        Effect.timeoutOption(`${waitSeconds} seconds`),
      );
      yield* Fiber.interrupt(waitFiber);

      const finished = Option.flatMap(Option.flatten(outcome), (watch) => watch.done);
      if (Option.isNone(finished)) {
        return {
          threadId: String(childThreadId),
          model: mapleModel.id,
          title,
          status: "running" as const,
          output: null,
        };
      }

      // The checkpoint names the assistant message when it fired; the
      // session-settled path does not, and the checkpoint's own fallback is
      // a synthetic id that matches nothing. Either way, the child's last
      // assistant message is the answer, whether or not an id pointed at it.
      const childThread = yield* snapshots
        .getThreadDetailById(childThreadId)
        .pipe(
          Effect.mapError((cause) => fail(`Could not read the child thread: ${String(cause)}`)),
        );
      const messages = Option.match(childThread, {
        onNone: () => [],
        onSome: (thread) => thread.messages,
      });
      const wantedId = finished.value.assistantMessageId;
      const assistantMessage =
        (wantedId !== null ? messages.find((message) => message.id === wantedId) : undefined) ??
        messages.toReversed().find((message) => message.role === "assistant");

      return {
        threadId: String(childThreadId),
        model: mapleModel.id,
        title,
        status: finished.value.status,
        output: assistantMessage?.text ?? null,
      };
    }),
});
