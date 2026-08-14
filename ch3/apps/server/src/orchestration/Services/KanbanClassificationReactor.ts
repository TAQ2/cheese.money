/**
 * KanbanClassificationReactor - Kanban auto-classification reactor interface.
 *
 * Owns the background worker that reacts to completed turns and asks a model
 * to place the thread on the kanban board (stage) and refresh the card's
 * generated summary (description + keywords).
 *
 * @module KanbanClassificationReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * KanbanClassificationReactorShape - Service API for kanban classification.
 */
export interface KanbanClassificationReactorShape {
  /**
   * Start reacting to thread.turn-diff-completed orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * KanbanClassificationReactor - Service tag for kanban classification workers.
 */
export class KanbanClassificationReactor extends Context.Service<
  KanbanClassificationReactor,
  KanbanClassificationReactorShape
>()("ch3/orchestration/Services/KanbanClassificationReactor") {}
