import type { EnvironmentId, VcsRef, ProjectId } from "@ch3tools/contracts";
import * as Schema from "effect/Schema";
import { toSortableTimestamp } from "../lib/threadSort";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@ch3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
  isPrimary: boolean;
}

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? "This device";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

// A remote (non-primary) environment is always surfaced, even when it is the
// only environment available: with a single connected machine there is nothing
// to pick, but the user still needs to see where the project runs.
export function shouldShowEnvironmentIndicator(input: {
  activeEnvironment: Pick<EnvironmentOption, "isPrimary"> | null;
  canPickEnvironment: boolean;
}): boolean {
  if (input.canPickEnvironment) return true;
  return input.activeEnvironment !== null && !input.activeEnvironment.isPrimary;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Worktree" : "Local checkout";
}

/**
 * State the composer's output-style chip renders from.
 *
 * `pickedStyle` is what this thread chose; `activeStyle` is what the driver
 * resolves on its own from the user's settings files. Keeping them apart is
 * what stops the chip from claiming a style nobody selected.
 */
export interface OutputStyleChipState {
  readonly styles: ReadonlyArray<string>;
  readonly selectedStyle: string | null;
  readonly label: string;
}

/**
 * Response styles kept out of the picker.
 *
 * The CLI compiles its built-in styles into the binary and offers no setting
 * to hide them, so filtering happens here. Only the ones the user does not
 * want in the menu belong on this list — `default` stays, because it is the
 * style the CLI falls back to and the one the chip reports when nothing has
 * been picked.
 *
 * Custom styles never need to be listed here: deleting the `.md` file in
 * `~/.claude/output-styles` removes them at the source. Edit this array to
 * change what the menu shows; matching is case-insensitive.
 */
export const HIDDEN_OUTPUT_STYLES: ReadonlyArray<string> = ["Proactive", "Explanatory", "Learning"];

function isHiddenOutputStyle(style: string): boolean {
  return HIDDEN_OUTPUT_STYLES.some(
    (hidden) => hidden.localeCompare(style, undefined, { sensitivity: "base" }) === 0,
  );
}

/**
 * The CLI's own no-style style. Its name is part of the wire format — it is
 * what the `outputStyle` setting must say — so it is never renamed at the
 * source, only where it is displayed.
 */
export const DEFAULT_OUTPUT_STYLE = "default";

export function isDefaultOutputStyle(style: string): boolean {
  return style.localeCompare(DEFAULT_OUTPUT_STYLE, undefined, { sensitivity: "base" }) === 0;
}

/**
 * What the menu calls a style. "default" reads as a setting rather than a
 * choice, and what it actually means here is "no style" — nothing layered on
 * top of the model's own voice.
 */
export function formatOutputStyleLabel(style: string): string {
  return isDefaultOutputStyle(style) ? "None" : style;
}

/**
 * Resolve what the chip shows, or `null` when it should not render at all.
 *
 * Hidden when the driver reported no styles — every non-Claude driver, and
 * Claude itself before the capabilities probe has answered. Showing an empty
 * picker there would be worse than showing nothing.
 *
 * A picked style that the driver no longer reports (a custom style file that
 * was renamed or deleted) still labels the chip and joins the list, so the
 * thread's own setting stays visible and selectable rather than silently
 * reading as some other style.
 */
export function resolveOutputStyleChipState(input: {
  availableStyles: ReadonlyArray<string> | undefined;
  activeStyle: string | undefined;
  pickedStyle: string | null | undefined;
}): OutputStyleChipState | null {
  const availableStyles = input.availableStyles ?? [];
  if (availableStyles.length === 0) {
    return null;
  }

  const pickedStyle = input.pickedStyle?.trim() ? input.pickedStyle.trim() : null;

  // With nothing picked the chip mirrors the driver's own resolved style, so
  // the label is true before the first pick. The last resort is the driver's
  // FIRST REPORTED style — the CLI lists its own default first — which is why
  // this reads the raw list rather than the display order built below.
  const selectedStyle = pickedStyle ?? input.activeStyle?.trim() ?? availableStyles[0] ?? null;

  const styles = (
    pickedStyle && !availableStyles.includes(pickedStyle)
      ? [...availableStyles, pickedStyle]
      : [...availableStyles]
  )
    // A hidden style that is nonetheless in force stays listed: the menu has
    // to be able to show what the thread is actually running under, and a
    // Select whose value matches no item renders as empty.
    .filter((style) => style === selectedStyle || !isHiddenOutputStyle(style))
    .toSorted((left, right) => {
      // "None" is pinned to the top rather than sorted into the N's: it is the
      // way out of every other style, so it belongs where the eye lands first.
      if (isDefaultOutputStyle(left) !== isDefaultOutputStyle(right)) {
        return isDefaultOutputStyle(left) ? -1 : 1;
      }
      // Everything else alphabetical, case-insensitive: the driver reports its
      // built-ins first and then whatever order the style files come back in,
      // which makes a list of a dozen styles something you read rather than
      // scan.
      return left.localeCompare(right, undefined, { sensitivity: "base" });
    });

  return {
    styles,
    selectedStyle,
    label: selectedStyle === null ? "Style" : formatOutputStyleLabel(selectedStyle),
  };
}

