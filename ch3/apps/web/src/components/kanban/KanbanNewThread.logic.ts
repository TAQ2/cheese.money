import {
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type KanbanCardType,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@ch3tools/contracts";
import { createModelSelection } from "@ch3tools/shared/model";

import { truncate } from "@ch3tools/shared/String";

import type { KanbanColumnConfig, KanbanColumnId } from "./kanbanConfig";
import { NEW_THREAD_DEFAULT_MODEL } from "../../modelSelection";

/** Long enough to recognise the prompt in the sidebar, short enough to fit it. */
const TITLE_MAX_LENGTH = 72;

/** The columns a new card can be filed into: the stages, never the two
    derived ends of the board. */
export function resolveKanbanNewThreadStages(
  columns: ReadonlyArray<KanbanColumnConfig>,
): ReadonlyArray<KanbanColumnConfig> {
  return columns.filter((column) => column.id !== "snoozed" && column.id !== "settled");
}

/**
 * What the conversation is called from its first prompt, one line, as the
 * chat's own send does it: that is what somebody looks for coming back later.
 */
export function kanbanNewThreadTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/gu, " ").trim();
  return oneLine.length === 0 ? "New thread" : truncate(oneLine, TITLE_MAX_LENGTH);
}

/**
 * The turn that creates the thread and sends its first prompt in one go —
 * the same `thread.turn.start` with `bootstrap.createThread` the chat sends
 * for a draft, minus the composer's attachments and contexts. Branch and
 * worktree are the project's defaults, exactly as a thread started from the
 * inbox gets them.
 */
export function buildKanbanNewThreadTurnStart(input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  /** Settings → General → New thread access / agent mode. */
  readonly newThreadModes: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
  readonly createdAt: string;
}) {
  const title = kanbanNewThreadTitle(input.prompt);
  return {
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user" as const,
      text: input.prompt.trim(),
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: title,
    runtimeMode: input.newThreadModes.runtimeMode,
    interactionMode: input.newThreadModes.interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title,
        modelSelection: input.modelSelection,
        runtimeMode: input.newThreadModes.runtimeMode,
        interactionMode: input.newThreadModes.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}

/**
 * The model the board's dialog opens on: the tier's default, always.
 *
 * Deliberately NOT the project's default model. That field is a record of
 * what the project last ran on, and seeding from it opened this dialog on
 * Fable in a project somebody had once used Fable in — an expensive model
 * chosen for one conversation months ago, offered as the default for every
 * new one. The rest of the app starts every new conversation on the default
 * model for the same reason; this is that rule, applied here too.
 */
export function kanbanNewThreadSeedModel(): ModelSelection {
  const instanceId = defaultInstanceIdForDriver(NEW_THREAD_DEFAULT_MODEL.driverKind);
  return createModelSelection(instanceId, NEW_THREAD_DEFAULT_MODEL.slug);
}

/** A week out: the same seed the card gives a deadline chosen with no date. */
export function defaultKanbanDeadlineDate(nowMs: number): string {
  return new Date(nowMs + 7 * 24 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * A calendar date as the deadline the board stores. Noon UTC round-trips to
 * the same calendar date in every timezone (UTC-12 … UTC+14) — the card's
 * own rule, kept identical so a deadline set here and one set on the card
 * read the same.
 */
export function kanbanDeadlineFromDate(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : null;
}

/**
 * The card's placement, pinned: a person chose the lane and the priority, so
 * the background classifier must never move it — the same promise a manual
 * drag makes. A deadline travels only with the deadline priority; the server
 * ignores it otherwise, and sending one would be a lie about the card.
 */
export function buildKanbanNewThreadPlacement(input: {
  readonly threadId: ThreadId;
  readonly stage: KanbanColumnId;
  readonly cardType: KanbanCardType;
  /** Calendar date, `YYYY-MM-DD`; read only when `cardType` is `deadline`. */
  readonly deadlineDate?: string;
}) {
  const deadline =
    input.cardType === "deadline" && input.deadlineDate !== undefined
      ? kanbanDeadlineFromDate(input.deadlineDate)
      : null;
  return {
    threadId: input.threadId,
    stage: input.stage,
    cardType: input.cardType,
    ...(deadline === null ? {} : { deadline }),
    pinned: true,
    source: "user" as const,
  };
}
