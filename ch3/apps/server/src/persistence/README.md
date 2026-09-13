# Persistence

Why this file exists: to capture what the code and the code-graph cannot — why the schema is
append-only, why a migration is frozen the moment it merges, and why a test that runs against
the developer's live database is a bug rather than a shortcut.

The source of truth for _what the schema is_ is the numbered migrations in `Migrations/`, read
in order. This file is for _why_.

## Contract / behavior callers rely on

- **One SQLite file per CH3 home**, at `<home>/userdata/state.sqlite`. A worktree gets its
  own home, so dev work never touches the installed app's data.
- **Events are the truth; projections are derived.** The orchestration event log is append-only
  and is the only durable record of what happened. Everything in a `projection_*` table can be
  dropped and rebuilt from the log. This asymmetry decides most questions here: state written
  only into a projection is state that will be lost, and an edited historical event is a
  corrupted ledger.
- **Migrations run automatically** before the application starts, wherever the migration layer
  is provided. Callers never migrate by hand and never see a partially-migrated schema.
- **The connection runs `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`,
  `foreign_keys = ON`** (`Layers/Sqlite.ts`). NORMAL under WAL fsyncs once per checkpoint instead
  of once per commit — the projector commits once per projector per event, so FULL was one fsync
  per event on every boot replay and every turn. What NORMAL gives up: a power loss or kernel
  panic mid-write can lose the last committed transactions; it cannot corrupt the file. The busy
  timeout exists because the `ch3` CLI opens the same file while the app runs and used to get
  `SQLITE_BUSY` the instant the app held the lock.
- **The client is a native `node:sqlite` port.** `NodeSqliteClient.ts` reimplements
  `@effect/sql-sqlite-node` on Node's built-in bindings specifically to avoid a `better-sqlite3`
  native dependency in a packaged Electron app, where a native module must match the Electron
  ABI and breaks on every upgrade.

## Decisions worth remembering

- **Migrations are statically imported, never filesystem-scanned.** `Migrations.ts` holds an
  explicit import and registry entry per migration. Dynamic directory loading would be less
  code, but it does not survive bundling into `app.asar` — the packaged app has no readable
  migrations directory to scan. The cost is a real one: **a migration file with no entry in
  `Migrations.ts` silently never runs**, and nothing fails loudly to tell you. Adding the file
  is half the job.

- **A merged migration is frozen forever.** This is the ordinary append-only rule, but the
  reason it is absolute here is not the ordinary one. There is no central database. **Every
  developer's machine has already run the old migration against their own real data**, with no
  ops team to reconcile drift and no backup. Editing a merged migration silently diverges every
  existing install, and the damage surfaces as data loss on somebody else's laptop, days later,
  with no way to reconstruct what the schema was supposed to be. A wrong merged migration is
  corrected by appending a new one that fixes it.

  Before merge, on your own branch, the opposite is true: fix it in place — renumber, rewrite,
  or delete and regenerate — rather than stacking fix-up migrations that reviewers must read.

- **`Migrations.ts` is the highest-risk merge-conflict file in the repository.** It is a block
  of sequential imports followed by a sequential registry: precisely the shape where git's merge
  resolves by taking "ours" or "theirs" wholesale and silently drops the other side's lines.
  After any conflict resolution touching this file, verify every migration on disk has **both**
  an import and a registry entry. A dropped line here is invisible in review and lands as
  missing schema on a colleague's machine.

- **Test against a copy of a real database, never the live one.** An empty database is a bad
  test: it has no rows to migrate, no index to slow down, and no shape that resembles what the
  migration will actually meet. Snapshot with `VACUUM INTO`, which is safe even while a server
  holds the source open and yields one consistent file:

  ```bash
  mkdir -p .ch3/userdata
  rm -f .ch3/userdata/state.sqlite*   # VACUUM INTO refuses to overwrite
  # snapshot ~/.ch3/userdata/state.sqlite into the worktree copy
  ```

  A plain `cp` of a live SQLite file is a corrupt copy — it must bring the `-wal` and `-shm`
  siblings along, and even then only when no server holds the source open. **Copy in, never
  symlink**: data flows one way, into your sandbox, and never back out to the developer's real
  database.

## Decisions NOT adopted (so nobody re-litigates them)

- **Filesystem-scanned migrations** — less registration boilerplate, but there is no readable
  migrations directory inside a packaged `app.asar`. Rejected.
- **`better-sqlite3`** — the obvious choice, and the reason `NodeSqliteClient.ts` exists to
  avoid it: a native module in an Electron bundle must match the Electron ABI and breaks on
  every upgrade. Rejected in favour of the built-in `node:sqlite` bindings.
- **A hand-built audit or change-tracking table** — already redundant. The orchestration store
  is event-sourced; the event log _is_ the audit trail. A parallel audit table would be a second
  source of truth that can disagree with the first.
- **Squashing the migration chain** once it grew past forty files — tempting for readability,
  impossible in practice: every existing install has already applied specific revisions, and
  collapsing them breaks the version bookkeeping on machines that are not yours.
- **Rebuilding projections on the read path** rather than maintaining them — simpler code, but
  it moves work onto every render and the UI is the thing users notice. Projections stay
  materialized.

## When you change this

- **Adding a migration**: create `NNN_DescriptiveName.ts` with the next number, then **register
  it in `Migrations.ts`** (static import plus registry entry). Test it against a copy of a real
  database. State the migration number in the PR's CCR Section 2 under `DB Changes`.
- **Changing something already merged**: append a new migration. Never edit the old one.
- **Resolving a conflict in `Migrations.ts`**: cross-check the files on disk against both the
  import list and the registry before committing.
- **The test that enforces the contract**: migration-specific tests are colocated as
  `NNN_Name.test.ts` beside the migrations that need them (see `016`, `019`, `024`, `025` for
  the pattern — the ones with data backfills and cleanups are exactly the ones that earned a
  test). Repository-level behavior is covered by `NodeSqliteClient.test.ts` and
  `RepositoryErrorCorrelation.test.ts`.
