import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface TurnStallWatchdogShape {
  /** Start the background stall watchdog within the provided scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class TurnStallWatchdog extends Context.Service<TurnStallWatchdog, TurnStallWatchdogShape>()(
  "ch3/provider/Services/TurnStallWatchdog",
) {}
