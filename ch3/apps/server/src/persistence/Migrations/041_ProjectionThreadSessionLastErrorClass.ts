import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A sibling column to `last_error`, carrying the `RuntimeErrorClass` a
 * `runtime.error` event was tagged with, so the client can tell an
 * actionable Claude auth failure apart from a generic provider error
 * without re-parsing the raw CLI string.
 *
 * Nullable and additive: every existing row reads back with `NULL`, which
 * the client already treats as "no classification, render the plain error
 * as before."
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  if (!columns.some((column) => column.name === "last_error_class")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_class TEXT
    `;
  }
});
