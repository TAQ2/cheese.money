/**
 * The PTY implementation this runtime can actually load.
 *
 * Bun and Node need different bindings, and both are imported dynamically so
 * the one that cannot load here is never resolved. It lives in its own module
 * because terminals are no longer the only caller: the MCP shelf signs in to a
 * server by running `claude mcp login`, and that CLI refuses to authenticate
 * when stdin is not a terminal — "stdin isn't a terminal, so authentication
 * can't be completed here", verbatim, in front of somebody trying to sign in.
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
