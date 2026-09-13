/**
 * The PTY implementation this runtime can actually load.
 *
 * Bun and Node need different bindings, and both are imported dynamically so
 * the one that cannot load here is never resolved. It lives in its own module
 * so the server runtime and anything else needing a PTY share one definition
 * rather than each carrying a copy of the same dynamic import.
 *
 * @module terminal/PtyAdapterLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as PtyAdapter from "./PtyAdapter.ts";

export const layer: Layer.Layer<PtyAdapter.PtyAdapter, never, FileSystem.FileSystem | Path.Path> =
  Layer.unwrap(
    Effect.gen(function* () {
      if (typeof Bun !== "undefined") {
        const BunPtyAdapter = yield* Effect.promise(() => import("./BunPtyAdapter.ts"));
        return BunPtyAdapter.layer;
      }
      const NodePtyAdapter = yield* Effect.promise(() => import("./NodePtyAdapter.ts"));
      return NodePtyAdapter.layer;
    }),
  );
