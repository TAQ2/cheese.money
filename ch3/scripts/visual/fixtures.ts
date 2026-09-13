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
 *   proven path in this repo — `scripts/showcase-environment.ts` seeds
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
} from "../showcase-environment.ts";

export const VISUAL_THREAD_ID = SHOWCASE_THREAD_ID;

/**
 * A forty-turn conversation, for the surfaces the showcase's two-message
 * threads cannot exercise: a virtualised timeline tall enough that "scroll to
 * end" is a real jump, settled turns folded behind "Worked for ..." rows, a
 * user message long enough to render clipped, and a fenced code block.
 *
 * `findMarker` is a word that appears in the thread exactly three times and
 * nowhere else in the app: inside turn 1's folded commentary, at the end of
 * turn 20's clipped user message, and inside turn 30's code block. A find for
 * it must therefore read "1 of 3" and reveal all three kinds of hidden text.
 * The e2e suite (`e2e/`) is the consumer; the visual harness only sees one more
 * inbox row.
 */
export const LONG_CONVERSATION = {
  threadId: "long-conversation",
  projectId: "ch3",
  title: "Walk the release checklist, one step per turn",
  turnCount: 40,
  findMarker: "quokka",
  foldedMarkerTurn: 1,
  collapsedMarkerTurn: 20,
  codeBlockMarkerTurn: 30,
  /**
   * The last turn's request was sent with an image, and is the only seeded
   * message that carries one. Editing a message is a rewind that resends it,
   * so the flow that has to be provable is "the image comes back with it" —
   * which needs a real attachment: a row that names it and a file on disk.
   */
  attachmentTurn: 40,
  attachmentId: "long-conversation-00000000-0000-4000-8000-000000000001",
  attachmentName: "release-checklist.png",
  turnId: (turn: number) => `long-conversation-t${String(turn)}`,
  requestMessageId: (turn: number) => `long-conversation-t${String(turn)}-request`,
  commentaryMessageId: (turn: number) => `long-conversation-t${String(turn)}-commentary`,
  answerMessageId: (turn: number) => `long-conversation-t${String(turn)}-answer`,
} as const;

const LONG_CONVERSATION_STEPS = [
  "bump the version",
  "regenerate the changelog",
  "run the changed suites",
  "rebuild the desktop artifact",
  "notarize the dmg",
  "smoke the installer",
  "publish the release",
  "announce it",
] as const;

function longConversationRequest(turn: number): string {
  const step = LONG_CONVERSATION_STEPS[(turn - 1) % LONG_CONVERSATION_STEPS.length] ?? "";
  if (turn === LONG_CONVERSATION.collapsedMarkerTurn) {
    // Twelve lines and well past the 600-character ceiling, so the row renders
    // clipped; the marker sits on the last line, inside the clipped part.
    return [
      `Step ${String(turn)}: ${step}, but read the whole checklist first.`,
      "1. Confirm the version in every package.json agrees with the tag.",
      "2. Confirm the changelog names every merged pull request since the last tag.",
      "3. Confirm the desktop artifact was built from the tagged commit, not the branch tip.",
      "4. Confirm the dmg is signed and notarized before it reaches the release page.",
      "5. Confirm the installer opens the app by absolute path after copying it.",
      "6. Confirm the updater offers the new version to a machine still on the old one.",
      "7. Confirm the release notes render on the release page without a broken link.",
      "8. Confirm the announcement names the version and links the release page.",
      "9. Confirm nothing in the release requires a credential that only one person holds.",
      "10. Confirm the rollback path is written down before anybody needs it.",
      `Also rename the fixture animal in the smoke test to ${LONG_CONVERSATION.findMarker} while you are there.`,
    ].join("\n");
  }
  return `Step ${String(turn)}: ${step}. Tell me what you are about to do before you do it.`;
}

function longConversationCommentary(turn: number): string {
  if (turn === LONG_CONVERSATION.foldedMarkerTurn) {
    return `Reading the checklist. The smoke test still names its fixture animal ${LONG_CONVERSATION.findMarker}; noting that for later.`;
  }
  return `Reading step ${String(turn)} before touching anything.`;
}

function longConversationAnswer(turn: number): string {
  const step = LONG_CONVERSATION_STEPS[(turn - 1) % LONG_CONVERSATION_STEPS.length] ?? "";
  // Paragraph counts vary so the virtualised list's row estimates are wrong
  // in both directions, which is what makes a single scroll-to-end jump land
  // short of the real end.
  const paragraphs = [`Step ${String(turn)} is done: ${step}.`];
  for (let index = 0; index < (turn % 5) + 1; index += 1) {
    paragraphs.push(
      `Detail ${String(index + 1)} of step ${String(turn)}: the check passed on the first attempt and left the working tree clean, so nothing needs to be reverted before the next step.`,
    );
  }
  if (turn === LONG_CONVERSATION.codeBlockMarkerTurn) {
    paragraphs.push(
      "The smoke test's fixture now reads:",
      "```ts",
      `const fixtureAnimal = "${LONG_CONVERSATION.findMarker}";`,
      "export const smoke = { fixtureAnimal, retries: 0 };",
      "```",
    );
  }
  if (turn === LONG_CONVERSATION.turnCount) {
    paragraphs.push("That was the last step. The release is out.");
  }
  return paragraphs.join("\n\n");
}

/**
 * A 64px checkerboard. Small enough to live in this file, and a real PNG
 * because the client decodes what it fetches back before re-attaching it.
 */
