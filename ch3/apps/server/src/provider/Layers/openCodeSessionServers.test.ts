import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe } from "vite-plus/test";

import { makeOpenCodeSessionServerRegistry } from "./openCodeSessionServers.ts";

const registry = () => makeOpenCodeSessionServerRegistry(() => Effect.void);

describe("makeOpenCodeSessionServerRegistry", () => {
  it.effect("has nothing to borrow until a session publishes a server", () =>
    Effect.sync(() => {
      NodeAssert.equal(registry().current(), null);
    }),
  );

  it.effect("asks for a re-probe on the first server only", () =>
    Effect.sync(() => {
      const servers = registry();
      NodeAssert.equal(servers.attach("http://127.0.0.1:4301"), true);
      // A burst of session starts must not queue one full health check each.
      NodeAssert.equal(servers.attach("http://127.0.0.1:4302"), false);
      NodeAssert.equal(servers.attach("http://127.0.0.1:4301"), false);
    }),
  );

  it.effect("stops offering a server once its session is gone", () =>
    Effect.sync(() => {
      const servers = registry();
      servers.attach("http://127.0.0.1:4301");
      servers.detach("http://127.0.0.1:4301");
      NodeAssert.equal(servers.current(), null);
      // The next session is a first again, so its server gets read.
      NodeAssert.equal(servers.attach("http://127.0.0.1:4302"), true);
    }),
  );

  it.effect("keeps offering a live server when a sibling session ends", () =>
    Effect.sync(() => {
      const servers = registry();
      servers.attach("http://127.0.0.1:4301");
      servers.attach("http://127.0.0.1:4302");
      servers.detach("http://127.0.0.1:4301");
      NodeAssert.equal(servers.current(), "http://127.0.0.1:4302");
    }),
  );

  // The ordering this exists to guarantee: attach and detach are plain calls,
  // so a session that starts and stops within one tick cannot leave a dead URL
  // published — which would shadow every later, healthy server for good.
  it.effect("cannot leave a dead server published by a same-tick teardown", () =>
    Effect.sync(() => {
      const servers = registry();
      servers.attach("http://127.0.0.1:4301");
      servers.detach("http://127.0.0.1:4301");
      servers.attach("http://127.0.0.1:4302");
      NodeAssert.equal(servers.current(), "http://127.0.0.1:4302");
    }),
  );

  it.effect("reads the re-probe late, because the snapshot is built after it", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0);
      let reprobe: Effect.Effect<void> = Effect.die(new Error("re-probe not wired yet"));
      const servers = makeOpenCodeSessionServerRegistry(() => reprobe);
      reprobe = Ref.update(ran, (count) => count + 1);

      yield* servers.reprobe;

      NodeAssert.equal(yield* Ref.get(ran), 1);
    }),
  );
});
