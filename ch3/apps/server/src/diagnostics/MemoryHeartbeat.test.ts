import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  MEMORY_HEARTBEAT_FILENAME,
  memoryHeartbeatSample,
  writeMemoryHeartbeat,
} from "./MemoryHeartbeat.ts";

const memory = (overrides: Partial<NodeJS.MemoryUsage>): NodeJS.MemoryUsage => ({
  rss: 100,
  heapTotal: 100,
  heapUsed: 100,
  external: 0,
  arrayBuffers: 0,
  ...overrides,
});

describe("memoryHeartbeatSample", () => {
  // The percentage is the only derived number in the file, and it is the one a
  // person reads to decide whether the server is about to be killed.
  it("reports used heap as a share of the ceiling V8 enforces", () => {
    const sample = memoryHeartbeatSample({
      at: "2026-08-28T18:00:00.000Z",
      pid: 42,
      memory: memory({ heapUsed: 1_536 * 1024 * 1024 }),
      heapLimitBytes: 3_072 * 1024 * 1024,
    });
    expect(sample.heapUsedPercentOfLimit).toBe(50);
    expect(sample.pid).toBe(42);
  });

  // A limit of zero is what an unknown ceiling looks like. Dividing by it would
  // write `Infinity`, which the schema encodes as a number nobody can act on.
  it("says zero rather than infinity when the ceiling is unknown", () => {
    const sample = memoryHeartbeatSample({
      at: "2026-08-28T18:00:00.000Z",
      pid: 42,
      memory: memory({ heapUsed: 1024 }),
      heapLimitBytes: 0,
    });
    expect(sample.heapUsedPercentOfLimit).toBe(0);
  });
});

it.effect("the heartbeat overwrites one file rather than appending, so it cannot grow", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const heartbeatPath = `${config.logsDir}/${MEMORY_HEARTBEAT_FILENAME}`;

    yield* writeMemoryHeartbeat();
    const first = yield* fs.readFileString(heartbeatPath);
    yield* writeMemoryHeartbeat();
    const second = yield* fs.readFileString(heartbeatPath);

    // Two samples, one file: the second is a whole document, not the first
    // with something appended to it.
    expect(second.startsWith("{")).toBe(true);
    expect(second.trimEnd().endsWith("}")).toBe(true);
    expect(second.split("\n").filter((line) => line.startsWith("{"))).toHaveLength(1);
    for (const contents of [first, second]) {
      expect(contents).toContain('"heapLimitBytes"');
      expect(contents).toContain('"heapUsedPercentOfLimit"');
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "ch3-memory-heartbeat-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
