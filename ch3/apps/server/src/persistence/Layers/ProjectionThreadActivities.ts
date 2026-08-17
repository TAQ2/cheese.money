import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@ch3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionThreadActivitiesInput,
  OpenBackgroundTask,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: ProjectionThreadActivity,
    execute: (row) =>
      sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${JSON.stringify(row.payload)},
              ${row.sequence ?? null},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              sequence = excluded.sequence,
              created_at = excluded.created_at
          `,
  });

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const deleteProjectionThreadActivityRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  // Matched on the taskId inside the payload rather than a column, because
  // that is where the runtime puts it; the started row is the anchor and the
  // completed row for the same taskId is what must be absent.
  const listOpenBackgroundTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OpenBackgroundTask,
    execute: () =>
      sql`
        SELECT DISTINCT
          started.thread_id AS "threadId",
          json_extract(started.payload_json, '$.taskId') AS "taskId"
        FROM projection_thread_activities AS started
        WHERE started.kind = 'task.started'
          AND json_extract(started.payload_json, '$.taskId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS finished
            WHERE finished.kind = 'task.completed'
              AND finished.thread_id = started.thread_id
              AND json_extract(finished.payload_json, '$.taskId')
                  = json_extract(started.payload_json, '$.taskId')
          )
      `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadActivityRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.upsert:query",
          "ProjectionThreadActivityRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadActivityRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listByThreadId:query",
          "ProjectionThreadActivityRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          activityId: row.activityId,
          threadId: row.threadId,
          turnId: row.turnId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          ...(row.sequence !== null ? { sequence: row.sequence } : {}),
          createdAt: row.createdAt,
        })),
      ),
    );

  const listOpenBackgroundTasks: ProjectionThreadActivityRepositoryShape["listOpenBackgroundTasks"] =
    () =>
      listOpenBackgroundTaskRows().pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listOpenBackgroundTasks:query",
            "ProjectionThreadActivityRepository.listOpenBackgroundTasks:decodeRows",
          ),
        ),
      );

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    listOpenBackgroundTasks,
    deleteByThreadId,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
