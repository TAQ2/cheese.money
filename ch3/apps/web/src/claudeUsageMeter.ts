/**
 * How full a Claude plan meter looks.
 *
 * One rule, shared by the usage band under the composer and the miniature
 * bars in the accounts panel, so the same 71% is never amber in one place and
 * neutral in the other. Thresholds mirror the kanban WIP pill: amber
 * approaching the limit, red at it.
 *
 * @module claudeUsageMeter
 */

/** Amber approaching the limit, red at it, otherwise the ordinary accent. */
export function claudeUsageMeterToneClass(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-warning";
  return "bg-primary/70";
}

/** Percentages arrive from an endpoint, so a bar's width is clamped, never trusted. */
export function clampClaudeUsagePercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}
