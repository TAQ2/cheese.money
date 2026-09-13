import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@ch3tools/contracts";
import { VcsUnsupportedOperationError } from "@ch3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
/**
 * How long "this directory is a git repository" stays true without asking.
 *
 * Two seconds, which is what this was, is not a cache: the answer changes when
 * somebody runs `git init` or moves a checkout, and nothing else. Every VCS
 * request in between re-paid roughly three git subprocesses — measured at 85.8
 * detections a minute on an idle machine, most of the server's residual git
 * traffic. A minute of staleness for an event that has an explicit
 * invalidation path is the right trade.
 */
const DETECTION_CACHE_TTL = Duration.seconds(60);
/**
 * And how long "this directory is not one" stays true.
 *
 * Zero, which is what this was, means a directory that is not a repository is
 * re-probed on every single request — the common case for a plain folder open
 * in the app. Kept far shorter than the positive answer because `git init` in a
 * folder somebody is looking at is the ordinary way this flips.
 */
const DETECTION_NEGATIVE_CACHE_TTL = Duration.seconds(5);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
    /**
     * Forget what was detected for a directory.
     *
     * Called by the operations that make the cached answer wrong — initialising
     * a repository, creating a worktree, removing one — so the cache can hold a
     * real answer for a minute instead of a fresh one for two seconds. Ref
     * switches deliberately do not call it: a detection is a kind and a root
     * path, and the branch is not in it.
     */
    readonly invalidate: (cwd: string) => Effect.Effect<void>;
  }
>()("ch3/vcs/VcsDriverRegistry") {}

/** The requested-kind values a detection can be cached under. */
const INVALIDATED_DETECTION_KINDS = ["auto", "git", "jj", "unknown"] as const;

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return {
      cwd: key,
      requestedKind: "auto",
    };
  }
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.gen(function* () {
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriver;
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriver["Service"]>> = {
    git,
  };

  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    return yield* detectWithDriver("git", git, input.cwd);
  });

  const detectionCache = yield* Cache.makeWith<string, VcsDriverHandle | null, VcsError>(
    (key) => detectResolvedKind(parseDetectionCacheKey(key)),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) =>
          detected === null ? DETECTION_NEGATIVE_CACHE_TTL : DETECTION_CACHE_TTL,
        // A failure is usually a git that could not run at all, and repeating
        // it is how the caller finds out it can again.
        onFailure: () => Duration.zero,
      }),
    },
  );

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = yield* projectConfig.resolveKind(input);
      return yield* Cache.get(detectionCache, detectionCacheKey({ cwd: input.cwd, requestedKind }));
    },
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsDriverRegistry.resolve",
        kind: requestedKind === "auto" ? "unknown" : requestedKind,
        detail:
          requestedKind === "auto"
            ? `No supported VCS repository was detected at ${input.cwd}.`
            : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      });
    },
  );

  // Every kind a cwd could have been cached under, because the caller that
  // creates a repository does not know which one the reader asked for.
  const invalidate: VcsDriverRegistry["Service"]["invalidate"] = (cwd) =>
    Effect.forEach(
      INVALIDATED_DETECTION_KINDS,
      (requestedKind) =>
        Cache.invalidate(detectionCache, detectionCacheKey({ cwd, requestedKind })),
      { discard: true },
    );

  return VcsDriverRegistry.of({
    get,
    detect,
    resolve,
    invalidate,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
