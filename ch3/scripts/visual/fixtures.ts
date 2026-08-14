// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Host-side fixture seeding writes the projection database directly.

/**
 * Deterministic fixtures for a visual run.
 *
 * The dev stack starts empty, and an empty app only proves the empty states
 * render. Three seeding routes were considered:
 *
 * - Drive the real UI (add a project, send a message). Needs a live provider
 *   CLI and a real agent turn — slow, network-bound, and non-deterministic.
 * - Dispatch orchestration commands over the WebSocket protocol. Faithful to
 *   production, but it replays through the decider/projector and depends on
 *   provider sessions for anything past thread creation.
 * - Write the projection tables directly. Instant, exact, and already the
 *   proven path in this repo — `scripts/mobile-showcase-environment.ts` seeds
 *   the App Store screenshots this way.
 *
 * The third wins, and reuses that module wholesale rather than growing a second
 * fixture vocabulary. The only thing added on top is a Kanban overlay: stages,
 * card types, and one snoozed thread, so all seven board columns are populated.
 *
 * Trade-off, stated plainly: seeding bypasses the event log, so the projections
 * are consistent with themselves but have no `orchestration_events` behind them.
 * That is invisible to every view this suite captures (they all read
 * projections), and would matter only to a view that replays history.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  SHOWCASE_PROJECTS,
  SHOWCASE_THREAD_ID,
  seedShowcaseEnvironment,
} from "../mobile-showcase-environment.ts";

export const VISUAL_THREAD_ID = SHOWCASE_THREAD_ID;

interface KanbanOverlayEntry {
  readonly threadId: string;
  readonly stage: string | null;
  readonly cardType: string;
  readonly deadlineDays?: number;
  readonly snoozeHours?: number;
  readonly description: string;
  readonly keywords: ReadonlyArray<string>;
}

/**
 * One card per board column. "snoozed" and "settled" are derived by the board
 * from the snooze/settle lifecycle (see kanbanConfig.ts), so they are produced
 * here by snoozing a thread and by leaving the showcase's settled threads alone
 * — never by writing a stage that does not exist in the contract.
 */
const KANBAN_OVERLAY: ReadonlyArray<KanbanOverlayEntry> = [
  {
    threadId: SHOWCASE_THREAD_ID,
    stage: "final-review",
    cardType: "standard",
    description: "Handoff path traced end to end; waiting on a done/not-done call.",
    keywords: ["handoff", "sync"],
  },
  {
    threadId: "pocket-command-center",
    stage: "decision-needed",
    cardType: "urgent",
    description: "Motion treatment needs your approval before it can ship.",
    keywords: ["approval", "motion"],
  },
  {
    threadId: "buttery-suspense",
    stage: "full-attention",
    cardType: "deadline",
    deadlineDays: 2,
    description: "Dropped frames in nested transitions; the trace is dense.",
    keywords: ["perf", "suspense"],
  },
  {
    threadId: "hydration-haikus",
    stage: "move-along",
    cardType: "platform",
    description: "Diagnostics copy is ready; one nudge from landing.",
    keywords: ["dx", "copy"],
  },
  {
    threadId: "beautiful-boot",
    stage: "exploration",
    cardType: "standard",
    description: "Boot timeline shape is still being fleshed out.",
    keywords: ["boot", "plan"],
  },
  {
    threadId: "streaming-shell",
    stage: null,
    cardType: "standard",
    snoozeHours: 3,
    description: "Parked until this afternoon.",
    keywords: ["snoozed"],
  },
];

export interface VisualFixtures {
  readonly environmentId: string;
  readonly threadId: string;
  readonly stateDir: string;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly kanbanCardCount: number;
}

function applyKanbanOverlay(dbPath: string, now: number): number {
  const database = new NodeSqlite.DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    const setKanban = database.prepare(
      "UPDATE projection_threads SET kanban_json = ? WHERE thread_id = ?",
    );
    const setSnooze = database.prepare(
      "UPDATE projection_threads SET snoozed_until = ?, snoozed_at = ? WHERE thread_id = ?",
    );
    let applied = 0;
    for (const entry of KANBAN_OVERLAY) {
      const kanban = {
        stage: entry.stage,
        cardType: entry.cardType,
        deadline:
          entry.deadlineDays === undefined
            ? null
            : new Date(now + entry.deadlineDays * 86_400_000).toISOString(),
        pinned: false,
        description: entry.description,
        keywords: entry.keywords,
        classifiedAt: new Date(now - 5 * 60_000).toISOString(),
      };
      const result = setKanban.run(JSON.stringify(kanban), entry.threadId);
      if (entry.snoozeHours !== undefined) {
        setSnooze.run(
          new Date(now + entry.snoozeHours * 3_600_000).toISOString(),
          new Date(now - 60_000).toISOString(),
          entry.threadId,
        );
      }
      applied += Number(result.changes);
    }
    database.exec("COMMIT");
    return applied;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Nothing to roll back.
    }
    throw error;
  } finally {
    database.close();
  }
}

function countRows(dbPath: string, table: string): number {
  const database = new NodeSqlite.DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as
      | { readonly total: number }
      | undefined;
    return row?.total ?? 0;
  } finally {
    database.close();
  }
}

/**
 * Replace the target instance's projections with the visual fixture set.
 *
 * Destructive by design (the showcase seeder clears the projection tables
 * first), which is why the runner only calls it for a stack it owns, or when
 * `--seed` is passed explicitly.
 */
export async function seedVisualFixtures(input: {
  readonly stateDir: string;
  readonly now?: number;
}): Promise<VisualFixtures> {
  const now = input.now ?? Date.now();
  const stateDir = NodePath.resolve(input.stateDir);
  const baseDir = NodePath.dirname(stateDir);
  if (NodePath.basename(stateDir) !== "userdata") {
    // seedShowcaseEnvironment derives `<baseDir>/userdata/state.sqlite`; handing
    // it a `dev` state dir would clear the projections of a different database
    // than the one being screenshotted.
    throw new Error(
      `Refusing to seed ${stateDir}: fixtures only target a '<home>/userdata' state dir. ` +
        `Boot the stack with --home-dir (the suite default) instead of attaching to a shared dev home.`,
    );
  }
  const dbPath = NodePath.join(stateDir, "state.sqlite");
  // The seeder git-inits each workspace; a second run over a populated
  // workspace would fail on the empty commit instead of re-seeding.
  await NodeFSP.rm(NodePath.join(baseDir, "workspace"), { recursive: true, force: true });
  await seedShowcaseEnvironment({ baseDir, now });
  const kanbanCardCount = applyKanbanOverlay(dbPath, now);
  const environmentId = (
    await NodeFSP.readFile(NodePath.join(stateDir, "environment-id"), "utf8")
  ).trim();
  if (!environmentId) {
    throw new Error(`${stateDir}/environment-id is empty; the server has not finished starting.`);
  }
  return {
    environmentId,
    threadId: VISUAL_THREAD_ID,
    stateDir,
    projectCount: SHOWCASE_PROJECTS.length,
    threadCount: countRows(dbPath, "projection_threads"),
    kanbanCardCount,
  };
}
