import { EnvironmentId, ThreadId } from "@ch3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { createEnvironmentThreadStateAtoms, type ThreadSnapshotLoader } from "./threads.ts";

describe("createEnvironmentThreadStateAtoms", () => {
  it("memoizes one state atom per (environment, thread) pair", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const atom = threads.stateAtom(environmentId, threadId);

    expect(threads.stateAtom(environmentId, threadId)).toBe(atom);
    expect(threads.stateAtom(environmentId, ThreadId.make("thread-2"))).not.toBe(atom);
  });

  it("applies the thread-state retention TTL to every atom it makes", () => {
    // Not a constant compared with itself: `threads.ts` has to call
    // `Atom.setIdleTTL` with this value, and nothing else in the repo checks
    // that it does. Drop that call and a thread's state is dropped the moment
    // its last subscriber leaves, which is the regression this pins.
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const atom = createEnvironmentThreadStateAtoms(runtime).stateAtom(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-1"),
    );
    expect(atom.idleTTL).toBe(THREAD_STATE_IDLE_TTL_MS);
  });
});
