/**
 * ProjectionThreadActivityRepository - Projection repository interface for thread activity.
 *
 * Owns persistence operations for activity timeline entries projected from
 * orchestration events.
 *
 * @module ProjectionThreadActivityRepository
 */
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadActivityTone,
  ThreadId,
  TurnId,
} from "@ch3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadActivity = Schema.Struct({
  activityId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  tone: OrchestrationThreadActivityTone,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;

export const ListProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadActivitiesInput = typeof ListProjectionThreadActivitiesInput.Type;

export const ListProjectionThreadActivitiesForKindsInput = Schema.Struct({
  threadId: ThreadId,
  /** Activity kinds to read. An empty list reads nothing, not everything. */
  kinds: Schema.Array(Schema.String),
});
export type ListProjectionThreadActivitiesForKindsInput =
  typeof ListProjectionThreadActivitiesForKindsInput.Type;

export const CountLiveDelegationsInput = Schema.Struct({
  threadId: ThreadId,
  /** Only this turn's delegations are live; earlier turns are history. */
  turnId: Schema.String,
});
export type CountLiveDelegationsInput = typeof CountLiveDelegationsInput.Type;

export const DeleteProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadActivitiesInput =
  typeof DeleteProjectionThreadActivitiesInput.Type;

/** A background task that was started and never reported an outcome. */
export const OpenProjectionThreadTask = Schema.Struct({
  threadId: ThreadId,
  taskId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  summary: Schema.String,
  createdAt: IsoDateTime,
});
export type OpenProjectionThreadTask = typeof OpenProjectionThreadTask.Type;

/**
 * ProjectionThreadActivityRepositoryShape - Service API for projected thread activity.
 */
export interface ProjectionThreadActivityRepositoryShape {
  /**
   * Insert or replace a projected thread activity row.
   *
   * Upserts by `activityId` and JSON-encodes payload.
   */
  readonly upsert: (
    row: ProjectionThreadActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread activity rows for a thread.
   *
   * Returned in ascending runtime sequence order (or creation order when
   * sequence is unavailable).
   */
  readonly listByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * The rows of a thread whose `kind` is one the caller names.
   *
   * The shell summary needs a handful of user-input activities to recount what
   * a thread is waiting on. Reading the whole thread to find them meant loading
   * every activity payload it ever had — 20 MB on the busiest one here — on
   * every event, inside the write transaction.
   */
  readonly listByThreadIdForKinds: (
    input: ListProjectionThreadActivitiesForKindsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * How many subagents this turn started and has not finished.
   *
   * A number rather than the rows, and this is the difference between a scalar
   * and megabytes: `tool.started` and `tool.completed` are the two most common
   * activity kinds there are — 9,134 rows and 16.8 MB on the busiest thread on
   * one real machine — and this runs on every event a thread receives, inside
   * the write transaction. Reading them to add up +1 and −1 in TypeScript
   * undid the narrowing the summary read was fixed with in the first place.
   */
  readonly countLiveDelegations: (
    input: CountLiveDelegationsInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Delete projected thread activity rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Every background task started but never completed, across ALL threads.
   *
   * Across threads on purpose: the only caller is the boot-time reconciler,
   * and the tasks it must close belong to whichever threads happened to be
   * running when the process died — a per-thread read would have to walk every
   * thread that ever existed to find them.
   */
  readonly listOpenTasks: Effect.Effect<
    ReadonlyArray<OpenProjectionThreadTask>,
    ProjectionRepositoryError
  >;
}

/**
 * ProjectionThreadActivityRepository - Service tag for thread activity persistence.
 */
export class ProjectionThreadActivityRepository extends Context.Service<
  ProjectionThreadActivityRepository,
  ProjectionThreadActivityRepositoryShape
>()("ch3/persistence/Services/ProjectionThreadActivities/ProjectionThreadActivityRepository") {}
