import { createEnvironmentRpcCommand } from "@ch3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@ch3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Read-aloud, web only: the desktop app is where anyone listens, and the
 * mobile client has no surface for it.
 *
 * Parallel on purpose, despite nobody listening to two replies at once: the
 * speak button offers cancel, and a serial lane cannot honour it — an
 * abandoned request kept its slot, so the very next press sat queued behind
 * up to four minutes of dead synthesis. The button's own phase state already
 * prevents double-firing one message, and the server caches per clip, so the
 * realistic worst case is a handful of concurrent syntheses, each bounded by
 * the server's timeout.
 */
export const speechEnvironment = {
  synthesize: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:speech:synthesize",
    tag: WS_METHODS.speechSynthesize,
    concurrency: { mode: "parallel" as const },
  }),
};
