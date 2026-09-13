import type { ClaudeAccountProfile } from "@ch3tools/contracts";

import { clampClaudeUsagePercent, claudeUsageMeterToneClass } from "../../claudeUsageMeter";
import { formatClaudeResetShort } from "../../claudeUsageReset";
import { cn } from "~/lib/utils";

/**
 * The three plan limits for one account, as miniature bars.
 *
 * The row already spells the numbers out — "session 18% · resets 6:29pm · week
 * 0%" — but a list of six accounts is six sentences to read and compare. A bar
 * is comparable at a glance, which is the actual question being asked of this
 * panel: which account has room.
 *
 * Three, matching the band under the composer: the 5-hour session, the 7-day
 * window, and the per-model weekly cap where the plan has one. Same thresholds
 * as that band, from `claudeUsageMeter`, so one reading is never amber in one
 * place and neutral in the other.
 *
 * Renders nothing without a usage reading. An empty track would read as 0% —
 * "this account is untouched" — which is the opposite of what an unread
 * account means, and the mistake the failover rules refuse to make.
 */
export function ClaudeAccountUsageBars({ profile }: { readonly profile: ClaudeAccountProfile }) {
  const usage = profile.usage;
  if (!usage) return null;

  const bars: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly percent: number;
    readonly resetsAt?: string | undefined;
  }> = [
    {
      id: "session",
      label: "5-hour session",
      percent: usage.sessionPercent,
      resetsAt: usage.sessionResetsAt,
    },
    { id: "week", label: "7-day window", percent: usage.weekPercent, resetsAt: usage.weekResetsAt },
    ...(usage.modelWeekPercent === undefined
      ? []
      : [
          {
            id: "modelWeek",
            label: "Fable 7-day window",
            percent: usage.modelWeekPercent,
            resetsAt: usage.modelWeekResetsAt,
          },
        ]),
  ];

  return (
    <span
      data-testid="claude-account-usage-bars"
      // Cached readings are dimmed rather than hidden: they are still the
      // numbers the switching rules are acting on, and the row's own text says
      // "cached" beside them.
      className={cn("mt-1 flex max-w-56 gap-1", profile.usageStale === true && "opacity-60")}
    >
      {bars.map((bar) => {
        const clamped = clampClaudeUsagePercent(bar.percent);
        const rounded = Math.round(clamped);
        const reset = formatClaudeResetShort(bar.resetsAt);
        return (
          <span
            key={bar.id}
            // Decorative, deliberately. These sit inside the account
            // `<button>`, and ARIA makes a button's children presentational —
            // a `role="progressbar"` here is never exposed, while its
            // `aria-label` IS folded into the button's accessible name, which
            // appended "5-hour session usage 7-day window usage" to every row
            // and carried no number with it. The percentages reach a screen
            // reader through the row's own text instead.
            aria-hidden
            title={`${bar.label}: ${rounded}% used${reset ? ` · resets ${reset}` : ""}`}
            className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <span
              aria-hidden
              className={cn("block h-full rounded-full", claudeUsageMeterToneClass(clamped))}
              style={{ width: `${clamped}%` }}
            />
          </span>
        );
      })}
    </span>
  );
}
