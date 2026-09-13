/**
 * `spawn_model_agent` exercised the way a provider actually reaches it: by
 * name, through a real `McpServer`, the way `contribution/handlers.test.ts`
 * exercises its own toolkit. `OrchestrationEngineService` and
 * `ProjectionSnapshotQuery` are faked so the test controls exactly when the
 * child's turn "completes", without a real orchestration engine or database.
 */
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ch3tools/contracts";
import { MAPLE_MODELS } from "@ch3tools/shared/mapleModels";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentToolkitRegistrationLive } from "../../McpHttpServer.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-agent-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** Every string anywhere in a value, mirroring `contribution/handlers.test.ts`. */
const allText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(allText).join(" ");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, nested]) => `${key} ${allText(nested)}`)
      .join(" ");
  }
  return String(value);
};

const now = "2026-09-06T00:00:00.000Z";
const callerThreadId = ThreadId.make("caller-thread");
const projectId = ProjectId.make("project-1");

const callerThreadShell = {
  id: callerThreadId,
  projectId,
  title: "Caller thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-x" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/worktree-branch",
  worktreePath: "/tmp/ch3-worktrees/feature",
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
} as unknown as OrchestrationThreadShell;

const emptyChildThreadDetail = {
  id: ThreadId.make("unused-child-detail"),
  messages: [],
} as unknown as OrchestrationThread;

const invocationScope: McpInvocationContext.McpInvocationScope = {
  environmentId: "env-1" as EnvironmentId,
  threadId: callerThreadId,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(),
  issuedAt: 0,
};

interface Fakes {
  readonly events: Queue.Queue<OrchestrationEvent>;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly createdThreadIds: Ref.Ref<ReadonlySet<string>>;
  readonly firstDispatch: Deferred.Deferred<OrchestrationCommand>;
  readonly childThreadDetail?: OrchestrationThread;
}

const fakesLayer = (input: Fakes) =>
  Layer.mergeAll(
    Layer.succeed(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      // Models the decider's real "thread must exist" invariant: a
      // `thread.turn.start` for a thread no prior `thread.create` produced
      // fails, exactly as the running engine does. This is what the handler's
      // old single-command dispatch tripped over, and what a fake that only
      // recorded commands hid.
      dispatch: (command) =>
        Effect.gen(function* () {
          if (
            command.type === "thread.turn.start" &&
            !(yield* Ref.get(input.createdThreadIds)).has(String(command.threadId))
          ) {
            return yield* Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: "thread.turn.start",
                detail: `Thread '${command.threadId}' does not exist for command 'thread.turn.start'.`,
              }),
            );
          }
          if (command.type === "thread.create") {
            yield* Ref.update(
              input.createdThreadIds,
              (ids) => new Set([...ids, String(command.threadId)]),
            );
          }
          yield* Ref.update(input.dispatched, (current) => [...current, command]);
          yield* Deferred.succeed(input.firstDispatch, command);
          return { sequence: 1 };
        }),
      streamDomainEvents: Stream.fromQueue(input.events),
      latestSequence: Effect.succeed(0),
    } satisfies OrchestrationEngineShape),
    Layer.succeed(ProjectionSnapshotQuery)({
      getThreadShellById: (id: ThreadId) =>
        Effect.succeed(id === callerThreadId ? Option.some(callerThreadShell) : Option.none()),
      getThreadDetailById: () =>
        Effect.succeed(Option.some(input.childThreadDetail ?? emptyChildThreadDetail)),
    } as unknown as ProjectionSnapshotQueryShape),
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope),
  );

const withServer = <A, E>(
  input: Fakes,
  body: (server: McpServer.McpServer["Service"]) => Effect.Effect<A, E, never>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* body(server);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          // The registration the running server uses, so a toolkit dropped
          // from `McpHttpServer.layer` would fail this test too.
          AgentToolkitRegistrationLive.pipe(
            Layer.provide(fakesLayer(input)),
            Layer.provideMerge(McpServer.McpServer.layer),
          ),
          // `Crypto.Crypto` runs for real: the handler mints ids from it, and
          // nothing here asserts on their exact value, only their presence.
          NodeServices.layer,
        ),
      ),
    ),
  );

const makeFakes = () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const createdThreadIds = yield* Ref.make<ReadonlySet<string>>(new Set());
    const firstDispatch = yield* Deferred.make<OrchestrationCommand>();
    return { events, dispatched, createdThreadIds, firstDispatch } satisfies Fakes;
  });

