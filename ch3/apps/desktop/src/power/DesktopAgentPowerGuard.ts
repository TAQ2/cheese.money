import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";

/**
 * Holds one `prevent-app-suspension` power-save blocker while the renderer
 * reports a live agent run, so the machine does not idle-sleep mid-run and
 * strand the provider subprocess. The renderer re-reports on every
 * transition (and holds through approval waits — a sleeping machine cannot
 * receive the remote answer either); the blocker is released when the last
 * run settles, and on shutdown by the layer's finalizer.
 */
export class DesktopAgentPowerGuard extends Context.Service<
  DesktopAgentPowerGuard,
  {
    readonly setActive: (active: boolean) => Effect.Effect<void>;
    readonly isHolding: Effect.Effect<boolean>;
  }
>()("@ch3tools/desktop/power/DesktopAgentPowerGuard") {}

export const layer: Layer.Layer<
  DesktopAgentPowerGuard,
  never,
  ElectronPowerSaveBlocker.ElectronPowerSaveBlocker
> = Layer.effect(
  DesktopAgentPowerGuard,
  Effect.gen(function* () {
    const blocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
    const held = yield* Ref.make(Option.none<number>());
    // Transitions arrive over IPC and must not interleave between the read
    // of `held` and the start/stop that updates it.
    const lock = yield* Semaphore.make(1);

    const setActive = (active: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(held);
          if (active && Option.isNone(current)) {
            const id = yield* blocker.start("prevent-app-suspension");
            yield* Ref.set(held, Option.some(id));
            yield* Effect.logInfo("Holding a power-save blocker for a live agent run.");
            return;
          }
          if (!active && Option.isSome(current)) {
            yield* blocker.stop(current.value);
            yield* Ref.set(held, Option.none());
            yield* Effect.logInfo("Released the agent-run power-save blocker.");
          }
        }),
      );

    yield* Effect.addFinalizer(() => setActive(false));

    return DesktopAgentPowerGuard.of({
      setActive,
      isHolding: Ref.get(held).pipe(Effect.map(Option.isSome)),
    });
  }),
);
