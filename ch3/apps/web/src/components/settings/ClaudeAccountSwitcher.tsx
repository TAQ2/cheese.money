import type { ClaudeAccountProfile, EnvironmentId } from "@ch3tools/contracts";
import { squashAtomCommandFailure } from "@ch3tools/client-runtime/state/runtime";
import { CheckIcon, LoaderIcon, PlusIcon, SparklesIcon, UserRoundIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readLocalApi } from "../../localApi";
import {
  claudeProfilePrimaryLabel,
  claudeProfileSecondaryLabel,
  claudeProfileUsageLabel,
  homePathSettingForProfile,
  isSelectableClaudeProfile,
  recommendClaudeAccount,
} from "./ClaudeAccountSwitcher.logic";
import { claudeAccountEnvironment } from "../../state/claudeAccounts";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";

/**
 * Switch which Claude account a provider instance uses.
 *
 * An account is a `CLAUDE_CONFIG_DIR` with its own credentials, so switching
 * is a settings change, not a sign-out: both accounts stay authenticated and
 * switching back is instant. Signing a new one in runs the CLI's own OAuth
 * flow over its local control channel — no tokens are spent anywhere here.
 */
/** How long the recommendation highlight stays up before the panel goes quiet. */
const RECOMMENDATION_HIGHLIGHT_MS = 5000;

export interface ClaudeAccountsManagerProps {
  readonly environmentId: EnvironmentId;
  readonly currentHomePath: string;
  readonly onSelectHomePath: (homePath: string) => void;
  readonly failoverEnabled: boolean;
  readonly onFailoverEnabledChange: (enabled: boolean) => void;
  readonly rotationEnabled: boolean;
  readonly onRotationEnabledChange: (enabled: boolean) => void;
  /** Called after an account is picked, so a popover host can close itself. */
  readonly onSelected?: () => void;
  /** Hide the intro copy when the host section already explains accounts. */
  readonly hideIntro?: boolean;
}

/**
 * The account list, sign-in flow and failover toggle, host-agnostic: the
 * provider card shows this in a popover, and the Accounts settings tab shows
 * the same component full-width. One implementation, so the two can never
 * drift apart on what an account row means.
 */
