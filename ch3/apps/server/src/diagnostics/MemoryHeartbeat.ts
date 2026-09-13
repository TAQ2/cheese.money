import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as NodeV8 from "node:v8";

import { fromJsonStringPretty } from "@ch3tools/shared/schemaJson";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

/**
 * The last thing the server knew about its own memory, on disk.
 *
 * A server that is killed for running out of heap cannot write a report about
 * it: `node::OOMErrorHandler` aborts the process, and everything that had not
 * reached the filesystem is gone. That is exactly what happened here — an abort
 * eight minutes into a session, and nothing to read afterwards but a crash log
 * from the operating system saying the process was out of memory, with no
 * number attached to the minutes before it.
 *
 * `ResourceTelemetry` already samples RSS for every process in the tree, but it
 * keeps that history in memory and answers over an RPC, so it dies with the
 * process it was measuring and tells you nothing about the heap V8 actually
 * enforces. This writes both, to one small file that is overwritten rather than
 * appended, so the last sample before a death survives it and nothing grows.
 */
const HEARTBEAT_INTERVAL = "30 seconds";

/** The file name, beside the trace and the server child's failure log. */
export const MEMORY_HEARTBEAT_FILENAME = "server-memory.json";

export const MemoryHeartbeatSample = Schema.Struct({
  at: Schema.String,
  pid: Schema.Number,
  rssBytes: Schema.Number,
  heapUsedBytes: Schema.Number,
  heapTotalBytes: Schema.Number,
  externalBytes: Schema.Number,
  arrayBuffersBytes: Schema.Number,
  /** V8's own ceiling — what `--max-old-space-size` sets, in bytes. */
  heapLimitBytes: Schema.Number,
  /** Used heap as a share of the limit, rounded to a percent. The alarm value. */
  heapUsedPercentOfLimit: Schema.Number,
});
export type MemoryHeartbeatSample = typeof MemoryHeartbeatSample.Type;

const encodeSampleJson = Schema.encodeUnknownEffect(fromJsonStringPretty(MemoryHeartbeatSample));

/**
 * One sample, from numbers the caller supplies.
 *
 * Pure so a test can assert the arithmetic without a process to measure: the
 * percentage is the field anybody reading this file actually looks at, and it
 * is the one that could be wrong.
 */
export function memoryHeartbeatSample(input: {
  readonly at: string;
  readonly pid: number;
  readonly memory: NodeJS.MemoryUsage;
  readonly heapLimitBytes: number;
}): MemoryHeartbeatSample {
  const heapUsedPercentOfLimit =
    input.heapLimitBytes > 0 ? Math.round((input.memory.heapUsed / input.heapLimitBytes) * 100) : 0;
  return {
    at: input.at,
    pid: input.pid,
    rssBytes: input.memory.rss,
    heapUsedBytes: input.memory.heapUsed,
    heapTotalBytes: input.memory.heapTotal,
    externalBytes: input.memory.external,
    arrayBuffersBytes: input.memory.arrayBuffers,
    heapLimitBytes: input.heapLimitBytes,
    heapUsedPercentOfLimit,
  };
}

/** Take a sample now and write it where a post-mortem will find it. */
export const writeMemoryHeartbeat = Effect.fn("diagnostics.memoryHeartbeat.write")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const now = yield* DateTime.now;
  const sample = memoryHeartbeatSample({
    at: DateTime.formatIso(now),
    pid: process.pid,
    memory: process.memoryUsage(),
    heapLimitBytes: NodeV8.getHeapStatistics().heap_size_limit,
  });
  const contents = yield* encodeSampleJson(sample);
  yield* writeFileStringAtomically({
    filePath: `${config.logsDir}/${MEMORY_HEARTBEAT_FILENAME}`,
    // Written whole and renamed into place, so a reader never catches half a
    // sample — including a reader looking at it seconds after a crash.
    contents: `${contents}\n`,
  });
});

/**
 * The heartbeat, forked into the server's own scope.
 *
 * Thirty seconds is chosen against the failure it exists to explain: the
 * observed growth was roughly a gigabyte in two minutes, so four samples span
 * it. Cheaper than a trace span, and unlike the trace it cannot be lost in an
 * unflushed buffer.
 */
export const layer = Layer.effectDiscard(
  Effect.forkScoped(
    writeMemoryHeartbeat().pipe(Effect.ignore, Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL))),
  ),
);
