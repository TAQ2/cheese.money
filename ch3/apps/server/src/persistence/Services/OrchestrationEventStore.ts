/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import { OrchestrationEvent } from "@ch3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay ONE aggregate's events after the provided sequence.
   *
   * @param stream - The aggregate kind and stream id to read.
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events for that aggregate only.
   *
   * Served by `idx_orch_events_stream_sequence`, so the cost is the number of
   * events THAT aggregate wrote after the cursor — not the number the whole
   * environment wrote. {@link readFromSequence} makes the caller read and
   * decode the global tail before it can filter, which on a busy install is
   * six orders of magnitude more payload for the same answer.
   */
  readonly readStreamFromSequence: (
    stream: { readonly aggregateKind: string; readonly streamId: string },
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("ch3/persistence/Services/OrchestrationEventStore") {}
