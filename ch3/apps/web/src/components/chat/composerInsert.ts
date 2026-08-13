/**
 * How an insert joins onto whatever the composer already holds.
 *
 * Every caller that appends to the prompt — a dropped path, a dragged mention,
 * a file-tree "Add to chat", a quoted passage — has to answer the same question
 * about the seam, and each answers it differently: a mention continues the
 * sentence being typed, a quote is a block that starts its own line. Deciding it
 * here keeps that decision next to its one test, and out of four call sites.
 *
 * @module composerInsert
 */

/** `"space"` continues the current line; `"line"` starts a new one. */
export type ComposerInsertBoundary = "space" | "line";

/**
 * The separator to put before an appended insert, given the prompt it lands on.
 *
 * The prompt passed in must be the live one the insert will actually be applied
 * to, not a snapshot read from the editor: the editor's copy lags a controlled
 * update by a render, and a seam decided from the stale value is wrong in
 * exactly the case that matters — the second insert in one tick.
 */
export function composerInsertSeparator(
  prompt: string,
  boundary: ComposerInsertBoundary | undefined,
): string {
  if (boundary === undefined || prompt.length === 0) return "";
  if (boundary === "space") return /\s$/.test(prompt) ? "" : " ";
  return prompt.endsWith("\n") ? "" : "\n";
}
