import type { EnvironmentId } from "@ch3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { useClaudeAccountSwitchStore } from "../../claudeAccountSwitchStore";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { claudeAccountEnvironment } from "../../state/claudeAccounts";
import { useEnvironmentQuery } from "../../state/query";
import { cn } from "~/lib/utils";

/**
 * The account usage band under the composer: session, week, and per-model
 * (Fable) weekly meters for the account currently in use.
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

// The input before any switch has happened. The family keys on
// JSON.stringify([environmentId, input]), so this constant and a fresh `{}`
// resolve to the same atom — naming it is a readability aid.
const NO_SWITCH_YET = {} as const;

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
  resetsAt,
}: {
  readonly label: string;
  readonly percent: number;
  readonly title: string;
  /** When set, the reset instant is shown inline — the "when do I get it back". */
  readonly resetsAt?: string | undefined;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const rounded = Math.round(percent);
  const reset = formatResetShort(resetsAt);
  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      title={title}
      role="progressbar"
      aria-label={`${label} usage`}
      aria-valuenow={rounded}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="text-muted-foreground">{label}</span>
      <span aria-hidden="true" className="h-2.5 w-40 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", meterToneClass(clamped))}
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="tabular-nums text-foreground/80">{rounded}%</span>
      {reset !== null ? (
        <span className="whitespace-nowrap text-muted-foreground/70">↻ {reset}</span>
      ) : null}
    </div>
  );
}

/**
 * The reset instant, compact enough to live inline: time-only when it lands
 * today ("4:09pm"), day + time otherwise ("Aug 16 1pm") — the session window
 * resets within hours while the weekly one is days out.
 */
function formatResetShort(resetsAt: string | undefined): string | null {
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

function HideBandButton({ onHide }: { readonly onHide: () => void }) {
  return (
    <button
      type="button"
      data-testid="usage-band-hide"
      title="Hide account usage on every thread"
      aria-label="Hide account usage"
      className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
      onClick={onHide}
    >
      <ChevronDownIcon className="size-3.5" />
    </button>
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
  // Re-keys on every account switch, so the band drops the account you just
  // left instead of painting its numbers until the next three-minute poll.
  // Collapsed still disables the shared poll entirely: a hidden band must not
  // keep the environment's usage read alive to feed nothing.
  const accountKey = useClaudeAccountSwitchStore((store) => store.accountKey);
  const input = accountKey.length === 0 ? NO_SWITCH_YET : { accountKey };
  const query = useEnvironmentQuery(
    hidden ? null : claudeAccountEnvironment.currentUsage({ environmentId, input }),
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

  // No usage yet. If the endpoint is rate limiting with nothing cached to show,
  // say so — a blank space would read as "no account" or "0%", the exact
  // confusion this band exists to remove. First-load silence (no data, not
  // rate limited) still renders nothing rather than a flash.
  if (usage === null) {
    if (!rateLimited) {
      return null;
    }
    return (
      <div
        data-testid="usage-band"
        className="relative flex items-center justify-center gap-3 px-2.5 pt-1.5 text-xs opacity-70 sm:px-3"
      >
        <span className="text-muted-foreground" title="The usage endpoint is rate limiting reads">
          Usage unavailable — rate limited
        </span>
        <span className="absolute right-2.5 sm:right-3">
          <HideBandButton onHide={() => updateSettings({ usageBandHidden: true })} />
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="usage-band"
      className={cn(
        "relative flex items-center justify-center gap-6 px-2.5 pt-1.5 text-xs sm:px-3",
        (rateLimited || stale) && "opacity-70",
      )}
    >
      <UsageMeter
        label="Session"
        percent={usage.sessionPercent}
        resetsAt={usage.sessionResetsAt}
        title={`5-hour session${formatReset(usage.sessionResetsAt)}${accountLabel ? ` · ${accountLabel}` : ""}`}
      />
      <UsageMeter
        label="Week"
        percent={usage.weekPercent}
        resetsAt={usage.weekResetsAt}
        title={`7-day window${formatReset(usage.weekResetsAt)}`}
      />
      {usage.modelWeekPercent !== undefined ? (
        // The per-model weekly cap is the meter that actually runs out first
        // on capped plans — the critical one to watch. No inline reset: it
        // resets with the weekly window shown to its left.
        <UsageMeter
          label="Fable"
          percent={usage.modelWeekPercent}
          title={`Fable 7-day window${formatReset(usage.modelWeekResetsAt)}`}
        />
      ) : null}
      {stale ? <span className="text-muted-foreground/60">cached</span> : null}
      {rateLimited ? (
        <span className="text-muted-foreground/60" title="The usage endpoint is rate limiting reads">
          rate limited
        </span>
      ) : null}
      <span className="absolute right-2.5 sm:right-3">
        <HideBandButton onHide={() => updateSettings({ usageBandHidden: true })} />
      </span>
    </div>
  );
}
