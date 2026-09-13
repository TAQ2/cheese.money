import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * An index for the two questions the rail asks on every projected event.
 *
 * `countLiveDelegations` looks for delegation rows by `(thread_id, kind)`, and
 * the table had no index carrying `kind` — only `(thread_id, created_at)` and
 * two sequence indexes — so each call walked every activity the thread ever
 * had, running `json_extract` per row. On the busiest thread here, 39,473 rows,
 * that measured 25 ms before this query grew and up to 140 ms after, inside the
 * command worker's WRITE transaction, on a path that fires every two or three
 * seconds while an agent is working.
 *
 * `IF NOT EXISTS` rather than a `PRAGMA` guard: an index needs no shape check,
 * and a real failure — a locked database, a damaged schema — must still
 * propagate so the migration stays unrecorded and runs again next boot, the
 * same rule `039` is written to.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_kind
      ON projection_thread_activities(thread_id, kind)
  `;
});
