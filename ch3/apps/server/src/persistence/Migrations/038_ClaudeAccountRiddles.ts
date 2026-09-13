import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * The local log of account keep-warm riddles.
 *
 * CH3 asks one idle signed-in Claude account for a short riddle every 25
 * minutes, rotating through them, so an account that is not currently selected
 * still sees traffic and its rolling session window keeps turning over. The
 * reply lands here.
 *
 * Storing the riddle rather than discarding it is what makes the loop
 * auditable: "did the probe actually reach this account, and what came back"
 * is answerable after the fact, which matters because the whole point of the
 * loop is to exercise accounts nobody is watching. A row is written whether the
 * ask succeeded or failed — a failure is the more interesting reading of the
 * two, since it usually means the account needs signing in again.
 *
 * **This table never leaves the machine.** Same rule as `metered_model_use`:
 * no export, no remote aggregation, no telemetry payload. Anything that starts
 * shipping these rows off the box is a change of purpose and needs to be argued
 * on its own.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS claude_account_riddles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asked_at TEXT NOT NULL,
      account_home_path TEXT NOT NULL,
      account_display_path TEXT NOT NULL,
      account_email TEXT,
      account_organization TEXT,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      riddle TEXT,
      answer TEXT,
      raw_output TEXT,
      failure TEXT,
      duration_ms INTEGER NOT NULL
    )
  `;

  // Reviewing this is always "the recent ones", and the rotation itself reads
  // "when was each account last asked" — both are newest-first per account.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_claude_account_riddles_asked_at
    ON claude_account_riddles(asked_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_claude_account_riddles_account
    ON claude_account_riddles(account_home_path, asked_at DESC)
  `;
});