// it.live: this call's waitSeconds elapses for real (nothing ever completes
// the child's turn), and `Effect.timeoutOption` races a real Effect.sleep —
// under `it.effect`'s paused virtual clock that sleep never fires, so the
// call would hang until the test runner's own timeout instead of CH3's.
it.live(
  "dispatches thread.turn.start with the Maple model selection and the caller's project",
  () =>
    Effect.gen(function* () {
      const fakes = yield* makeFakes();
      yield* withServer(fakes, (server) =>
        server
          .callTool({
            name: "spawn_model_agent",
            arguments: {
              model: "glm-5-3-flash",
              prompt: "Summarize the README.",
              waitSeconds: 1,
            },
          })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client)),
      );

      const commands = yield* Ref.get(fakes.dispatched);
      const create = commands[0];
      if (create === undefined || create.type !== "thread.create") {
        throw new Error(`expected a thread.create command first, got ${String(create?.type)}`);
      }
      expect(create.modelSelection).toEqual({
        instanceId: "opencode",
        model: "maple/glm-5-3-flash",
      });
      expect(create.projectId).toBe(projectId);
      // The child works where the caller works.
      expect(create.branch).toBe("feature/worktree-branch");
      expect(create.worktreePath).toBe("/tmp/ch3-worktrees/feature");
      const turn = commands[1];
      if (turn === undefined || turn.type !== "thread.turn.start") {
        throw new Error(`expected a thread.turn.start command second, got ${String(turn?.type)}`);
      }
      expect(turn.threadId).toBe(create.threadId);
      expect(turn.message.text).toBe("Summarize the README.");
    }),
);

it.effect("returns the completed status and the child's final assistant text", () =>
  Effect.gen(function* () {
    const assistantMessageId = MessageId.make("assistant-msg-1");
    const fakes = yield* makeFakes();
    const childThreadDetail = {
      id: ThreadId.make("child-thread"),
      messages: [
        {
          id: assistantMessageId,
          role: "assistant",
          text: "The README documents a WebSocket server that wraps provider CLIs.",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
    } as unknown as OrchestrationThread;

    yield* withServer({ ...fakes, childThreadDetail }, (server) =>
      Effect.gen(function* () {
        const callFiber = yield* server
          .callTool({
            name: "spawn_model_agent",
            arguments: {
              model: "glm-5-3-flash",
              prompt: "Summarize the README.",
              waitSeconds: 30,
            },
          })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.forkChild);

        const command = yield* Deferred.await(fakes.firstDispatch);
        if (command.type !== "thread.create") {
          throw new Error(`expected a thread.create command first, got ${command.type}`);
        }
        const childThreadId = command.threadId;

        yield* Queue.offer(fakes.events, {
          type: "thread.turn-diff-completed",
          sequence: 1,
          eventId: CommandId.make("evt-1"),
          aggregateKind: "thread",
          aggregateId: childThreadId,
          occurredAt: now,
          commandId: command.commandId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: childThreadId,
            turnId: CommandId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CommandId.make("checkpoint-1"),
            status: "completed",
            files: [],
            assistantMessageId,
            completedAt: now,
          },
        } as unknown as OrchestrationEvent);

        const result = yield* Fiber.join(callFiber).pipe(Effect.timeout("5 seconds"));
        expect(result.isError).toBeFalsy();
        const content = result.structuredContent as {
          readonly threadId: string;
          readonly model: string;
          readonly status: string;
          readonly output: string | null;
        };
        expect(content.status).toBe("completed");
        expect(content.model).toBe("glm-5-3-flash");
        expect(content.threadId).toBe(String(childThreadId));
        expect(content.output).toBe(
          "The README documents a WebSocket server that wraps provider CLIs.",
        );
      }),
    );
  }),
);

