/**
 * KanbanClassificationReactor – classify finished turns onto the kanban board.
 *
 * After a turn completes (signalled by the thread.turn-diff-completed domain
 * event — the reliable completion signal, see CheckpointReactor's note on the
 * runtime PubSub), a model reads the conversation tail (latest user message +
 * latest assistant response) and proposes a board stage plus a two-line card
 * description and three keywords. The result is dispatched as a
 * thread.kanban.update command with source "classifier"; the decider is the
 * single writer and drops the stage/type of pinned cards, so a manual
 * placement always wins.
 *
 * Snoozed and settled columns are derived on the client from their own state,
 * never from this classifier: it only ever proposes one of the five middle
 * stages.
 *
 * @module KanbanClassificationReactor
 */
import { CommandId, ProviderDriverKind, ThreadId, type ModelSelection } from "@ch3tools/contracts";
import { defaultInstanceIdForDriver } from "@ch3tools/contracts";
import { makeDrainableWorker } from "@ch3tools/shared/DrainableWorker";
import { createModelSelection } from "@ch3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  KanbanClassificationReactor,
  type KanbanClassificationReactorShape,
} from "../Services/KanbanClassificationReactor.ts";

/**
 * The model that reads the conversation and places the card. Conrad's spec
 * asks for a Sonnet-class read here (a Haiku title is fine; a wrong column is
 * not), still billed to the thread's own Claude instance. The configured
 * text-generation model remains the fallback when that instance cannot serve.
 */
const KANBAN_CLASSIFICATION_CLAUDE_MODEL = "claude-sonnet-5";

/** Only the conversation tail matters for placement. */
const MAX_KANBAN_CONTEXT_CHARS = 8_000;

/**
 * Build the "latest user message + latest assistant response" tail. Walks the
 * message list backwards and keeps the most recent assistant message and the
 * most recent user message at or before it, newest last in the output.
 */
