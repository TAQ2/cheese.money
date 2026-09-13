import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * How many subagents are holding the current turn, so the sidebar can say so.
 *
 * Guarded by `PRAGMA table_info` rather than by swallowing the error: catching
 * everything meant a failure that was *not* "the column is already there" — a
 * locked database, a damaged schema — still finished successfully, so the
 * migrator recorded the version and every later read failed with
 * `no such column: live_delegation_count` on somebody's laptop, where there is
 * no ops team and no way back but another release. Letting a real error
 * propagate leaves the migration unrecorded and it simply runs again at the
 * next boot. Same shape as `036_ProjectionThreadsKanban`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "live_delegation_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN live_delegation_count INTEGER NOT NULL DEFAULT 0
    `;
  }
});
