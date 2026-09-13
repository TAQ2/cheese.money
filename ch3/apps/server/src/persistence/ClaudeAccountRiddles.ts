/**
 * The local log of account keep-warm riddles.
 *
 * Every 25 minutes CH3 asks one signed-in Claude account that is NOT the
 * selected one for a short riddle, rotating through them. The point is traffic:
 * an account nobody has selected otherwise sees none, and its rolling session
 * window never turns over. The reply — or the failure — is written here.
 *
 * Keeping the answer rather than discarding it is what makes the loop
 * auditable. The probe runs unattended against accounts nobody is watching, so
 * "did it actually reach this account, and what came back" has to be
 * answerable after the fact. A failed ask is the more valuable row of the two:
 * it usually means that account needs signing in again, which is exactly the
 * thing you want to learn BEFORE failover tries to hand work to it.
 *
 * **The rows never leave this machine.** Same rule as `MeteredModelUse`: no
 * export, no remote aggregation, no telemetry payload. Anything that starts
 * shipping these rows off the box is a change of purpose that has to be argued
 * on its own. See `Migrations/038_ClaudeAccountRiddles.ts`.
 *
 * Writes are best-effort at the call site: failing to log a riddle must never
 * take down the loop, let alone the server.
 *
 * @module ClaudeAccountRiddles
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type ClaudeAccountRiddleRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const RecordClaudeAccountRiddleInput = Schema.Struct({
  askedAt: Schema.DateTimeUtcFromString,
  /** The profile's `CLAUDE_CONFIG_DIR`; the rotation's identity for an account. */
  accountHomePath: Schema.String,
  accountDisplayPath: Schema.String,
  accountEmail: Schema.NullOr(Schema.String),
  accountOrganization: Schema.NullOr(Schema.String),
  model: Schema.String,
  status: Schema.Literals(["answered", "failed"]),
  riddle: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(Schema.String),
  /**
   * The whole reply, kept even when parsing found a clean riddle/answer pair.
   * The model is asked for an exact two-line shape and mostly obeys; when it
   * does not, this is the only record of what it actually said.
   */
  rawOutput: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
});
export type RecordClaudeAccountRiddleInput = typeof RecordClaudeAccountRiddleInput.Type;

/** One account's last ask, which is what the round-robin orders on. */
export const ClaudeAccountRiddleLastAsked = Schema.Struct({
  accountHomePath: Schema.String,
  askedAt: Schema.String,
});
export type ClaudeAccountRiddleLastAsked = typeof ClaudeAccountRiddleLastAsked.Type;

/** One row's outcome, newest first, for spotting an account that always fails. */
export const ClaudeAccountRiddleOutcome = Schema.Struct({
  accountHomePath: Schema.String,
  status: Schema.String,
});
export type ClaudeAccountRiddleOutcome = typeof ClaudeAccountRiddleOutcome.Type;

/**
 * How many rows back the retirement check reads. Comfortably more than
 * (accounts x failure limit) on any real machine, and bounded so the query
 * cost does not grow with the table.
 */
export const CLAUDE_ACCOUNT_RIDDLE_OUTCOME_WINDOW = 200;

export class ClaudeAccountRiddleRepository extends Context.Service<
  ClaudeAccountRiddleRepository,
  {
    readonly record: (
      input: RecordClaudeAccountRiddleInput,
    ) => Effect.Effect<void, ClaudeAccountRiddleRepositoryError>;
    /**
     * When each account was last asked, newest per account. The rotation picks
     * the account whose turn is furthest overdue, so it must survive a restart
     * — reading it from the log rather than memory is what makes that true.
     */
    readonly lastAskedByAccount: Effect.Effect<
      ReadonlyArray<ClaudeAccountRiddleLastAsked>,
      ClaudeAccountRiddleRepositoryError
    >;
    /**
     * Recent outcomes, newest first, so the rotation can retire an account
     * that fails every single time. This is the evidence the loop actually
     * has about whether an account still works — it never probes usage, so
     * the profile's own `usageUnauthorized` flag is never populated for it.
     */
    readonly recentOutcomes: Effect.Effect<
      ReadonlyArray<ClaudeAccountRiddleOutcome>,
      ClaudeAccountRiddleRepositoryError
    >;
  }
>()("ch3/persistence/ClaudeAccountRiddles/ClaudeAccountRiddleRepository") {}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ClaudeAccountRiddleRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: RecordClaudeAccountRiddleInput,
    execute: (input) =>
      sql`
        INSERT INTO claude_account_riddles (
          asked_at,
          account_home_path,
          account_display_path,
          account_email,
          account_organization,
          model,
          status,
          riddle,
          answer,
          raw_output,
          failure,
          duration_ms
        )
        VALUES (
          ${input.askedAt},
          ${input.accountHomePath},
          ${input.accountDisplayPath},
          ${input.accountEmail},
          ${input.accountOrganization},
          ${input.model},
          ${input.status},
          ${input.riddle},
          ${input.answer},
          ${input.rawOutput},
          ${input.failure},
          ${input.durationMs}
        )
      `,
  });

  const selectLastAsked = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ClaudeAccountRiddleLastAsked,
    execute: () =>
      sql`
        SELECT
          account_home_path AS "accountHomePath",
          MAX(asked_at) AS "askedAt"
        FROM claude_account_riddles
        GROUP BY account_home_path
      `,
  });

  const selectRecentOutcomes = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ClaudeAccountRiddleOutcome,
    execute: () =>
      sql`
        SELECT
          account_home_path AS "accountHomePath",
          status
        FROM claude_account_riddles
        ORDER BY asked_at DESC, id DESC
        LIMIT ${CLAUDE_ACCOUNT_RIDDLE_OUTCOME_WINDOW}
      `,
  });

  const record: ClaudeAccountRiddleRepository["Service"]["record"] = (input) =>
    insertRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ClaudeAccountRiddleRepository.record:query",
          "ClaudeAccountRiddleRepository.record:encodeRequest",
        ),
      ),
    );

  const lastAskedByAccount: ClaudeAccountRiddleRepository["Service"]["lastAskedByAccount"] =
    selectLastAsked().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ClaudeAccountRiddleRepository.lastAskedByAccount:query",
          "ClaudeAccountRiddleRepository.lastAskedByAccount:decodeResult",
        ),
      ),
    );

  const recentOutcomes: ClaudeAccountRiddleRepository["Service"]["recentOutcomes"] =
    selectRecentOutcomes().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ClaudeAccountRiddleRepository.recentOutcomes:query",
          "ClaudeAccountRiddleRepository.recentOutcomes:decodeResult",
        ),
      ),
    );

  return {
    record,
    lastAskedByAccount,
    recentOutcomes,
  } satisfies ClaudeAccountRiddleRepository["Service"];
});

export const layer = Layer.effect(ClaudeAccountRiddleRepository, make);