const ATTACHMENT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAZUlEQVR42u3XoREAIAwEwZST/kuho" +
  "lTwKgaGRUew6ubrhNfh3XZfAAAAAAArwCsfTfcAAAAAADuAEgMAAADYA0oMAAAAYA8oMQAAAIA9oM" +
  "QAAAAA9oASAwAAANgDSgwAAADwDWAAU6FxWotQIRoAAAAASUVORK5CYII=";

const ATTACHMENT_PNG_BYTES = Buffer.from(ATTACHMENT_PNG_BASE64, "base64");

/**
 * Put the attachment's bytes where the server looks for them.
 *
 * A message row that names an attachment is only half of one: the client asks
 * the server to mint an asset URL and then fetches it, and that read resolves
 * `<state dir>/attachments/<id><ext>` — the layout `attachmentStore.ts` owns.
 * Without the file the row renders a broken thumbnail and nothing can be
 * fetched back.
 */
async function writeLongConversationAttachment(stateDir: string): Promise<void> {
  const attachmentsDir = NodePath.join(stateDir, "attachments");
  await NodeFSP.mkdir(attachmentsDir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(attachmentsDir, `${LONG_CONVERSATION.attachmentId}.png`),
    ATTACHMENT_PNG_BYTES,
  );
}

/**
 * Insert the long conversation beside the showcase threads. Same tables and
 * column shapes as `scripts/showcase-environment.ts`, in one transaction: the
 * server is running against this file and would otherwise see a half-written
 * thread.
 */
function seedLongConversation(dbPath: string, now: number, workspaceRoot: string): void {
  const { threadId, projectId, turnCount } = LONG_CONVERSATION;
  const iso = (millis: number) => new Date(millis).toISOString();
  // Three minutes per turn, the last one finishing seven minutes ago.
  const turnStart = (turn: number) => now - (turnCount - turn + 1) * 3 * 60_000 - 7 * 60_000;
  const lastTurnEnd = turnStart(turnCount) + 60_000;
  const database = new NodeSqlite.DatabaseSync(dbPath, { timeout: 30_000 });
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, latest_user_message_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at,
          archived_at, deleted_at, settled_override, settled_at
        ) VALUES (?, ?, ?, ?, 'full-access', 'default', ?, ?, ?, ?, 0, 0, 0, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        threadId,
        projectId,
        LONG_CONVERSATION.title,
        JSON.stringify({ instanceId: "codex", model: "gpt-5.4" }),
        "chore/release-checklist",
        workspaceRoot,
        LONG_CONVERSATION.turnId(turnCount),
        iso(turnStart(turnCount)),
        iso(turnStart(1) - 60_000),
        iso(lastTurnEnd),
      );
    database
      .prepare(
        `INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_instance_id, provider_session_id,
          provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES (?, 'ready', 'Codex', 'codex', NULL, NULL, 'full-access', NULL, NULL, ?)`,
      )
      .run(threadId, iso(lastTurnEnd));
    const insertTurn = database.prepare(
      `INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
        started_at, completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
        checkpoint_files_json, source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (?, ?, NULL, ?, 'completed', ?, ?, ?, NULL, NULL, NULL, '[]', NULL, NULL)`,
    );
    const insertMessage = database.prepare(
      `INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, attachments_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );
    for (let turn = 1; turn <= turnCount; turn += 1) {
      const turnId = LONG_CONVERSATION.turnId(turn);
      const requestedAt = iso(turnStart(turn));
      const commentaryAt = iso(turnStart(turn) + 20_000);
      const answeredAt = iso(turnStart(turn) + 60_000);
      insertTurn.run(
        threadId,
        turnId,
        LONG_CONVERSATION.answerMessageId(turn),
        requestedAt,
        iso(turnStart(turn) + 5_000),
        answeredAt,
      );
      insertMessage.run(
        LONG_CONVERSATION.requestMessageId(turn),
        threadId,
        turnId,
        "user",
        longConversationRequest(turn),
        turn === LONG_CONVERSATION.attachmentTurn
          ? JSON.stringify([
              {
                type: "image",
                id: LONG_CONVERSATION.attachmentId,
                name: LONG_CONVERSATION.attachmentName,
                mimeType: "image/png",
                sizeBytes: ATTACHMENT_PNG_BYTES.byteLength,
              },
            ])
          : null,
        requestedAt,
        requestedAt,
      );
      // Two assistant messages per turn: the first is commentary and folds away
      // once the turn settles; the last stays visible as the turn's answer.
      insertMessage.run(
        LONG_CONVERSATION.commentaryMessageId(turn),
        threadId,
        turnId,
        "assistant",
        longConversationCommentary(turn),
        null,
        commentaryAt,
        commentaryAt,
      );
      insertMessage.run(
        LONG_CONVERSATION.answerMessageId(turn),
        threadId,
        turnId,
        "assistant",
        longConversationAnswer(turn),
        null,
        answeredAt,
        answeredAt,
      );
    }
    database.exec("COMMIT");
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
  /** The forty-turn thread — see `LONG_CONVERSATION`. */
  readonly longThreadId: string;
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
  const showcase = await seedShowcaseEnvironment({ baseDir, now });
  seedLongConversation(dbPath, now, showcase.workspaceRoot);
  await writeLongConversationAttachment(stateDir);
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
    longThreadId: LONG_CONVERSATION.threadId,
    stateDir,
    projectCount: SHOWCASE_PROJECTS.length,
    threadCount: countRows(dbPath, "projection_threads"),
    kanbanCardCount,
  };
}
