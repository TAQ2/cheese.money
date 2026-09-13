import { layer } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert } from "vite-plus/test";

import * as ClaudeAccountRiddles from "./ClaudeAccountRiddles.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const TestLayer = ClaudeAccountRiddles.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const askedAt = DateTime.makeUnsafe("2026-08-16T12:00:00.000Z");

// The layer's database is shared across the tests in this block, so every
// assertion below is scoped to its own account path rather than reading the
// whole table.
const baseRow = {
  askedAt,
  accountDisplayPath: "~/.claude-work",
  accountEmail: "someone@example.com",
  accountOrganization: "CH3",
  model: "claude-haiku-4-5",
  durationMs: 1_200,
};

layer(TestLayer)("ClaudeAccountRiddles", (it) => {
  it.effect("stores the answered riddle alongside the account it came from", () =>
    Effect.gen(function* () {
      const repository = yield* ClaudeAccountRiddles.ClaudeAccountRiddleRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.record({
        ...baseRow,
        accountHomePath: "/home/answered",
        status: "answered",
        riddle: "What has keys but opens nothing?",
        answer: "A piano.",
        rawOutput: "Riddle: What has keys but opens nothing?\nAnswer: A piano.",
        failure: null,
      });

      const rows = yield* sql<{
        readonly account_email: string | null;
        readonly account_organization: string | null;
        readonly model: string;
        readonly status: string;
        readonly riddle: string | null;
        readonly answer: string | null;
        readonly failure: string | null;
        readonly duration_ms: number;
      }>`SELECT account_email, account_organization, model, status, riddle, answer, failure, duration_ms
         FROM claude_account_riddles WHERE account_home_path = '/home/answered'`;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.account_email, "someone@example.com");
      // One login can hold a personal and a work organization with separate
      // limits, so the account row is not identified by email alone.
      assert.equal(rows[0]?.account_organization, "CH3");
      assert.equal(rows[0]?.model, "claude-haiku-4-5");
      assert.equal(rows[0]?.status, "answered");
      assert.equal(rows[0]?.riddle, "What has keys but opens nothing?");
      assert.equal(rows[0]?.answer, "A piano.");
      assert.equal(rows[0]?.failure, null);
      assert.equal(rows[0]?.duration_ms, 1_200);
    }),
  );

  it.effect("records a failed ask, which is the row worth having", () =>
    Effect.gen(function* () {
      // A failure usually means the account needs signing in again — exactly
      // what you want to learn before failover hands real work to it.
      const repository = yield* ClaudeAccountRiddles.ClaudeAccountRiddleRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.record({
        ...baseRow,
        accountHomePath: "/home/failed",
        status: "failed",
        riddle: null,
        answer: null,
        rawOutput: null,
        failure: "Invalid API key · Please run /login",
      });

      const rows = yield* sql<{
        readonly status: string;
        readonly failure: string | null;
        readonly riddle: string | null;
      }>`SELECT status, failure, riddle FROM claude_account_riddles
         WHERE account_home_path = '/home/failed'`;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "failed");
      assert.equal(rows[0]?.failure, "Invalid API key · Please run /login");
      assert.equal(rows[0]?.riddle, null);
    }),
  );

  it.effect("keeps the raw reply when the two-line shape could not be parsed", () =>
    Effect.gen(function* () {
      const repository = yield* ClaudeAccountRiddles.ClaudeAccountRiddleRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.record({
        ...baseRow,
        accountHomePath: "/home/unparsed",
        status: "answered",
        riddle: null,
        answer: null,
        rawOutput: "Sure! Here's a riddle for you...",
        failure: null,
      });

      const rows = yield* sql<{
        readonly raw_output: string | null;
        readonly riddle: string | null;
      }>`SELECT raw_output, riddle FROM claude_account_riddles
         WHERE account_home_path = '/home/unparsed'`;
      // The parse returned nothing, but the reply is not lost.
      assert.equal(rows[0]?.riddle, null);
      assert.equal(rows[0]?.raw_output, "Sure! Here's a riddle for you...");
    }),
  );

  it.effect("reports each account's most recent ask, which is what the rotation orders on", () =>
    Effect.gen(function* () {
      const repository = yield* ClaudeAccountRiddles.ClaudeAccountRiddleRepository;

      const answered = {
        status: "answered" as const,
        riddle: "r",
        answer: "a",
        rawOutput: "Riddle: r\nAnswer: a",
        failure: null,
      };
      yield* repository.record({
        ...baseRow,
        ...answered,
        accountHomePath: "/home/rotation-one",
        askedAt: DateTime.makeUnsafe("2026-08-16T09:00:00.000Z"),
      });
      yield* repository.record({
        ...baseRow,
        ...answered,
        accountHomePath: "/home/rotation-one",
        askedAt: DateTime.makeUnsafe("2026-08-16T11:00:00.000Z"),
      });
      yield* repository.record({
        ...baseRow,
        ...answered,
        accountHomePath: "/home/rotation-two",
        askedAt: DateTime.makeUnsafe("2026-08-16T10:00:00.000Z"),
      });

      const lastAsked = yield* repository.lastAskedByAccount;
      const byAccount = new Map(lastAsked.map((row) => [row.accountHomePath, row.askedAt]));

      // Newest per account, not the first or last written: the rotation reads
      // this to decide whose turn is furthest overdue. Two rows collapse to
      // one, and the later of them wins.
      assert.equal(byAccount.get("/home/rotation-one"), "2026-08-16T11:00:00.000Z");
      assert.equal(byAccount.get("/home/rotation-two"), "2026-08-16T10:00:00.000Z");
      // One entry per account, never one per ask.
      assert.equal(
        lastAsked.filter((row) => row.accountHomePath === "/home/rotation-one").length,
        1,
      );
    }),
  );

  it.effect("reports recent outcomes newest first, which is how retirement is judged", () =>
    Effect.gen(function* () {
      // The rotation retires an account that fails every time, and the ONLY
      // evidence it has is this log — it never probes usage, so a profile's
      // usageUnauthorized flag is never populated for it.
      const repository = yield* ClaudeAccountRiddles.ClaudeAccountRiddleRepository;

      const write = (status: "answered" | "failed", hour: number) =>
        repository.record({
          ...baseRow,
          accountHomePath: "/home/outcomes",
          askedAt: DateTime.makeUnsafe(`2026-08-16T0${String(hour)}:00:00.000Z`),
          status,
          riddle: status === "answered" ? "r" : null,
          answer: status === "answered" ? "a" : null,
          rawOutput: null,
          failure: status === "failed" ? "Invalid API key" : null,
        });

      yield* write("answered", 1);
      yield* write("failed", 2);
      yield* write("failed", 3);

      const outcomes = yield* repository.recentOutcomes;
      const mine = outcomes.filter((row) => row.accountHomePath === "/home/outcomes");
      // Newest first: the two failures precede the older success, which is
      // what lets the counter stop at the first success walking backwards.
      assert.deepEqual(
        mine.map((row) => row.status),
        ["failed", "failed", "answered"],
      );
    }),
  );
});
