/**
 * OpenCodeAdapter — shape type for the OpenCode provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/OpenCodeDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * @module OpenCodeAdapter
 */
import type * as Effect from "effect/Effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OpenCodeAdapterShape — per-instance OpenCode adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

/**
 * The servers this instance's live sessions own.
 *
 * OpenCode answers some questions — the slash-command list — only over a
 * running server, and starting one runs the user's binary with everything that
 * implies (a proxy, a credential read, a biometric prompt). Sessions have to
 * start one anyway, so they publish it here and read-only background work
 * borrows it instead of paying that price again on a timer.
 */
export interface OpenCodeSessionServers {
  /**
   * A session's server is up and reusable. Returns true when it is the only one
   * live, which is the caller's cue to run {@link reprobe}.
   *
   * Synchronous on purpose. Recording it inside an Effect that the caller forks
   * puts the write on a later tick, and a session that starts and stops inside
   * one tick then lands its `attach` after its own `detach` — publishing a URL
   * whose process is already dead, with nothing left to retract it.
   */
  readonly attach: (url: string) => boolean;
  /** That server is gone with its session. Synchronous, for the same reason. */
  readonly detach: (url: string) => void;
  /**
   * Re-read what only a running server can answer. Slow — it runs the provider
   * health check — so callers fork it; interrupting it only costs a refresh.
   */
  readonly reprobe: Effect.Effect<void>;
  /** A server that is already running, or null. Never starts one. */
  readonly current: () => string | null;
}
