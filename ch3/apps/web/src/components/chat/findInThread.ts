import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import { extractTrailingElementContexts } from "../../lib/elementContext";
import { type TimelineEntry } from "../../session-logic";

/**
 * What a user message actually puts on screen.
 *
 * A prompt carries its attachments inline in the stored text — the terminal
 * output that was pasted, the elements that were picked, the preview
 * annotation — and `UserTimelineRow` strips all three before rendering, showing
 * them as chips whose bodies live in a tooltip. Searching the stored text
 * instead would count words the reader cannot see, which is the lying counter
 * this feature was scoped to avoid: "1 of 1" for an `ENOENT` that is nowhere
 * on the page.
 *
 * This mirrors the order `UserTimelineRow` unwraps them in. The two must agree;
 * if that row's derivation changes, this follows it.
 */
function visibleUserMessageText(text: string): string {
  let visible = deriveDisplayedUserMessageState(text).visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visible);
    if (!extracted.annotation) break;
    visible = extracted.promptText;
  }
  return extractTrailingElementContexts(visible).promptText;
}

/**
 * One occurrence of the find query, addressed the way the timeline can act on
 * it: the entry that holds it, and which occurrence within that entry it is.
 *
 * `occurrenceIndex` counts occurrences in the entry's own text. The highlighter
 * counts occurrences in the entry's RENDERED text, which is the same number for
 * a query of plain words and can differ for one carrying markdown syntax — see
 * the note on `findableEntryText`.
 */
export interface ThreadFindMatch {
  readonly entryId: string;
  readonly occurrenceIndex: number;
}

/**
 * What the timeline needs in order to show a search: the query to highlight,
 * and the one occurrence the reader is standing on.
 */
export interface ThreadFindHighlight {
  readonly query: string;
  readonly activeEntryId: string | null;
  readonly activeOccurrenceIndex: number;
}

/**
 * The text of an entry that the find bar searches, or null when the entry is
 * not part of the corpus.
 *
 * User text, assistant text and proposed plans, and nothing else. Messages and
 * plans arrive complete — the thread's whole history is in memory — so a count
 * over them is the truth. Activities (tool calls, thinking, errors) are windowed
 * to the newest few hundred with older ones paged in on scroll, so counting them
 * would report "3 of 17" on a thread that actually holds more, which is worse
 * than a narrower search. System messages are excluded because the timeline does
 * not render them.
 *
 * The text is the message's own source, which is markdown: what the reader sees
 * is that text rendered. A query of plain words matches both identically. A
 * query carrying markdown syntax (`**bold`, `](http`) can match here and have
 * nothing to highlight on screen, or match a link target the reader never sees.
 * The counter and the highlights disagree in exactly that case; the alternative
 * — counting rendered text — cannot count the messages scrolled out of the
 * virtualised list at all, which is a worse lie.
 */
function findableEntryText(entry: TimelineEntry): string | null {
  if (entry.kind === "message") {
    if (entry.message.role === "user") return visibleUserMessageText(entry.message.text);
    return entry.message.role === "assistant" ? entry.message.text : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.planMarkdown;
  }
  return null;
}

/**
 * Every occurrence of `query` in the conversation, in timeline order.
 *
 * Case-insensitive substring matching, non-overlapping — "aa" in "aaaa" is two
 * matches, the way a browser's find bar counts them. A blank query has no
 * matches.
 */
export function findMatchesInThread(
  entries: ReadonlyArray<TimelineEntry>,
  query: string,
): ThreadFindMatch[] {
  const needle = query.toLowerCase();
  if (needle.trim().length === 0) {
    return [];
  }

  const matches: ThreadFindMatch[] = [];
  for (const entry of entries) {
    const text = findableEntryText(entry);
    if (text === null) continue;

    const haystack = text.toLowerCase();
    let occurrenceIndex = 0;
    let cursor = haystack.indexOf(needle);
    while (cursor !== -1) {
      matches.push({ entryId: entry.id, occurrenceIndex });
      occurrenceIndex += 1;
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
  }
  return matches;
}
