import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

/**
 * A FRESH database per case. `it.layer` builds its layer once for the suite, so
 * sharing one memory client let the first case migrate the schema to 41 and
 * left the second migrating nothing: its `INSERT` then ran against a table that
 * already had the column, and the assertion proved only that SQLite returns
 * NULL for a column an INSERT omits — not that the migration leaves
 * pre-existing rows alone, which is the thing it is named for.
 */
const freshDatabase = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshDatabase()("041_ProjectionThreadSessionLastErrorClass", (it) => {
  it.effect("adds a nullable last_error_class column to projection_thread_sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const column = columns.find((entry) => entry.name === "last_error_class");
      assert.ok(column);
      assert.equal(column?.notnull, 0);
    }),
  );
});

freshDatabase()("041_ProjectionThreadSessionLastErrorClass, on a database with rows", (it) => {
  it.effect("existing rows read back with a null classification", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id, runtime_mode,
          active_turn_id, last_error, updated_at
        ) VALUES (
          'thread-pre-migration', 'error', 'claudeAgent', 'claude-instance', 'full-access',
          NULL, 'OAuth session expired', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const rows = yield* sql<{ readonly last_error_class: string | null }>`
        SELECT last_error_class FROM projection_thread_sessions WHERE thread_id = 'thread-pre-migration'
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.last_error_class, null);
    }),
  );
});
