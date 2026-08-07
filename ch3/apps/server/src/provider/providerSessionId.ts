/**
 * Pull the provider CLI's own conversation id out of a thread's resume cursor.
 *
 * This is the id a CLI resumes with — `claude --resume <id>` — as opposed to
 * CH3's `threadId`, which no CLI knows about. Cursor shapes are
 * provider-specific and versioned (Claude writes `resume`, OpenCode writes
 * `sessionId`), and a thread has no cursor at all until its first turn, so read
 * defensively and report absence rather than guessing.
 *
 * The value is deliberately not validated as a UUID: Claude's is one, OpenCode's
 * (`ses_…`) is not, and this has to answer for whichever provider owns the
 * thread.
 */
export function readProviderSessionIdFromCursor(cursor: unknown): string | null {
  if (cursor === null || typeof cursor !== "object") {
    return null;
  }
  const candidateCursor = cursor as { readonly resume?: unknown; readonly sessionId?: unknown };
  const candidate =
    typeof candidateCursor.resume === "string"
      ? candidateCursor.resume
      : typeof candidateCursor.sessionId === "string"
        ? candidateCursor.sessionId
        : null;
  if (candidate === null) {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}