export interface PreviousWorktreeSeed {
  branch: string | null;
  worktreePath: string;
}

// The most recently touched worktree in the project that the composer isn't
// already pointing at. Backs the "Previous worktree" entry in the workspace
// selector so a follow-up thread can hop back into the worktree you just
// worked in without hunting for its branch. Archived threads don't compete —
// the rest of the UI hides them, so their worktrees shouldn't resurface here.
export function resolvePreviousWorktreeSeed(input: {
  threads: ReadonlyArray<{
    branch: string | null;
    worktreePath: string | null;
    updatedAt: string;
    archivedAt?: string | null;
  }>;
  currentWorktreePath: string | null;
}): PreviousWorktreeSeed | null {
  let latest: { branch: string | null; worktreePath: string; updatedAt: number } | null = null;
  for (const thread of input.threads) {
    if (
      !thread.worktreePath ||
      thread.worktreePath === input.currentWorktreePath ||
      (thread.archivedAt ?? null) !== null
    ) {
      continue;
    }
    const updatedAt = toSortableTimestamp(thread.updatedAt);
    if (updatedAt === null) {
      continue;
    }
    if (latest === null || updatedAt > latest.updatedAt) {
      latest = {
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        updatedAt,
      };
    }
  }
  return latest === null ? null : { branch: latest.branch, worktreePath: latest.worktreePath };
}

export function resolvePreviousWorktreeLabel(seed: PreviousWorktreeSeed): string {
  return seed.branch ? `Previous worktree (${seed.branch})` : "Previous worktree";
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function resolveBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  resolvedActiveBranchIsRemote: boolean | null;
  startFromOrigin: boolean;
}): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    resolvedActiveBranchIsRemote,
    startFromOrigin,
  } = input;
  if (!resolvedActiveBranch) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    const baseRef =
      startFromOrigin && resolvedActiveBranchIsRemote === false
        ? `origin/${resolvedActiveBranch}`
        : resolvedActiveBranch;
    return `From ${baseRef}`;
  }
  return resolvedActiveBranch;
}

export function resolveBranchToolbarPrBranch(input: {
  activeThreadBranch: string | null;
  resolvedActiveBranch: string | null;
}): string | null {
  return input.activeThreadBranch === input.resolvedActiveBranch ? input.activeThreadBranch : null;
}

export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, refName } = input;

  if (refName.worktreePath) {
    return {
      checkoutCwd: refName.worktreePath,
      nextWorktreePath: refName.worktreePath === activeProjectCwd ? null : refName.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && refName.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  return itemValue.toLowerCase().includes(normalizedQuery);
}

/**
 * The instruction sent when redoing the newest reply under a different
 * response style.
 *
 * The style's own rules are deliberately NOT restated here. The style is
 * pushed into the running session before this prompt is queued, so the model
 * already has it loaded; pasting the file's content would duplicate it and
 * drift from it the moment the file changes.
 *
 * The hard part is not activating the new style — that already works — it is
 * stopping the OLD one from bleeding through. The previous reply sits in the
 * transcript as the model's own most recent output, written under the style
 * being replaced, and a model imitates its own visible turns. Left unsaid,
 * the rewrite comes back as a blend. So the prompt strips the previous reply
 * of any authority over form, and says plainly which side wins on conflict.
 *
 * It does NOT forbid tool use. Some styles REQUIRE work before answering —
 * one demands every claim carry evidence of what was actually run or read,
 * another opens on a freshly verified state. A blanket "do not run anything"
 * would force the model to fake that verification or refuse the style.
 */
export function buildRestylePrompt(outputStyle: string): string {
  const styleName = isDefaultOutputStyle(outputStyle)
    ? "default response style (no style)"
    : `${outputStyle} response style`;
  return [
    `Rewrite your previous response in the ${styleName}.`,
    "",
    "The response style your previous reply was written in is no longer in force. Discard it completely. Its structure, sections, headings, markers, voice, vocabulary and length conventions carry no authority here and must not survive into the rewrite. Do not blend the two styles, and do not preserve a single formatting habit from the old one merely because it is already on screen.",
    "",
    `Follow the ${styleName} exactly and in full, including every format, marker, section and rule it mandates. Where it disagrees with how you just wrote, it wins without exception. Be faithful to it as written, not to an approximation of it.`,
    "",
    "Same content — only the form changes. If that style instructs you to carry out a specific class of action or process in the build-up to your answer, go ahead and do it. Treat this as a redo and a re-adaptation of what you just said, adapted to this new response style.",
  ].join("\n");
}
