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

export const DeleteProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadActivitiesInput =
  typeof DeleteProjectionThreadActivitiesInput.Type;

/** A background task with a `task.started` row and no `task.completed` row. */
export const OpenBackgroundTask = Schema.Struct({
  threadId: ThreadId,
  taskId: Schema.String,
});
export type OpenBackgroundTask = typeof OpenBackgroundTask.Type;

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
   * Every background task that reported a start and never an end.
   *
   * Used once, at boot, to close them. A task is owned by the agent process
   * the server spawned, so if a task is still open when the server starts, the
   * process that could have finished it is already gone and no completion will
   * ever arrive. Left alone these accumulate forever: the agent panel showed
   * entries whose timers had been counting for over two weeks.
   */
  readonly listOpenBackgroundTasks: () => Effect.Effect<
    ReadonlyArray<OpenBackgroundTask>,
    ProjectionRepositoryError
  >;

  /**
   * Delete projected thread activity rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadActivityRepository - Service tag for thread activity persistence.
 */
export class ProjectionThreadActivityRepository extends Context.Service<
  ProjectionThreadActivityRepository,
  ProjectionThreadActivityRepositoryShape
>()("ch3/persistence/Services/ProjectionThreadActivities/ProjectionThreadActivityRepository") {}