it.effect(
  "settles on the child's session leaving running when no checkpoint event ever comes",
  () =>
    Effect.gen(function* () {
      // A child in a non-git project, or one whose turn aborted, never produces
      // `thread.turn-diff-completed`; the session settling is what the projector
      // itself ends a turn on, so it ends the wait too — but only once the turn
      // was seen underway, so the session's own `ready` on start does not.
      const fakes = yield* makeFakes();
      const childThreadDetail = {
        id: ThreadId.make("child-thread"),
        messages: [
          { id: MessageId.make("u1"), role: "user", text: "Say hello.", turnId: null },
          {
            id: MessageId.make("a1"),
            role: "assistant",
            text: "Hello from a non-git child.",
            turnId: null,
          },
        ],
      } as unknown as OrchestrationThread;

      yield* withServer({ ...fakes, childThreadDetail }, (server) =>
        Effect.gen(function* () {
          const callFiber = yield* server
            .callTool({
              name: "spawn_model_agent",
              arguments: { model: "glm-5-3-flash", prompt: "Say hello.", waitSeconds: 30 },
            })
            .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.forkChild);
          const command = yield* Deferred.await(fakes.firstDispatch);
          if (command.type !== "thread.create")
            throw new Error(`expected thread.create, got ${command.type}`);
          const childThreadId = command.threadId;
          const sessionSet = (status: string, lastError: string | null = null) =>
            ({
              type: "thread.session-set",
              sequence: 1,
              eventId: CommandId.make(`evt-${status}`),
              aggregateKind: "thread",
              aggregateId: childThreadId,
              occurredAt: now,
              commandId: command.commandId,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                threadId: childThreadId,
                session: {
                  threadId: childThreadId,
                  status,
                  providerName: "opencode",
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError,
                  updatedAt: now,
                },
              },
            }) as unknown as OrchestrationEvent;

          // The session's own start: not the turn ending.
          yield* Queue.offer(fakes.events, sessionSet("ready"));
          yield* Queue.offer(fakes.events, sessionSet("running"));
          yield* Queue.offer(fakes.events, sessionSet("idle"));

          const result = yield* Fiber.join(callFiber).pipe(Effect.timeout("5 seconds"));
          const content = result.structuredContent as { status: string; output: string | null };
          expect(content.status).toBe("completed");
          expect(content.output).toBe("Hello from a non-git child.");
        }),
      );
    }),
);

it.effect("reports a turn the checkpoint marked as errored as error, not completed", () =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes();
    yield* withServer(fakes, (server) =>
      Effect.gen(function* () {
        const callFiber = yield* server
          .callTool({
            name: "spawn_model_agent",
            arguments: { model: "glm-5-3-flash", prompt: "Do it.", waitSeconds: 30 },
          })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.forkChild);
        const command = yield* Deferred.await(fakes.firstDispatch);
        if (command.type !== "thread.create")
          throw new Error(`expected thread.create, got ${command.type}`);
        const childThreadId = command.threadId;
        // The checkpoint's fallback id matches no message; status carries the truth.
        yield* Queue.offer(fakes.events, {
          type: "thread.turn-diff-completed",
          sequence: 1,
          eventId: CommandId.make("evt-err"),
          aggregateKind: "thread",
          aggregateId: childThreadId,
          occurredAt: now,
          commandId: command.commandId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: childThreadId,
            turnId: CommandId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CommandId.make("checkpoint-1"),
            status: "error",
            files: [],
            assistantMessageId: MessageId.make("assistant:turn-1"),
            completedAt: now,
          },
        } as unknown as OrchestrationEvent);
        const result = yield* Fiber.join(callFiber).pipe(Effect.timeout("5 seconds"));
        const content = result.structuredContent as { status: string; output: string | null };
        expect(content.status).toBe("error");
        expect(content.output).toBeNull();
      }),
    );
  }),
);

it.effect("fails with a helpful message when the model id is not in the Maple catalogue", () =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes();
    yield* withServer(fakes, (server) =>
      Effect.gen(function* () {
        const result = yield* server
          .callTool({
            name: "spawn_model_agent",
            arguments: { model: "not-a-real-model", prompt: "Do something." },
          })
          .pipe(Effect.provideService(McpSchema.McpServerClient, client));

        expect(result.isError).toBe(true);
        const text = `${allText(result.structuredContent)} ${allText(result.content)}`;
        expect(text).toContain("not-a-real-model");
        for (const model of MAPLE_MODELS) {
          expect(text).toContain(model.id);
        }
      }),
    );
    // The catalogue check runs before anything is dispatched.
    expect(yield* Ref.get(fakes.dispatched)).toEqual([]);
  }),
);

// it.live, for the same reason as the dispatch test above: the whole point
// here is a real `waitSeconds` timeout expiring.
it.live(
  "returns status running with a null output when the wait window elapses first",
  () =>
    Effect.gen(function* () {
      const fakes = yield* makeFakes();
      yield* withServer(fakes, (server) =>
        Effect.gen(function* () {
          const result = yield* server
            .callTool({
              name: "spawn_model_agent",
              arguments: {
                model: "glm-5-3-flash",
                prompt: "Do something slow.",
                waitSeconds: 1,
              },
            })
            .pipe(Effect.provideService(McpSchema.McpServerClient, client));

          expect(result.isError).toBeFalsy();
          const content = result.structuredContent as {
            readonly threadId: string;
            readonly status: string;
            readonly output: string | null;
          };
          expect(content.status).toBe("running");
          expect(content.output).toBeNull();
          expect(content.threadId.length).toBeGreaterThan(0);
        }),
      );
    }),
  10_000,
);
