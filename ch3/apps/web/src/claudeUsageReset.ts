/**
 * When a usage window resets, written the same way everywhere it appears.
 *
 * Time-only when it lands today ("4:09pm"), day and time otherwise
 * ("Aug 16 1pm"): the 5-hour session resets within hours, so its date is never
 * in doubt, while the weekly window is days out and the date is the whole
 * point. One function rather than one per surface — the usage band under the
 * composer and the account rows in settings are answering the same question,
 * and a reader who learns the format in one place should not have to learn it
 * again in the other.
 */
export function formatClaudeResetShort(resetsAt: string | undefined): string | null {
  if (resetsAt === undefined) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  const time = at
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s/g, "");
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}
