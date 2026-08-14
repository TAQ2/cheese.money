import type { EnvironmentId } from "@ch3tools/contracts";
import { weeklyBurnableRate } from "@ch3tools/shared/claudeAccountRotation";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { claudeAccountEnvironment } from "../../state/claudeAccounts";
import { useEnvironmentQuery } from "../../state/query";
import { cn } from "~/lib/utils";

/**
 * The account usage band under the composer: session, week, and burn-rate
 * markers for the account currently in use.
 *
 * Replaces the per-thread Claude `statusLine` mirror, whose script CH3 ran
 * once per open conversation — each run hitting the rate-limited usage
 * endpoint. This reads through ONE shared query per environment
 * (`claudeAccountEnvironment.currentUsage`, cadence set in client-runtime),
 * so every thread's band paints from a single endpoint read.
 *
 * A single global toggle (`usageBandHidden`) hides it everywhere at once; the
 * collapsed state still shows a slim reveal chevron so it can be brought back
 * from any thread.
 */

// Stable input reference so the shared query's atom-family key never churns —
// a fresh object each render would spawn a new atom (and a new poll) per band.
const USAGE_INPUT = {} as const;

/** Tone thresholds mirror the kanban WIP pill: amber approaching the limit, red at it. */
function meterToneClass(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-warning";
  return "bg-primary/70";
}

function UsageMeter({
  label,
  percent,
  title,
}: {
  readonly label: string;
  readonly percent: number;
  readonly title: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex min-w-0 items-center gap-1.5" title={title}>
      <span className="text-muted-foreground">{label}</span>
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", meterToneClass(clamped))}
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="tabular-nums text-foreground/80">{Math.round(percent)}%</span>
    </div>
  );
}

function formatReset(resetsAt: string | undefined): string {
  if (resetsAt === undefined) return "";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  return ` · resets ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function ClaudeUsageBand({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const hidden = useClientSettings((settings) => settings.usageBandHidden);
  const updateSettings = useUpdateClientSettings();
  const query = useEnvironmentQuery(
    claudeAccountEnvironment.currentUsage({ environmentId, input: USAGE_INPUT }),
  );

  // Collapsed: keep a slim reveal control so the band is recoverable from any
  // thread, since the toggle persists globally.
  if (hidden) {
    return (
      <div className="flex justify-end px-2.5 pt-1 sm:px-3">
        <button
          type="button"
          data-testid="usage-band-show"
          title="Show account usage"
          aria-label="Show account usage"
          className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          onClick={() => updateSettings({ usageBandHidden: false })}
        >
          <ChevronUpIcon className="size-3.5" />
        </button>
      </div>
    );
  }

  const usage = query.data?.usage ?? null;
  const rateLimited = query.data?.rateLimited === true;
  const stale = query.data?.stale === true;
  const accountLabel = query.data?.accountLabel ?? "";

  // Nothing to paint yet (no signed-in account, first read in flight, or an
  // unreadable endpoint that is not rate limited): render nothing rather than
  // a row of zeros, which would read as an empty account.
  if (usage === null) {
    return null;
  }

  const rate = weeklyBurnableRate({
    weekPercent: usage.weekPercent,
    weekResetsAt: usage.weekResetsAt,
    nowMs: Date.now(),
  });

  return (
    <div
      data-testid="usage-band"
      className={cn(
        "flex items-center gap-3 px-2.5 pt-1.5 text-[11px] sm:px-3",
        (rateLimited || stale) && "opacity-70",
      )}
    >
      <UsageMeter
        label="Session"
        percent={usage.sessionPercent}
        title={`5-hour session${formatReset(usage.sessionResetsAt)}${accountLabel ? ` · ${accountLabel}` : ""}`}
      />
      <UsageMeter
        label="Week"
        percent={usage.weekPercent}
        title={`7-day window${formatReset(usage.weekResetsAt)}`}
      />
      <div
        className="flex min-w-0 items-center gap-1.5"
        title="Weekly allowance expiring per day before its reset — the rate the rotation rules burn"
      >
        <span className="text-muted-foreground">Burn</span>
        <span className="tabular-nums text-foreground/80">{Math.round(rate)}%/day</span>
      </div>
      <span className="flex-1" />
      {stale ? <span className="text-muted-foreground/60">cached</span> : null}
      {rateLimited ? (
        <span className="text-muted-foreground/60" title="The usage endpoint is rate limiting reads">
          rate limited
        </span>
      ) : null}
      <button
        type="button"
        data-testid="usage-band-hide"
        title="Hide account usage on every thread"
        aria-label="Hide account usage"
        className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
        onClick={() => updateSettings({ usageBandHidden: true })}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
    </div>
  );
}
