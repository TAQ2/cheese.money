import type { ClaudeAccountProfile, EnvironmentId, ProviderInstanceId } from "@ch3tools/contracts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@ch3tools/contracts";
import { squashAtomCommandFailure } from "@ch3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CheckIcon,
  CopyIcon,
  LoaderIcon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  UserRoundIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  claudeProfilePrimaryLabel,
  claudeProfileSecondaryLabel,
  claudeForceReadBlockedNote,
  claudeProfileUsageLabel,
  accountToSwitchToAfterSignIn,
  claudeUsagePauseNotice,
  homePathSettingForProfile,
  isAgentRunBlockingSwitch,
  isSelectableClaudeProfile,
  isSignedInClaudeProfile,
  manualClaudeSwitchStoppedRunNotice,
  recommendClaudeAccount,
  suggestClaudeAccountFolder,
  collapseClaudeProfilesByAccount,
  isVisibleClaudeAccountRow,
  sortClaudeAccountRows,
  visibleClaudeAccountRows,
} from "./ClaudeAccountSwitcher.logic";
import { ClaudeAccountUsageBars } from "./ClaudeAccountUsageBars";
import { useClaudeAccountSwitchStore } from "../../claudeAccountSwitchStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { claudeAccountEnvironment } from "../../state/claudeAccounts";
import { useThreadShells } from "../../state/entities";
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
export interface ClaudeAccountsManagerProps {
  readonly environmentId: EnvironmentId;
  readonly currentHomePath: string;
  /**
   * The Claude provider instance this switcher points at another account.
   * Switching rebuilds that one instance and stops its live sessions, so it
   * is that instance's running turns — and only those — that a switch must
   * wait for. Defaults to the built-in `claudeAgent` slot.
   */
  readonly instanceId?: ProviderInstanceId;
  readonly onSelectHomePath: (homePath: string) => void;
  readonly failoverEnabled: boolean;
  readonly onFailoverEnabledChange: (enabled: boolean) => void;
  readonly rotationEnabled: boolean;
  readonly onRotationEnabledChange: (enabled: boolean) => void;
  readonly keepWarmEnabled: boolean;
  readonly onKeepWarmEnabledChange: (enabled: boolean) => void;
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
    keepWarmEnabled,
    onKeepWarmEnabledChange,
    onSelected,
    hideIntro,
  } = props;
  const [profiles, setProfiles] = useState<ReadonlyArray<ClaudeAccountProfile> | null>(null);
  // The seat decides whether the shared Fable account's row can be selected.
  // "Never mid-reply" holds for the automatic switch after a sign-in too — for
  // the replies a switch would actually cut. Switching rebuilds THIS Claude
  // instance and stops its sessions, and nothing else's: a Codex turn, another
  // Claude instance, an orchestrator run on some other provider all keep
  // going. Counting them here made every sign-in on a busy machine end in
  // "an agent is working, so this provider was not switched" — and the person
  // who had just signed in to escape an exhausted account stayed on it until a
  // restart ended every run at once.
  const threadShells = useThreadShells();
  const switchInstanceId =
    props.instanceId ?? defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
  const agentRunActive = useMemo(
    () => threadShells.some((shell) => isAgentRunBlockingSwitch(shell, switchInstanceId)),
    [switchInstanceId, threadShells],
  );
  // The line that makes terminals CH3 did NOT spawn follow this selection.
  // Sent by the environment because it is that machine's own path.
  const [shimPathLine, setShimPathLine] = useState<string | null>(null);
  const [busy, setBusy] = useState<"listing" | "signing-out" | null>(null);
  // Sign-in is tracked apart from `busy` because it outlives the other two and
  // overlaps them: a list refresh — which any account switch triggers — would
  // otherwise clear the shared slot and take the "Signing in…" label and its
  // Cancel button away while the OAuth window was still open, leaving a live
  // attempt the user could neither see nor stop.
  // `homePath` marks the row being signed into, so its own button can show the
  // wait.
  const [signingIn, setSigningIn] = useState<{
    readonly loginId: string;
    readonly homePath: string;
  } | null>(null);
  const signingInRef = useRef(signingIn);
  signingInRef.current = signingIn;
  const installCli = useAtomCommand(claudeAccountEnvironment.installCli, {
    reportFailure: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The Claude Code CLI is missing, which is the one failure CH3 can repair
   * without the person opening a terminal. Set from the error's own reason
   * rather than by reading its prose.
   */
  const [cliMissing, setCliMissing] = useState(false);
  const [installing, setInstalling] = useState(false);
  // Which row is awaiting a sign-out confirmation. Clearing a credential is
  // destructive and irreversible in one click, so it takes two.
  const [signOutConfirm, setSignOutConfirm] = useState<string | null>(null);
  // The highlight stays up for as long as the panel is open: it is an answer
  // the user asked for and may act on, and a self-clearing highlight took it
  // away mid-read. Leaving the view unmounts this component, which drops it —
  // so the answer never outlives the screen it was asked on.
  const [recommendedHomePath, setRecommendedHomePath] = useState<string | null>(null);
  // A sign-in nobody finishes holds the server side open for five minutes.
  // While it waited, `busy` disabled every control on the panel — the whole
  // accounts view read as broken, with no way back except waiting it out.
  // Each attempt takes a ticket; a superseded or cancelled one drops its
  // result on the floor instead of writing over live state.
  const loginAttempt = useRef(0);
  /**
   * Which refresh is the latest. A refresh is two requests — identities, then
   * usage — and anything that starts another one in between (a switch, a
   * sign-out) must not have its result overwritten by the older second half.
   */
  const refreshSeq = useRef(0);
  /** The last sign-in start, for swallowing the double-click that duplicates windows. */
  const lastStartRef = useRef<{ readonly homePath: string; readonly atMs: number } | null>(null);

  const listProfiles = useAtomCommand(claudeAccountEnvironment.listProfiles, {
    reportFailure: false,
  });
  const startLogin = useAtomCommand(claudeAccountEnvironment.startLogin, { reportFailure: false });
  const awaitLogin = useAtomCommand(claudeAccountEnvironment.awaitLogin, { reportFailure: false });
  const cancelLogin = useAtomCommand(claudeAccountEnvironment.cancelLogin, {
    reportFailure: false,
  });
  const signOut = useAtomCommand(claudeAccountEnvironment.signOut, { reportFailure: false });
  const forceUsageRead = useAtomCommand(claudeAccountEnvironment.forceUsageRead, {
    reportFailure: false,
  });
  /** The row whose forced read is in flight, by config directory. */
  const [forcingUsage, setForcingUsage] = useState<string | null>(null);
  const noteAccountSwitched = useClaudeAccountSwitchStore((store) => store.noteAccountSwitched);
  const noteUsageRead = useClaudeAccountSwitchStore((store) => store.noteUsageRead);
  const { copyToClipboard: copyShimPathLine, isCopied: shimPathLineCopied } = useCopyToClipboard({
    target: "the shell line",
  });

  const refresh = useCallback(async () => {
    const seq = (refreshSeq.current += 1);
    setBusy("listing");
    setNotice(null);
    type Listed =
      | { readonly _tag: "Failure"; readonly cause: unknown }
      | {
          readonly _tag: "Success";
          readonly value: {
            profiles: ReadonlyArray<ClaudeAccountProfile>;
            terminalShimPathLine: string | null;
          };
        };
    // Two requests, not one. The first carries identities AND cached usage:
    // both are local reads (file plus the persisted usage cache), so rows AND
    // their last-known numbers paint at once, the instant the page opens. The
    // second is the live refresh — one HTTPS call per account, spaced by the
    // server so the endpoint does not rate-limit it, seven accounts is ten to
    // twenty seconds — and it lands fresh numbers on top when they arrive.
    // Before this, the first request skipped usage entirely, so every row's
    // usage sat blank for that whole window even though a cached number was
    // on disk.
    const listed = (await listProfiles({
      environmentId,
      input: { currentHomePath, includeUsage: true, cachedUsageOnly: true },
    })) as Listed;
    if (seq !== refreshSeq.current) return;
    if (listed._tag === "Failure") {
      setBusy(null);
      const error = squashAtomCommandFailure(listed as never) as Partial<{ detail: string }> | null;
      setNotice(error?.detail?.trim() || "Could not read the Claude accounts.");
      return;
    }
    // Reclaimed here, deduplicated on the way to the screen (see `accountRows`):
    // whether a roster slot is worth showing depends on who is signed in
    // right now, and that changes without a re-list. Dropping the slot here
    // made an account that signed out of a hand-named folder vanish — its
    // own row hidden as residue, its slot already gone from the list.
    setProfiles(listed.value.profiles);
    setShimPathLine(listed.value.terminalShimPathLine);
    setBusy(null);

    const withUsage = (await listProfiles({
      environmentId,
      input: { currentHomePath, includeUsage: true },
    })) as Listed;
    // A refresh that started after this one owns the screen now; an older
    // usage read landing on top of it would put back a state that has moved.
    if (seq !== refreshSeq.current || withUsage._tag === "Failure") return;
    setProfiles(withUsage.value.profiles);
    setShimPathLine(withUsage.value.terminalShimPathLine);
  }, [currentHomePath, environmentId, listProfiles]);

  const showRecommendation = useCallback(() => {
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
  }, [profiles]);

  const addAccount = useCallback(
    async (folder: string, profile?: ClaudeAccountProfile) => {
      // Which address to offer the sign-in page: the one already in the
      // folder, which makes this a re-authentication. A brand-new account has
      // none, and the page asks for it as it always did.
      const knownEmail = profile ? (profile.email ?? "").trim() : "";
      const homePath = folder.trim();
      if (homePath.length === 0) {
        return;
      }
      // A deliberate second click replaces the attempt in flight — that is the
      // recovery path and stays. A DOUBLE-click is not deliberate: two
      // attempts 600 ms apart each opened a sign-in window, the second
      // cancelled the first's login mid-OAuth, and the person watched a
      // finished consent bounce back to the address page and end on a dead
      // callback. Within a beat of the last start, a repeat click is the
      // same click.
      const nowMs = Date.now();
      if (lastStartRef.current !== null && nowMs - lastStartRef.current.atMs < 2_000) {
        return;
      }
      lastStartRef.current = { homePath, atMs: nowMs };
      const attempt = loginAttempt.current + 1;
      loginAttempt.current = attempt;
      const superseded = () => loginAttempt.current !== attempt;
      // Starting a second sign-in ends the first one for real. Leaving it to
      // expire would keep a CLI session alive against a folder this attempt
      // may be about to sign into.
      const replaced = signingIn;
      setSigningIn(null);
      if (replaced) {
        void cancelLogin({ environmentId, input: { loginId: replaced.loginId } });
      }
      setNotice("Starting sign-in…");
      const started = (await startLogin({ environmentId, input: { homePath } })) as
        | { readonly _tag: "Failure"; readonly cause: unknown }
        | { readonly _tag: "Success"; readonly value: { loginId: string; url?: string } };
      if (superseded()) return;
      if (started._tag === "Failure") {
        const error = squashAtomCommandFailure(started as never) as Partial<{
          detail: string;
          reason: string;
        }> | null;
        setCliMissing(error?.reason === "cli-missing");
        setNotice(error?.detail?.trim() || "Could not start the Claude sign-in.");
        return;
      }
      // The sign-in started, so the CLI runs. Cleared here rather than left to
      // rot: it is only ever set by a failure, so a stale one put an "Install
      // Claude Code" button beside every later, unrelated notice.
      setCliMissing(false);
      const loginId = started.value.loginId;
      setSigningIn({ loginId, homePath });
      const url = started.value.url;
      if (url) {
        // Name the account before opening the window, so the shell can type it
        // into the sign-in page's email box. Sent every time, `null` included:
        // a re-auth that was abandoned must not leave its address pending for
        // a brand-new account to inherit. Awaited so the hint is on record
        // before the window that consumes it exists.
        //
        // Swallowed on failure: this is a convenience, and an older shell with
        // no handler for the channel rejects the invoke. Letting that throw
        // would abort the sign-in itself — `addAccount` is called as
        // `void addAccount(...)`, so the rejection would skip `window.open`
        // entirely and strand the panel showing an attempt with no window.
        await window.desktopBridge?.setClaudeSignInEmailHint?.(knownEmail || null).catch(() => {});
        if (superseded()) return;
        // ONE path only: the desktop shell intercepts this window.open and
        // shows the OAuth page as an in-app child window (DesktopWindow's
        // window-open handler). The preview-panel route was removed — its
        // navigation policy could bounce the OAuth redirect to the system
        // browser. A plain browser build opens a tab, as before.
        window.open(url, "_blank");
        setSigningIn({ loginId, homePath });
        setNotice(
          "Authorize in the CH3 sign-in window that just opened — this waits for it. Cancel to get the panel back.",
        );
      } else {
        setNotice(
          `Claude returned no sign-in link. Run \`CLAUDE_CONFIG_DIR=${homePath} claude\` in a terminal and use /login instead.`,
        );
        setSigningIn(null);
        return;
      }
      const completed = (await awaitLogin({
        environmentId,
        input: { loginId },
      })) as
        | { readonly _tag: "Failure"; readonly cause: unknown }
        | { readonly _tag: "Success"; readonly value: { profile: ClaudeAccountProfile } };
      if (superseded()) return;
      setSigningIn(null);
      if (completed._tag === "Failure") {
        const error = squashAtomCommandFailure(completed as never) as Partial<{
          detail: string;
        }> | null;
        setNotice(error?.detail?.trim() || "The sign-in did not complete.");
        return;
      }
      const signedIn = completed.value.profile;
      const signedInAs = signedIn.email ?? signedIn.displayPath;
      setNotice(null);
      // Signing in from here is the decision to use the account, so the
      // switch follows: the "select it yourself" toast this replaced left
      // people on the exhausted account they had just signed in to escape.
      const next = accountToSwitchToAfterSignIn(signedIn, currentHomePath, agentRunActive);
      if (next !== null) {
        onSelectHomePath(next);
        noteAccountSwitched(signedIn.homePath);
      }
      const alreadyInUse = homePathSettingForProfile(signedIn) === currentHomePath.trim();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: next !== null ? "Signed in and switched" : "Claude account added",
          description:
            next !== null
              ? `${signedInAs} is now the account in use. Pick another row here to switch back.`
              : alreadyInUse
                ? `Signed in as ${signedInAs}, the account already in use.`
                : `Signed in as ${signedInAs}. An agent is working, so this provider was not switched — pick its row when the reply ends.`,
        }),
      );
      await refresh();
    },
    [
      agentRunActive,
      awaitLogin,
      cancelLogin,
      currentHomePath,
      environmentId,
      noteAccountSwitched,
      onSelectHomePath,
      refresh,
      signingIn,
      startLogin,
    ],
  );

  // Stops a sign-in the user walked away from, on the server as well as here:
  // an attempt left running holds a CLI session for its whole timeout, and its
  // cleanup can still fire minutes later — after a second attempt has signed
  // into that same folder. Cancelling for real is what makes this message true.
  const cancelSignIn = useCallback(() => {
    const pending = signingIn;
    loginAttempt.current += 1;
    setSigningIn(null);
    setNotice("Sign-in cancelled. The account list is unchanged.");
    if (!pending) return;
    void cancelLogin({ environmentId, input: { loginId: pending.loginId } });
  }, [cancelLogin, environmentId, signingIn]);

  /**
   * What the list renders: one row per account.
   *
   * `profiles` stays the raw per-directory truth — sign-out, sign-in and the
   * in-place row update all work in those terms — and this is only what the
   * reader sees.
   */
  const accountRows = useMemo(
    () =>
      sortClaudeAccountRows(
        visibleClaudeAccountRows(collapseClaudeProfilesByAccount(profiles ?? [])),
      ),
    [profiles],
  );
  const signingInNewFolder =
    signingIn !== null &&
    !accountRows.some(({ homePaths }) => homePaths.includes(signingIn.homePath));

  const signOutAccount = useCallback(
    async (
      profile: ClaudeAccountProfile,
      homePaths: ReadonlyArray<string> = [profile.homePath],
    ) => {
      setSignOutConfirm(null);
      setBusy("signing-out");
      setNotice(null);
      // Every directory this account occupies, not just the row's own. One
      // account can still sit in several folders — the duplicates the
      // cookie-jar bug made are on disk for good — and signing out one of them
      // leaves the others signed in, which reads as a sign-out that did
      // nothing. Sequential rather than concurrent: each one edits its own
      // config and the shared Keychain entry is spared only while a sibling
      // still holds the identity, which is a decision per call.
      // Every folder's re-probe is kept, not only the last: a row that
      // collapses several folders must see all of them signed out, or the
      // survivors keep it reading as signed in.
      const signedOutProfiles: ClaudeAccountProfile[] = [];
      let failure: { readonly _tag: "Failure"; readonly cause: unknown } | null = null;
      for (const homePath of homePaths) {
        const result = (await signOut({ environmentId, input: { homePath } })) as
          | { readonly _tag: "Failure"; readonly cause: unknown }
          | { readonly _tag: "Success"; readonly value: { profile: ClaudeAccountProfile } };
        if (result._tag === "Failure") {
          failure = result;
          break;
        }
        signedOutProfiles.push(result.value.profile);
      }
      setBusy(null);
      if (failure !== null) {
        const error = squashAtomCommandFailure(failure as never) as Partial<{
          detail: string;
        }> | null;
        setNotice(error?.detail?.trim() || "Could not sign this account out.");
        return;
      }
      const signedOut = claudeProfilePrimaryLabel(profile);
      // Signing out is what turns a row into residue, so for most accounts the
      // row goes with it — and the old copy promised a row that would not be
      // there. Two ways back. A roster account's slot comes straight back as
      // an empty row the moment its address is no longer signed in anywhere
      // (see `accountRows`), so it is signed into again from there — the
      // folder it occupied before is not the point, the account is. Anything
      // else is signed into again by naming its folder: it is still on disk
      // with its history, and Add account takes a path.
      const next = signedOutProfiles[signedOutProfiles.length - 1] ?? profile;
      const rowSurvives = isVisibleClaudeAccountRow({ ...next, isCurrent: profile.isCurrent });
      const slotReturns = false;
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Signed out",
          description:
            rowSurvives || slotReturns
              ? `${signedOut} is signed out. Sign back in from its row whenever you want.`
              : `${signedOut} is signed out and its row is gone. The folder is still there — add ${profile.displayPath} again to sign back in.`,
        }),
      );
      // Update only the signed-out rows, in place, from the re-probed profiles.
      // A blanket refresh() would re-list EVERY account with usage — a burst of
      // reads against the same rate-limited endpoint the whole redesign exists
      // to spare. Sign-out is directory-scoped, so no other row changes.
      // `isCurrent` is preserved from the existing row: the re-probe always
      // reports false, but the instance's selection has not moved.
      const byHomePath = new Map(signedOutProfiles.map((entry) => [entry.homePath, entry]));
      setProfiles((current) =>
        current === null
          ? current
          : current.map((entry) => {
              const replaced = byHomePath.get(entry.homePath);
              return replaced === undefined ? entry : { ...replaced, isCurrent: entry.isCurrent };
            }),
      );
    },
    [environmentId, signOut],
  );

  /**
   * Read ONE account's usage now, past its freshness window and past the pause
   * the endpoint asked for.
   *
   * Only ever from this button. The automatic loops are what earned the
   * penalty, so the fix for a stale number is a person asking for it — once,
   * with the server's own throttle stopping a second ask inside the minute.
   *
   * Only this row is replaced. A blanket refresh would re-read every account
   * against the same rate-limited endpoint, which is the burst the whole
   * design exists to avoid.
   */
  const forceRead = useCallback(
    async (profile: ClaudeAccountProfile) => {
      setForcingUsage(profile.homePath);
      setNotice(null);
      const result = (await forceUsageRead({
        environmentId,
        input: { homePath: profile.homePath },
      })) as
        | { readonly _tag: "Failure"; readonly cause: unknown }
        | { readonly _tag: "Success"; readonly value: { profile: ClaudeAccountProfile } };
      setForcingUsage(null);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result as never) as Partial<{
          detail: string;
        }> | null;
        setNotice(error?.detail?.trim() || "Could not read that account's usage.");
        return;
      }
      const next = result.value.profile;
      // A forced read that is refused AGAIN is said out loud. Going quiet here
      // would leave the person watching an unchanged number with no way to
      // tell whether the button did nothing or the endpoint did.
      if (next.usageRateLimited === true) {
        setNotice(
          `${claudeProfilePrimaryLabel(next)} is still being rate limited by Anthropic — ` +
            `the reading below is the last one that landed.`,
        );
      } else if (next.usageShapeUnrecognized === true) {
        setNotice(
          `Anthropic answered for ${claudeProfilePrimaryLabel(next)} in a shape CH3 cannot ` +
            `read. This needs a CH3 update, not another try.`,
        );
      }
      setProfiles((current) =>
        current === null
          ? current
          : current.map((entry) =>
              entry.homePath === next.homePath ? { ...next, isCurrent: entry.isCurrent } : entry,
            ),
      );
      // The band under the composer reads the account in use, and it caches.
      // A forced read of THAT account is strictly fresher than what the band is
      // showing, so it has to be told: the panel said 100% one second after
      // asking Anthropic while the band still read 97% from a poll minutes old.
      // A forced read of any other row changes nothing the band displays.
      if (profile.isCurrent === true) noteUsageRead();
    },
    [environmentId, forceUsageRead, noteUsageRead],
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

      {accountRows.length > 0 ? (
        // `min-w-0` on both the list and each row: without it a grid item
        // is sized by its content, so a long account line widens the whole
        // popup past its own box and every line gets clipped at the edge.
        <ul className="grid min-w-0 gap-1">
          {accountRows.map(({ profile, homePaths }) => {
            const selectable = isSelectableClaudeProfile(profile);
            const lockedForSeat = false;
            const poolNote: string | null = null;
            // A row whose identity reads signed-in but whose stored
            // credential is gone or rejected: switching to it would only
            // fail turns, so it gets an explicit re-sign-in button. The
            // flow touches ONLY this directory's credential — every other
            // account stays signed in.
            const needsReauth =
              selectable &&
              (profile.usageUnauthorized === true || profile.usageCredentialMissing === true);
            // Read once per render rather than on a ticking clock: nothing here
            // repaints continuously, and the throttle window is a minute, so
            // the next interaction with the panel is soon enough to clear it.
            const forceReadBlocked = claudeForceReadBlockedNote(profile, Date.now());
            return (
              <li className="flex min-w-0 items-center gap-1" key={profile.homePath}>
                <button
                  type="button"
                  // Same rule as the re-sign-in button: only a list refresh or
                  // a sign-out blocks the row. A sign-in left hanging used to
                  // disable every account here, which read as a dead panel.
                  // `lockedForSeat` disables it too — the row's `poolNote`
                  // explains why, and a clickable row that silently no-ops is
                  // worse than one that reads as disabled.
                  disabled={busy !== null || lockedForSeat}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    profile.isCurrent ? "bg-muted/60" : "hover:bg-muted/40",
                    (busy !== null || lockedForSeat) && "opacity-60",
                    // Deliberately a ring rather than a background: the
                    // background already means "in use", and the recommendation
                    // has to stay legible on the row that is BOTH.
                    profile.homePath === recommendedHomePath &&
                      "bg-primary/10 ring-2 ring-primary ring-offset-1 ring-offset-background",
                  )}
                  onClick={() => {
                    // A signed-out directory signs back in — checked BEFORE
                    // `isCurrent`, because the account IN USE can be the one
                    // that logged out (externally, or via sign-out here), and
                    // an isCurrent-first guard would make its row a dead no-op
                    // with no way to re-authenticate it from this panel.
                    if (!selectable) {
                      void addAccount(profile.homePath, profile);
                      return;
                    }
                    if (profile.isCurrent) {
                      onSelected?.();
                      return;
                    }
                    onSelectHomePath(homePathSettingForProfile(profile));
                    // Re-key the usage band so it reads the account just
                    // chosen, instead of showing the previous one's numbers
                    // until its next poll.
                    noteAccountSwitched(profile.homePath);
                    // The switch itself never refuses a manual click, but the
                    // rebuild it triggers stops this provider's sessions — see
                    // `agentRunActive` above — and the row gives no other sign
                    // of that. Say so.
                    if (agentRunActive) {
                      toastManager.add(
                        stackedThreadToast({
                          type: "warning",
                          title: "Switched accounts",
                          description: manualClaudeSwitchStoppedRunNotice(
                            claudeProfilePrimaryLabel(profile),
                          ),
                        }),
                      );
                    }
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
                    {poolNote ? (
                      <span
                        data-testid="claude-account-pool-note"
                        className="block break-words text-[11px] leading-snug text-muted-foreground/70"
                      >
                        {poolNote}
                      </span>
                    ) : null}
                    {claudeProfileUsageLabel(profile) ? (
                      <span className="block break-words text-[11px] leading-snug text-muted-foreground/80">
                        {claudeProfileUsageLabel(profile)}
                      </span>
                    ) : null}
                    <ClaudeAccountUsageBars profile={profile} />
                  </span>
                </button>
                {/* One control for both ways in: a row whose credential
                    expired and a roster slot never signed into are the same
                    action, so they get the same button rather than a button
                    on one and a dim label on the other. */}
                {needsReauth || (!selectable && !lockedForSeat) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    // A sign-in already in flight does not disable this one:
                    // clicking another account supersedes the old attempt
                    // rather than leaving the row inert.
                    disabled={busy !== null}
                    onClick={() => void addAccount(profile.homePath, profile)}
                  >
                    {signingIn?.homePath === profile.homePath ? (
                      <>
                        <LoaderIcon className="size-3 animate-spin" />
                        Signing in…
                      </>
                    ) : (
                      "Sign in"
                    )}
                  </Button>
                ) : null}
                {/* The only way to make a stale reading try again. Before it,
                    "Try again" rendered solely when the profile list had never
                    loaded, so someone staring at a nine-hour-old number had no
                    control at all — the loops were being refused and there was
                    nothing else to press. User-initiated only, and throttled
                    server-side to once a minute per account so it cannot
                    deepen the penalty it is fighting. */}
                {isSignedInClaudeProfile(profile) ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 shrink-0 text-muted-foreground/70 hover:text-foreground"
                    title={
                      forceReadBlocked ?? `Read ${claudeProfilePrimaryLabel(profile)}'s usage now`
                    }
                    disabled={busy !== null || forcingUsage !== null || forceReadBlocked !== null}
                    onClick={() => void forceRead(profile)}
                  >
                    {forcingUsage === profile.homePath ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                    <span className="sr-only">
                      {forceReadBlocked ?? "Read this account's usage now"}
                    </span>
                  </Button>
                ) : null}
                {/* Sign-out is offered for every signed-in row, current one
                    included, so an account that logged out externally can be
                    reset by hand. Two clicks: the credential wipe is
                    irreversible in one. */}
                {isSignedInClaudeProfile(profile) ? (
                  signOutConfirm === profile.homePath ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 border-destructive/50 px-2 text-[11px] text-destructive-foreground"
                        disabled={busy !== null}
                        onClick={() => void signOutAccount(profile, homePaths)}
                      >
                        {busy === "signing-out" ? (
                          <LoaderIcon className="size-3 animate-spin" />
                        ) : (
                          "Sign out"
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[11px]"
                        disabled={busy !== null}
                        onClick={() => setSignOutConfirm(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 shrink-0 text-muted-foreground/70 hover:text-destructive-foreground"
                      title={`Sign ${claudeProfilePrimaryLabel(profile)} out`}
                      aria-label={`Sign ${claudeProfilePrimaryLabel(profile)} out`}
                      disabled={busy !== null}
                      onClick={() => {
                        setSignOutConfirm(profile.homePath);
                        // Signing out the in-use account strands the instance
                        // on a signed-out directory until failover or a manual
                        // switch — warn before the confirm, not after.
                        setNotice(
                          profile.isCurrent
                            ? "This is the account in use — after signing out, its threads fail until you switch accounts or sign in again."
                            : null,
                        );
                      }}
                    >
                      <LogOutIcon className="size-3.5" />
                    </Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {profiles !== null && profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">No Claude config directories found.</p>
      ) : null}

      {profiles !== null && claudeUsagePauseNotice(profiles) !== null ? (
        // One sentence for one fact: the endpoint paused reads. Six rows each
        // saying "rate limited" read as six broken accounts.
        <p data-testid="claude-usage-pause-notice" className="text-xs text-muted-foreground">
          {claudeUsagePauseNotice(profiles)}
        </p>
      ) : null}

      {notice ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0">{notice}</span>
          {cliMissing ? (
            // The whole point: the person in front of this is not going to run
            // an npm command. CH3 installs it — through the package manager
            // if this machine has one, through Anthropic's native installer if
            // it does not — and then says whether the CLI actually runs.
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-xs"
              disabled={installing}
              onClick={() => {
                setInstalling(true);
                // A native install downloads a binary. On a slow connection
                // that is minutes, and a button that says nothing for minutes
                // reads as a button that did nothing.
                setNotice("Installing Claude Code… this can take a few minutes.");
                void (async () => {
                  const result = await installCli({ environmentId, input: {} });
                  setInstalling(false);
                  if (result._tag === "Failure") {
                    const failure = squashAtomCommandFailure(result as never) as Partial<{
                      detail: string;
                      message: string;
                    }> | null;
                    setNotice(
                      `Could not install Claude Code: ${
                        failure?.detail?.trim() || failure?.message?.trim() || "no reason given"
                      }`,
                    );
                    return;
                  }
                  // The server reports what it can actually run, not whether a
                  // command exited zero. Saying "installed" when it is not is
                  // how someone ends up pressing Sign in forever.
                  const outcome = Option.getOrNull(AsyncResult.value(result));
                  if (outcome?.ok !== true) {
                    setNotice(outcome?.detail ?? "Could not install Claude Code.");
                    return;
                  }
                  setCliMissing(false);
                  setNotice("Claude Code installed. Press Sign in again.");
                })();
              }}
            >
              {installing ? "Installing…" : "Install Claude Code"}
            </Button>
          ) : null}
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
          expiring before its reset, and rest the current one. Never mid-reply. Scoring accounts
          reads your Claude credential from the login keychain, so macOS may ask for permission the
          first time.
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 shrink-0 accent-primary"
          checked={keepWarmEnabled}
          onChange={(event) => onKeepWarmEnabledChange(event.target.checked)}
        />
        <span className="min-w-0 leading-snug">
          Keep the other accounts warm: every 25 minutes, ask one signed-in account you are not
          using for a short riddle on Haiku 4.5, rotating through them. An unused account otherwise
          transacts nothing, so its 5-hour window never turns over and you only discover it needs
          signing in again when work is handed to it. Never touches the account you are on, and
          nothing appears in your conversations — the replies go to a local log.
        </span>
      </label>

      {/*
        Terminals CH3 opens already follow the selected account — their PATH
        is set at spawn. A shell CH3 did not open (a tmux session, an
        orchestration run started from Terminal) keeps the account it was born
        with, which is how a long run ends up on a signed-out or exhausted
        account while this panel shows a healthy one. One line fixes it for
        every shell on the machine, and CH3 shows it rather than writing to
        anyone's shell configuration itself.
      */}
      {shimPathLine !== null ? (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
          <p className="text-xs leading-snug text-muted-foreground">
            A terminal outside CH3 keeps whichever account it started with; an orchestration run
            relaunches its agents on the new one at their next call. Add this to{" "}
            <span className="text-foreground">~/.zshrc</span> so every shell runs{" "}
            <span className="text-foreground">claude</span> as the account selected here.
          </p>
          <div className="flex items-center gap-2">
            <code
              // Truncated because the popover is narrower than most home
              // paths, and the copy button is what people actually use — the
              // title keeps the whole line readable without widening the panel.
              title={shimPathLine}
              className="min-w-0 flex-1 truncate rounded-sm bg-muted/60 px-2 py-1 font-mono text-[11px] text-foreground"
            >
              {shimPathLine}
            </code>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs"
              title="Copy the shell line"
              onClick={() => copyShimPathLine(shimPathLine, undefined)}
            >
              <CopyIcon className="size-3" />
              {shimPathLineCopied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-border/60 pt-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={busy !== null}
          // No folder prompt: the next free `~/.claude-<n>` is computed from
          // the profile list as it stands now and used directly — the free-
          // slot logic already guarantees it never names an occupied folder,
          // so there is nothing for the user to decide.
          onClick={() => void addAccount(suggestClaudeAccountFolder(profiles))}
        >
          {/* The wait shows on the row being signed into when there is one;
              this button only carries it for a brand-new folder. */}
          {signingInNewFolder ? (
            <LoaderIcon className="size-3 animate-spin" />
          ) : (
            <PlusIcon className="size-3" />
          )}
          {signingInNewFolder ? "Signing in…" : "Add account…"}
        </Button>
        {signingIn ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            title="Stop waiting for this sign-in"
            onClick={cancelSignIn}
          >
            Cancel
          </Button>
        ) : null}
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
