import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@ch3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  CountLiveDelegationsInput,
  DeleteProjectionThreadActivitiesInput,
  ListProjectionThreadActivitiesForKindsInput,
  ListProjectionThreadActivitiesInput,
  OpenProjectionThreadTask,
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

// The db row holds `sequence` as a nullable column; the domain shape holds it
// as an optional key. Same convention as toProjectionThreadMessage next door.
function toProjectionThreadActivity(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
) {
  return {
    activityId: row.activityId,
    threadId: row.threadId,
    turnId: row.turnId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

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

  const listProjectionThreadActivityRowsForKinds = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesForKindsInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, kinds }) =>
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
          AND kind IN ${sql.in(kinds)}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  /**
   * How many agents this turn has in flight, counted in SQLite.
   *
   * TWO shapes, because the providers do not agree on one. A collab agent tool
   * call is a `tool.started`/`tool.completed` pair and sums +1/−1. A Claude
   * subagent is a `task.started` whose `taskType` is `local_agent`, and its
   * `task.completed` carries only the `taskId` — no type — so it cannot be
   * subtracted by kind and is matched by id instead.
   *
   * Counting only the first shape is what made the rail lie. On this machine
   * that shape has 233 rows against 327 `local_agent` starts, so a thread
   * delegating to one Claude subagent counted ZERO and never showed the robot;
   * it appeared only when the parent session happened to fall quiet, which is
   * why it looked like a control that needed more than one agent to wake up.
   *
   * `local_bash` is deliberately NOT counted. A backgrounded shell command is a
   * `task.started` too, and painting the rail "Agents" for `sleep 30` would be
   * the same lie in the other direction.
   *
   * NEITHER side of the agent shape is scoped to the turn, and that is the
   * whole trick. An agent outlives the message that launched it: on this
   * machine 245 of 327 completions landed in a LATER turn than their start,
   * and a traced example ran 11 seconds inside its own turn and then two
   * minutes more under the next one. Scoping the START to the turn lit the
   * rail for those 11 seconds and dropped it while the agent was still
   * working, which is the same silence in a shorter dress.
   *
   * The agent half nets +1/−1 per `taskId` rather than asking whether a
   * completion exists, because Claude REUSES a taskId for repeat delegations
   * in one thread — 331 starts here carry 288 distinct ids, one id six times.
   * An existence test has no ordering, so a second delegation was cancelled by
   * its own first completion and showed nothing while it ran; 43 starts were
   * transiently wrong that way. Netting is also one grouped pass instead of a
   * whole-thread scan per candidate start, which is what this costs on the
   * event path.
   *
   * The collab sum is clamped BEFORE the two are added. Its pair can straddle a
   * turn — a `tool.completed` whose start fell in the previous one reads −1 —
   * and a bare sum let that −1 cancel a live agent and blank the rail. Clamping
   * each term keeps one shape's bookkeeping out of the other's answer.
   *
   * What bounds an open agent is the caller, not the turn: both rail statuses
   * ask for this only while `latestTurn.state === "running"`, so it cannot
   * light a thread that has stopped. An agent whose process died without
   * reporting would otherwise count forever — `TaskReconciler` closes those on
   * the next boot, so the exposure is one server session, and 2 of 331 starts
   * on this machine ever needed it.
   *
   * Deliberately unordered: this produces one integer, so the sort the
   * row-listing queries need was pure cost — a temp B-tree over thousands of
   * rows.
   */
  const countLiveDelegationRows = SqlSchema.findAll({
    Request: CountLiveDelegationsInput,
    Result: Schema.Struct({ live: Schema.Number }),
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          MAX(
            (
              SELECT COALESCE(SUM(CASE WHEN kind = 'tool.started' THEN 1 ELSE -1 END), 0)
              FROM projection_thread_activities
              WHERE thread_id = ${threadId}
                AND turn_id = ${turnId}
                AND kind IN ('tool.started', 'tool.completed')
                AND json_extract(payload_json, '$.itemType') = 'collab_agent_tool_call'
            ),
            0
          )
          +
          (
            SELECT COUNT(*)
            FROM (
              SELECT SUM(
                       CASE
                         WHEN kind = 'task.started'
                           AND json_extract(payload_json, '$.taskType') = 'local_agent' THEN 1
                         WHEN kind = 'task.completed' THEN -1
                         ELSE 0
                       END
                     ) AS open
              FROM projection_thread_activities
              WHERE thread_id = ${threadId}
                AND kind IN ('task.started', 'task.completed')
              GROUP BY json_extract(payload_json, '$.taskId')
            )
            WHERE open > 0
          ) AS "live"
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
      Effect.map((rows) => rows.map(toProjectionThreadActivity)),
    );

  const countLiveDelegations: ProjectionThreadActivityRepositoryShape["countLiveDelegations"] = (
    input,
  ) =>
    countLiveDelegationRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.countLiveDelegations:query",
          "ProjectionThreadActivityRepository.countLiveDelegations:decodeRows",
        ),
      ),
      // A completion whose start was never projected would otherwise make this
      // negative, and a negative "how many are working" is not a thing.
      // `SUM` over no rows is one row of 0, so the list is never empty — but a
      // missing row must still read as "none live" rather than as a crash.
      Effect.map((rows) => {
        const live = rows[0]?.live ?? 0;
        return live > 0 ? live : 0;
      }),
    );

  const listByThreadIdForKinds: ProjectionThreadActivityRepositoryShape["listByThreadIdForKinds"] =
    (input) =>
      input.kinds.length === 0
        ? Effect.succeed([])
        : listProjectionThreadActivityRowsForKinds(input).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionThreadActivityRepository.listByThreadIdForKinds:query",
                "ProjectionThreadActivityRepository.listByThreadIdForKinds:decodeRows",
              ),
            ),
            Effect.map((rows) => rows.map(toProjectionThreadActivity)),
          );

  // A task is open when a `task.started` row carries a taskId that no
  // `task.completed` row for the same thread ever names. Matching on
  // (thread, taskId) rather than taskId alone: the CLI's ids are unique per
  // session, not globally, so two threads can legitimately hold the same one.
  const selectOpenTasks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OpenProjectionThreadTask,
    execute: () =>
      sql`
        SELECT
          started.thread_id AS "threadId",
          json_extract(started.payload_json, '$.taskId') AS "taskId",
          started.turn_id AS "turnId",
          started.summary AS "summary",
          started.created_at AS "createdAt"
        FROM projection_thread_activities started
        WHERE started.kind = 'task.started'
          AND json_extract(started.payload_json, '$.taskId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities done
            WHERE done.kind = 'task.completed'
              AND done.thread_id = started.thread_id
              AND json_extract(done.payload_json, '$.taskId')
                  = json_extract(started.payload_json, '$.taskId')
          )
        ORDER BY started.created_at ASC
      `,
  });

  const listOpenTasks: ProjectionThreadActivityRepositoryShape["listOpenTasks"] =
    selectOpenTasks().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listOpenTasks:query",
          "ProjectionThreadActivityRepository.listOpenTasks:decodeRows",
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
    listByThreadIdForKinds,
    countLiveDelegations,
    deleteByThreadId,
    listOpenTasks,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
