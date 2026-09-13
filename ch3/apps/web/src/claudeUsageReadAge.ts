/**
 * How old a plan-usage reading is, written the same way everywhere it appears.
 *
 * The endpoint rate limits reads. When it refuses, CH3 keeps showing the
 * last numbers it got rather than blanking the meters — a blank reads as "no
 * account" or "0%", which is the opposite of the truth. But a number nobody
 * can date reads as current, so every stood-in reading says how old it is:
 * "read 12m ago".
 *
 * Coarse on purpose. The question a reader has is "can I still trust this",
 * and minutes answer it; seconds would just churn the label every render.
 */
export function formatClaudeUsageReadAge(
  readAt: string | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (readAt === undefined) return null;
  const readAtMs = Date.parse(readAt);
  if (Number.isNaN(readAtMs)) return null;
  const ageMs = Math.max(0, nowMs - readAtMs);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "read just now";
  if (minutes < 60) return `read ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24)
    return remainder === 0 ? `read ${hours}h ago` : `read ${hours}h ${remainder}m ago`;
  const days = Math.floor(hours / 24);
  return `read ${days}d ago`;
}
