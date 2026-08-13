/**
 * The whole conversation as plain text, for handing to something outside CH3.
 *
 * Selecting it by hand does not work and cannot be made to: the timeline is
 * virtualised, so the messages scrolled out of view are not in the DOM at all,
 * and a select-all reaches the sidebar and the composer instead. This builds
 * from the thread's own entries, so what lands on the clipboard is the whole
 * conversation whether or not it was ever on screen.
 *
 * @module conversationTranscript
 */
import type { TimelineEntry, WorkLogEntry } from "../../session-logic";

const ROLE_LABELS: Readonly<Record<string, string>> = {
  user: "user_input",
  assistant: "Model Response",
  system: "System",
};

/** One line naming what the agent did, or null for entries that are not an act. */
function formatWorkEntry(entry: WorkLogEntry): string | null {
  // The agent's own narration ("thinking") and status chatter ("info") are not
  // things it did; a transcript of the work is the tools and the failures.
  if (entry.tone !== "tool" && entry.tone !== "error") return null;
  const title = (entry.toolTitle ?? entry.label ?? "").trim();
  const command = (entry.rawCommand ?? entry.command ?? "").trim();
  const heading = entry.tone === "error" ? "Error" : "Tool";
  if (title.length === 0 && command.length === 0) return null;
  if (command.length === 0) return `${heading}: ${title}`;
  if (title.length === 0) return `${heading}: ${command}`;
  // A one-liner reads better inline; a heredoc or a multi-line script does not.
  return command.includes("\n")
    ? `${heading}: ${title}\n${command}`
    : `${heading}: ${title} — ${command}`;
}

/**
 * The conversation in the order it happened: what was asked, what was done,
 * what came back.
 *
 * Quotes inside a message are left exactly as written. Escaping them would make
 * the transcript stop matching the conversation it is a record of, which is the
 * one property a transcript has to keep.
 */
export function formatConversationTranscript(entries: ReadonlyArray<TimelineEntry>): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") {
      const text = entry.message.text.trim();
      if (text.length === 0) continue;
      blocks.push(`${ROLE_LABELS[entry.message.role] ?? entry.message.role}: "${text}"`);
      continue;
    }
    if (entry.kind === "proposed-plan") {
      const plan = entry.proposedPlan.planMarkdown.trim();
      if (plan.length > 0) blocks.push(`Proposed Plan: "${plan}"`);
      continue;
    }
    const work = formatWorkEntry(entry.entry);
    if (work !== null) blocks.push(work);
  }
  return blocks.join("\n\n");
}

/**
 * Select-all, the shortcut — not the app's own keybindings, which is why this is
 * matched by hand rather than registered as a command.
 *
 * Only the bare chord: adding shift or alt makes it someone else's shortcut.
 */
export function isSelectAllShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  if (event.key.toLowerCase() !== "a") return false;
  if (event.shiftKey || event.altKey) return false;
  // Either accelerator counts: macOS sends meta, everywhere else sends ctrl,
  // and a keyboard remapped across platforms should not lose the shortcut.
  return event.metaKey !== event.ctrlKey;
}
