import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopAgentPowerGuard from "./DesktopAgentPowerGuard.ts";

const makeBlockerHarness = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  let nextId = 1;
  const layer = Layer.succeed(
    ElectronPowerSaveBlocker.ElectronPowerSaveBlocker,
    ElectronPowerSaveBlocker.ElectronPowerSaveBlocker.of({
      start: (type) =>
        Ref.update(calls, (current) => [...current, `start:${type}`]).pipe(
          Effect.map(() => nextId++),
        ),
      stop: (id) => Ref.update(calls, (current) => [...current, `stop:${id}`]),
    }),
  );
  return { calls, layer };
});

describe("DesktopAgentPowerGuard", () => {
  it.effect("holds one blocker across repeated activity reports and releases on settle", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeBlockerHarness;

      yield* Effect.gen(function* () {
        const guard = yield* DesktopAgentPowerGuard.DesktopAgentPowerGuard;

        yield* guard.setActive(true);
        yield* guard.setActive(true);
        assert.deepEqual(yield* Ref.get(calls), ["start:prevent-app-suspension"]);
        assert.isTrue(yield* guard.isHolding);

        yield* guard.setActive(false);
        yield* guard.setActive(false);
        assert.deepEqual(yield* Ref.get(calls), ["start:prevent-app-suspension", "stop:1"]);
        assert.isFalse(yield* guard.isHolding);
      }).pipe(Effect.provide(DesktopAgentPowerGuard.layer.pipe(Layer.provide(layer))));
    }),
  );

  it.effect("releases a held blocker when the layer scope closes", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeBlockerHarness;

      yield* Effect.gen(function* () {
        const guard = yield* DesktopAgentPowerGuard.DesktopAgentPowerGuard;
        yield* guard.setActive(true);
      }).pipe(Effect.provide(DesktopAgentPowerGuard.layer.pipe(Layer.provide(layer))));

      // Leaving the provided scope must have run the release finalizer.
      assert.deepEqual(yield* Ref.get(calls), ["start:prevent-app-suspension", "stop:1"]);
    }),
  );
});
