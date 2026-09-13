import { assert, it } from "@effect/vitest";

import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_PROJECTS,
  SHOWCASE_THREADS,
} from "./showcase-environment.ts";

// The seeder outlived the mobile showcase it was written for: the web visual
// fixtures (`scripts/visual/fixtures.ts`) build their database from it. This
// is the one case from the deleted `mobile-showcase.test.ts` that was about
// the seeder itself, kept so the fixture's shape stays what the screenshots
// expect.
it("seeds a playful multi-environment project spectrum", () => {
  assert.deepStrictEqual(
    SHOWCASE_PROJECTS.map((project) => project.title),
    ["CH3", "React", "Linux"],
  );
  assert.deepStrictEqual(
    SHOWCASE_ENVIRONMENTS.map((environment) => environment.label),
    ["Moonbase Terminal", "Suspense Station", "Kernel Cabin"],
  );
  assert.equal(SHOWCASE_THREADS.length, 8);
  assert.equal(new Set(SHOWCASE_THREADS.map((thread) => thread.projectId)).size, 3);
  // Every project contributes to both the active block and the settled tail,
  // so each list scope screenshots with the same two-part structure.
  for (const project of SHOWCASE_PROJECTS) {
    const projectThreads = SHOWCASE_THREADS.filter((thread) => thread.projectId === project.id);
    assert.equal(
      projectThreads.some((thread) => "settled" in thread && thread.settled),
      true,
      `${project.title} has no settled thread`,
    );
    assert.equal(
      projectThreads.some((thread) => !("settled" in thread && thread.settled)),
      true,
      `${project.title} has no active thread`,
    );
  }
  assert.equal(
    SHOWCASE_PROJECTS.every((project) => project.favicon.includes("<svg")),
    true,
  );
});