export function formatKanbanContext(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
  }>,
): string {
  // Latest user message and latest assistant response, whatever order the
  // tail ends in — a follow-up sent after the reply (…assistant, user) must
  // win over the older exchange.
  let assistantText: string | null = null;
  let userText: string | null = null;
  for (const message of messages.toReversed()) {
    const text = message.text.trim();
    if (message.role === "system" || text.length === 0) {
      continue;
    }
    if (message.role === "assistant" && assistantText === null) {
      assistantText = text;
    } else if (message.role === "user" && userText === null) {
      userText = text;
    }
    if (assistantText !== null && userText !== null) {
      break;
    }
  }

  const sections = [
    ...(userText !== null ? [`USER:\n${userText}`] : []),
    ...(assistantText !== null ? [`ASSISTANT:\n${assistantText}`] : []),
  ];
  const context = sections.join("\n\n");
  return context.length > MAX_KANBAN_CONTEXT_CHARS
    ? context.slice(-MAX_KANBAN_CONTEXT_CHARS)
    : context;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveProject = Effect.fnUntraced(function* (
    projectId: Parameters<typeof projectionSnapshotQuery.getProjectShellById>[0],
  ) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Same instance-affinity rule as thread titling (see ProviderCommandReactor):
   * classify through the thread's own Claude instance so the work is billed to
   * the account the thread actually talks to; fall back to the configured
   * text-generation model when that fails or no Claude instance applies.
   */
  const classificationModelSelection = (input: {
    readonly threadInstanceId: ModelSelection["instanceId"] | undefined;
    readonly instances: Readonly<Record<string, { readonly driver?: string } | undefined>>;
  }): ModelSelection => {
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const threadInstanceId = input.threadInstanceId;
    const isClaudeThreadInstance =
      threadInstanceId !== undefined &&
      (input.instances[threadInstanceId]?.driver ?? claudeDriver) === claudeDriver &&
      (input.instances[threadInstanceId] !== undefined ||
        threadInstanceId === defaultInstanceIdForDriver(claudeDriver));

    return createModelSelection(
      isClaudeThreadInstance ? threadInstanceId : defaultInstanceIdForDriver(claudeDriver),
      KANBAN_CLASSIFICATION_CLAUDE_MODEL,
    );
  };

  const generateThreadKanbanWithFallback = Effect.fn("generateThreadKanbanWithFallback")(
    function* (input: {
      readonly cwd: string;
      readonly message: string;
      readonly threadInstanceId: ModelSelection["instanceId"] | undefined;
    }) {
      const settings = yield* serverSettingsService.getSettings;
      const { textGenerationModelSelection } = settings;
      const preferred = classificationModelSelection({
        threadInstanceId: input.threadInstanceId,
        instances: (settings.providerInstances ?? {}) as Readonly<
          Record<string, { readonly driver?: string } | undefined>
        >,
      });
      return yield* textGeneration
        .generateThreadKanban({
          cwd: input.cwd,
          message: input.message,
          modelSelection: preferred,
        })
        .pipe(
          // `Effect.catch` handles the expected failure only, so an interrupt
          // still propagates and a cancelled classification does not retry.
          Effect.catch((error) =>
            Effect.logDebug("kanban classification falling back to the configured model", {
              detail: error.message,
            }).pipe(
              Effect.andThen(
                textGeneration.generateThreadKanban({
                  cwd: input.cwd,
                  message: input.message,
                  modelSelection: textGenerationModelSelection,
                }),
              ),
            ),
          ),
        );
    },
  );

  const processThreadClassification = Effect.fn("processThreadClassification")(function* (item: {
    readonly threadId: ThreadId;
    readonly force: boolean;
  }) {
    const { threadId, force } = item;
    // Cheap shell read FIRST: every guard that can skip the paid model call
    // runs before the full thread detail (messages, activities, checkpoints)
    // is materialized.
    const shellBefore = yield* resolveShell(threadId);
    if (!shellBefore || shellBefore.archivedAt !== null) {
      return;
    }
    // Mid-turn signals (Codex emits a placeholder diff while still running)
    // and re-fires for an already-classified turn are skipped outright. A
    // user-requested re-run (force) skips only the dedup guards — never the
    // running/archived ones: classifying mid-turn is wrong even on demand.
    if (shellBefore.session?.status === "running" || shellBefore.session?.status === "starting") {
      return;
    }
    const turnIdAtStart = shellBefore.latestTurn?.turnId ?? null;
    if (!force) {
      // At most one classification per turn, keyed on turn IDENTITY: checkpoint
      // capture rewrites a turn's completedAt after the fact, so wall-clock
      // comparison would re-classify the same turn. Threads with no turn at all
      // (imports, older servers) classify once ever until a real turn lands.
      if (turnIdAtStart !== null && shellBefore.kanban?.classifiedTurnId === turnIdAtStart) {
        return;
      }
      if (turnIdAtStart === null && shellBefore.kanban?.classifiedAt != null) {
        return;
      }
    }

    const thread = yield* resolveThread(threadId);
    if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
      return;
    }
    const message = formatKanbanContext(thread.messages);
    if (message.length === 0) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();

    const generated = yield* generateThreadKanbanWithFallback({
      cwd,
      message,
      threadInstanceId: thread.modelSelection.instanceId,
    });

    // Freshness check AFTER generation: seconds pass while the model reads,
    // and a turn that started meanwhile makes this placement stale — the
    // classification for the newer turn will arrive on its own.
    const shell = yield* resolveShell(threadId);
    if (
      !shell ||
      shell.archivedAt !== null ||
      (shell.latestTurn?.turnId ?? null) !== turnIdAtStart ||
      shell.session?.status === "running" ||
      shell.session?.status === "starting"
    ) {
      return;
    }

    // Hard rule from the spec: an agent waiting on the user is a decision.
    const stage =
      shell.hasPendingUserInput || shell.hasPendingApprovals ? "decision-needed" : generated.stage;

    yield* orchestrationEngine.dispatch({
      type: "thread.kanban.update",
      commandId: yield* serverCommandId("thread-kanban-classify"),
      threadId,
      stage,
      description: generated.description,
      keywords: generated.keywords,
      ...(turnIdAtStart !== null ? { classifiedTurnId: turnIdAtStart } : {}),
      source: "classifier",
    });
  });

  // One queued classification per thread at a time: a burst of completion
  // events for the same thread must not fan out into N identical model calls.
  const queuedThreadIds = new Set<string>();

  const processThreadClassificationSafely = (item: {
    readonly threadId: ThreadId;
    readonly force: boolean;
  }) =>
    Effect.suspend(() => {
      queuedThreadIds.delete(item.threadId);
      return processThreadClassification(item);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        // Background classification never surfaces to the user; it degrades
        // silently and the card simply keeps its previous placement.
        return Effect.logWarning("kanban classification reactor failed to process event", {
          threadId: item.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadClassificationSafely);

  const start: KanbanClassificationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        // Two completion signals, because neither alone covers every thread:
        // thread.turn-diff-completed only fires for git workspaces (both
        // producers are checkpoint-gated), and its Codex producer also fires
        // a mid-turn "missing" placeholder we must ignore. thread.session-set
        // leaving running/starting is the projector's own turn-end marker and
        // fires everywhere. The classifiedAt-per-turn guard in processing
        // dedupes the overlap.
        const forced =
          event.type === "thread.kanban-updated" && event.payload.reclassifyRequested === true;
        const relevant =
          forced ||
          (event.type === "thread.turn-diff-completed" && event.payload.status !== "missing") ||
          (event.type === "thread.session-set" &&
            event.payload.session.status !== "running" &&
            event.payload.session.status !== "starting");
        if (!relevant) {
          return Effect.void;
        }
        const threadId = event.payload.threadId;
        if (queuedThreadIds.has(threadId)) {
          return Effect.void;
        }
        queuedThreadIds.add(threadId);
        return worker.enqueue({ threadId, force: forced });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies KanbanClassificationReactorShape;
});

export const KanbanClassificationReactorLive = Layer.effect(KanbanClassificationReactor, make);