export function ClaudeAccountsManager(props: ClaudeAccountsManagerProps) {
  const {
    environmentId,
    currentHomePath,
    onSelectHomePath,
    failoverEnabled,
    onFailoverEnabledChange,
    rotationEnabled,
    onRotationEnabledChange,
    onSelected,
    hideIntro,
  } = props;
  const [profiles, setProfiles] = useState<ReadonlyArray<ClaudeAccountProfile> | null>(null);
  const [busy, setBusy] = useState<"listing" | "signing-in" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Electron's renderer ignores window.prompt() entirely — it returns without
  // showing anything, which is why "Add account…" appeared to do nothing.
  // The folder is collected inline instead.
  const [newFolder, setNewFolder] = useState<string | null>(null);
  // The recommendation is a momentary answer, not state the panel keeps: usage
  // moves under it, so a highlight left on screen would quietly go stale.
  const [recommendedHomePath, setRecommendedHomePath] = useState<string | null>(null);
  const recommendationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listProfiles = useAtomCommand(claudeAccountEnvironment.listProfiles, {
    reportFailure: false,
  });
  const startLogin = useAtomCommand(claudeAccountEnvironment.startLogin, { reportFailure: false });
  const awaitLogin = useAtomCommand(claudeAccountEnvironment.awaitLogin, { reportFailure: false });

  const refresh = useCallback(async () => {
    setBusy("listing");
    setNotice(null);
    const result = (await listProfiles({
      environmentId,
      input: { currentHomePath, includeUsage: true },
    })) as
      | { readonly _tag: "Failure"; readonly cause: unknown }
      | {
          readonly _tag: "Success";
          readonly value: { profiles: ReadonlyArray<ClaudeAccountProfile> };
        };
    setBusy(null);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result as never) as Partial<{ detail: string }> | null;
      setNotice(error?.detail?.trim() || "Could not read the Claude accounts.");
      return;
    }
    setProfiles(result.value.profiles);
  }, [currentHomePath, environmentId, listProfiles]);

  const showRecommendation = useCallback(() => {
    if (recommendationTimer.current !== null) {
      clearTimeout(recommendationTimer.current);
      recommendationTimer.current = null;
    }
    const recommendation = recommendClaudeAccount({
      profiles: profiles ?? [],
      nowMs: Date.now(),
    });
    if (!recommendation) {
      setRecommendedHomePath(null);
      setNotice(
        "No usage could be read for the account in use, so there is nothing to compare against yet.",
      );
      return;
    }
    setRecommendedHomePath(recommendation.homePath);
    setNotice(recommendation.detail);
    recommendationTimer.current = setTimeout(() => {
      recommendationTimer.current = null;
      setRecommendedHomePath(null);
      setNotice(null);
    }, RECOMMENDATION_HIGHLIGHT_MS);
  }, [profiles]);

  // A pending timer outliving the panel would set state on an unmounted
  // component — and the popover host unmounts on every close.
  useEffect(
    () => () => {
      if (recommendationTimer.current !== null) {
        clearTimeout(recommendationTimer.current);
        recommendationTimer.current = null;
      }
    },
    [],
  );

  const addAccount = useCallback(
    async (folder: string) => {
      const localApi = readLocalApi();
      const homePath = folder.trim();
      if (homePath.length === 0) {
        return;
      }
      setNewFolder(null);
      setBusy("signing-in");
      setNotice("Starting sign-in…");
      const started = (await startLogin({ environmentId, input: { homePath } })) as
        | { readonly _tag: "Failure"; readonly cause: unknown }
        | { readonly _tag: "Success"; readonly value: { loginId: string; url?: string } };
      if (started._tag === "Failure") {
        const error = squashAtomCommandFailure(started as never) as Partial<{
          detail: string;
        }> | null;
        setBusy(null);
        setNotice(error?.detail?.trim() || "Could not start the Claude sign-in.");
        return;
      }
      const url = started.value.url;
      if (url) {
        if (localApi) {
          void localApi.shell.openExternal(url);
        } else {
          window.open(url, "_blank", "noopener");
        }
        setNotice("Authorize in the browser window that just opened — this waits for it.");
      } else {
        setNotice(
          `Claude returned no sign-in link. Run \`CLAUDE_CONFIG_DIR=${homePath} claude\` in a terminal and use /login instead.`,
        );
        setBusy(null);
        return;
      }
      const completed = (await awaitLogin({
        environmentId,
        input: { loginId: started.value.loginId },
      })) as
        | { readonly _tag: "Failure"; readonly cause: unknown }
        | { readonly _tag: "Success"; readonly value: { profile: ClaudeAccountProfile } };
      setBusy(null);
      if (completed._tag === "Failure") {
        const error = squashAtomCommandFailure(completed as never) as Partial<{
          detail: string;
        }> | null;
        setNotice(error?.detail?.trim() || "The sign-in did not complete.");
        return;
      }
      const signedInAs = completed.value.profile.email ?? completed.value.profile.displayPath;
      setNotice(null);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Claude account added",
          description: `Signed in as ${signedInAs}. Select it to switch this provider over.`,
        }),
      );
      await refresh();
    },
    [awaitLogin, environmentId, refresh, startLogin],
  );

  // Read on mount AND whenever the selected home path changes: the popover
  // host mounts fresh on each open, but the settings tab stays mounted while
  // a selection rewrites `currentHomePath` — without re-reading, the
  // checkmark would sit on the OLD row after a switch, inviting a second
  // click. `refresh` is memoized on exactly those inputs.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="grid min-w-0 gap-2">
      {hideIntro ? null : (
        <div className="grid gap-0.5">
          <p className="text-[13px] font-semibold leading-tight text-foreground">Claude accounts</p>
          <p className="text-xs leading-snug text-muted-foreground">
            Each account is its own config directory, so switching keeps both signed in and is
            instantly reversible. An account must be signed in before it can be selected.
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            Conversations are shared across accounts, so a thread started on one keeps working after
            you switch.
          </p>
        </div>
      )}

      {busy === "listing" && profiles === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderIcon className="size-3 animate-spin" />
          Reading accounts…
        </p>
      ) : null}

      {profiles !== null && profiles.length > 0 ? (
        // `min-w-0` on both the list and each row: without it a grid item
        // is sized by its content, so a long account line widens the whole
        // popup past its own box and every line gets clipped at the edge.
        <ul className="grid min-w-0 gap-1">
          {profiles.map((profile) => {
            const selectable = isSelectableClaudeProfile(profile);
            // A row whose identity reads signed-in but whose stored
            // credential is gone or rejected: switching to it would only
            // fail turns, so it gets an explicit re-sign-in button. The
            // flow touches ONLY this directory's credential — every other
            // account stays signed in.
            const needsReauth =
              selectable &&
              (profile.usageUnauthorized === true || profile.usageCredentialMissing === true);
            return (
              <li className="flex min-w-0 items-center gap-1" key={profile.homePath}>
                <button
                  type="button"
                  disabled={busy !== null}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    profile.isCurrent ? "bg-muted/60" : "hover:bg-muted/40",
                    busy !== null && "opacity-60",
                    // Deliberately a ring rather than a background: the
                    // background already means "in use", and the recommendation
                    // has to stay legible on the row that is BOTH.
                    profile.homePath === recommendedHomePath &&
                      "bg-primary/10 ring-2 ring-primary ring-offset-1 ring-offset-background",
                  )}
                  onClick={() => {
                    if (profile.isCurrent) {
                      onSelected?.();
                      return;
                    }
                    // An unauthenticated config directory would take every
                    // thread on this instance down, so the row signs in
                    // rather than switching.
                    if (!selectable) {
                      void addAccount(profile.homePath);
                      return;
                    }
                    onSelectHomePath(homePathSettingForProfile(profile));
                    onSelected?.();
                  }}
                >
                  <CheckIcon
                    className={cn(
                      "size-3.5 shrink-0",
                      profile.isCurrent ? "text-primary" : "text-transparent",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block break-words text-[13px]",
                        selectable ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {claudeProfilePrimaryLabel(profile)}
                    </span>
                    <span className="block break-words text-[11px] leading-snug text-muted-foreground">
                      {claudeProfileSecondaryLabel(profile)}
                    </span>
                    {claudeProfileUsageLabel(profile) ? (
                      <span className="block break-words text-[11px] leading-snug text-muted-foreground/80">
                        {claudeProfileUsageLabel(profile)}
                      </span>
                    ) : null}
                  </span>
                  {selectable ? null : (
                    <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      Sign in
                    </span>
                  )}
                </button>
                {needsReauth ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    disabled={busy !== null}
                    onClick={() => void addAccount(profile.homePath)}
                  >
                    Sign in
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {profiles !== null && profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">No Claude config directories found.</p>
      ) : null}

      {newFolder !== null ? (
        <div className="grid gap-1.5 rounded-md border border-border/60 p-2">
          <label className="text-[11px] text-muted-foreground" htmlFor="claude-account-folder">
            Folder for the new account — its credentials live here
          </label>
          <input
            id="claude-account-folder"
            autoFocus
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-ring"
            value={newFolder}
            disabled={busy !== null}
            onChange={(event) => setNewFolder(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addAccount(newFolder);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setNewFolder(null);
              }
            }}
          />
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              disabled={busy !== null}
              onClick={() => setNewFolder(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={busy !== null || newFolder.trim().length === 0}
              onClick={() => void addAccount(newFolder)}
            >
              Sign in
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0">{notice}</span>
          {profiles === null && busy === null ? (
            // The list never loaded and nothing retries it by itself — in
            // the settings tab there is no close-and-reopen to lean on.
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => void refresh()}
            >
              Try again
            </Button>
          ) : null}
        </p>
      ) : null}

      <label className="flex cursor-pointer items-start gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 shrink-0 accent-primary"
          checked={failoverEnabled}
          onChange={(event) => onFailoverEnabledChange(event.target.checked)}
        />
        <span className="min-w-0 leading-snug">
          Switch automatically when this account runs out of plan limit, if another signed-in
          account has room. Never mid-reply.
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 shrink-0 accent-primary"
          checked={rotationEnabled}
          onChange={(event) => onRotationEnabledChange(event.target.checked)}
        />
        <span className="min-w-0 leading-snug">
          Start on the best-positioned account, then stick with it until 60% of its 5-hour session
          is spent — after that, check every two minutes for an account with more weekly allowance
          expiring before its reset, and rest the current one. Never mid-reply.
        </span>
      </label>

      <div className="flex items-center gap-2 border-t border-border/60 pt-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={busy !== null}
          onClick={() => setNewFolder((existing) => existing ?? "~/.claude-2")}
        >
          {busy === "signing-in" ? (
            <LoaderIcon className="size-3 animate-spin" />
          ) : (
            <PlusIcon className="size-3" />
          )}
          {busy === "signing-in" ? "Signing in…" : "Add account…"}
        </Button>
        {/*
          Shows what the rotation rules would seat right now, whether or not it
          is what is selected — a read-only sanity check on the logic, so it
          never changes the account itself.
        */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={busy !== null || profiles === null || profiles.length === 0}
          title="Highlight the account these rules would pick right now"
          onClick={showRecommendation}
        >
          <SparklesIcon className="size-3" />
          Show recommended account
        </Button>
      </div>
    </div>
  );
}

/** The provider card's compact host: the same manager inside a popover. */
export function ClaudeAccountSwitcher(
  props: Omit<ClaudeAccountsManagerProps, "onSelected" | "hideIntro">,
) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            aria-label="Switch Claude account"
            title="Switch Claude account"
          >
            <UserRoundIcon className="size-3.5" />
          </Button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="start"
        className="w-[min(22rem,calc(100vw-1.5rem))] [--popup-width:min(22rem,calc(100vw-1.5rem))]"
      >
        <ClaudeAccountsManager {...props} onSelected={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}
