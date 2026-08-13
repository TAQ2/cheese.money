/**
 * The registry of OpenCode servers this process's sessions have started.
 *
 * OpenCode answers some questions only over a running server, and starting one
 * runs the user's configured binary with everything that implies. Sessions have
 * to start one anyway, so they publish it here and read-only work borrows it
 * rather than starting a second.
 *
 * @module openCodeSessionServers
 */
import * as Effect from "effect/Effect";

import type { OpenCodeSessionServers } from "../Services/OpenCodeAdapter.ts";

/**
 * `reprobe` is supplied late — the snapshot that owns the refresh is built after
 * the adapter this registry is handed to — so it is read through a getter rather
 * than captured.
 */
export const makeOpenCodeSessionServerRegistry = (
  getReprobe: () => Effect.Effect<void>,
): OpenCodeSessionServers => {
  const urls = new Set<string>();
  return {
    attach: (url) => {
      if (urls.has(url)) return false;
      urls.add(url);
      // Only the first is worth a re-probe: the probe needs *a* server, not
      // each of them, and a burst of session starts would otherwise queue one
      // full health check per session behind the refresh lock.
      return urls.size === 1;
    },
    detach: (url) => {
      urls.delete(url);
    },
    reprobe: Effect.suspend(getReprobe),
    current: () => {
      for (const url of urls) {
        return url;
      }
      return null;
    },
  };
};
