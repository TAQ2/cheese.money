import type { EnvironmentId, VcsRef, ProjectId } from "@ch3tools/contracts";
import { DEFAULT_OUTPUT_STYLE_PREFERENCE } from "@ch3tools/contracts/settings";
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

/**
 * The response style CH3 ships as the starting point for every
 * conversation, absent a user preference. Matched against the CLI's
 * advertised names verbatim, so it must equal the `name:` in
 * `assets/output-styles/caveman.md`. Source of truth is
 * `DEFAULT_OUTPUT_STYLE_PREFERENCE` in `@ch3tools/contracts/settings` — that is
 * also the schema default for the `defaultOutputStyle` client setting, so an
 * install that has never touched the preference and one that has explicitly
 * set it back to Caveman are indistinguishable.
 *
 * Only applied when the CLI actually advertises it — the file lives in the
 * user's home and can be deleted, and naming a style the CLI does not know is
 * a broken session rather than a missing preference.
 */
export const PREFERRED_OUTPUT_STYLE = DEFAULT_OUTPUT_STYLE_PREFERENCE;

/**
 * The styles CH3 pins to the top of the menu, in this order.
 *
 * Caveman leads this group because it is what every conversation starts on,
 * and a default that sorts into the C's looks like one option among a dozen
 * rather than the one in force. "I'm Tired" sits directly under it as the
 * deliberate way out on a bad day. Everything else — the CLI's own styles and
 * whatever the user has written — sorts alphabetically below.
 *
 * "None" is not in this list and outranks all of it: see the sort in
 * {@link deriveOutputStyleMenu}. Pinning here is about the recommended styles,
 * not about the top of the menu.
 *
 * Names must match the `name:` frontmatter in `assets/output-styles/`, since
 * that is the string the CLI advertises and the `outputStyle` setting matches.
 */
export const PINNED_OUTPUT_STYLES: ReadonlyArray<string> = [PREFERRED_OUTPUT_STYLE, "I'm Tired"];

function pinnedOutputStyleRank(style: string): number {
  const index = PINNED_OUTPUT_STYLES.findIndex(
    (pinned) => pinned.localeCompare(style, undefined, { sensitivity: "base" }) === 0,
  );
  return index === -1 ? PINNED_OUTPUT_STYLES.length : index;
}

/**
 * The style a conversation starts on when nobody has picked one.
 *
 * `preferredStyle` defaults to the shipped `PREFERRED_OUTPUT_STYLE` (Caveman)
 * but is a parameter so it can carry the user's own `defaultOutputStyle`
 * setting instead — including `DEFAULT_OUTPUT_STYLE` ("default"), which is
 * how "None for every new conversation" is expressed.
 *
 * Exported so the composer can put it in the options it dispatches, not only
 * in the chip's label: a chip that says Caveman while the run uses something
 * else would be a lie, and the label is the cheaper half to get right.
 */
export function resolveInitialOutputStyle(
  availableStyles: ReadonlyArray<string> | undefined,
  preferredStyle: string = PREFERRED_OUTPUT_STYLE,
): string | null {
  return (availableStyles ?? []).includes(preferredStyle) ? preferredStyle : null;
}

/**
 * The style to write into a conversation that has not picked one, or `null`
 * when there is nothing to write.
 *
 * Exists because the two readings of "nobody picked one" disagreed and the
 * disagreement was invisible: `getOutputStyleSelection` answers `undefined`,
 * the chip normalises that to `null`, and a seeding guard written against
 * `null` therefore matched every render and never fired. The label went on
 * showing Caveman — it falls back to the same default it had failed to write —
 * while the turn ran under whatever the CLI resolved on its own. One function,
 * so the label and the written selection cannot drift apart again.
 */
export function resolveOutputStyleToSeed(input: {
  pickedStyle: string | null | undefined;
  availableStyles: ReadonlyArray<string> | undefined;
  preferredStyle?: string;
}): string | null {
  if (input.pickedStyle?.trim()) return null;
  return resolveInitialOutputStyle(input.availableStyles, input.preferredStyle);
}

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
/**
 * The full menu of styles Settings offers for "what a fresh conversation
 * starts on" — every style the driver reports, minus {@link HIDDEN_OUTPUT_STYLES},
 * Caveman pinned first always, everything else alphabetical.
 *
 * Unlike {@link resolveOutputStyleChipState} this never returns empty:
 * Settings has no thread to hide behind, so before the capabilities probe has
 * answered (or on a machine with no Claude driver) it falls back to the two
 * styles CH3 ships — Caveman and None — the same pair this picker offered
 * before it read the live list.
 */
export function resolveDefaultOutputStyleOptions(
  availableStyles: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const styles = (availableStyles ?? []).filter((style) => !isHiddenOutputStyle(style));
  if (styles.length === 0) {
    return [PREFERRED_OUTPUT_STYLE, DEFAULT_OUTPUT_STYLE];
  }
  const withCaveman = styles.includes(PREFERRED_OUTPUT_STYLE)
    ? styles
    : [PREFERRED_OUTPUT_STYLE, ...styles];
  return withCaveman.toSorted((left, right) => {
    const leftIsCaveman = pinnedOutputStyleRank(left) === 0;
    const rightIsCaveman = pinnedOutputStyleRank(right) === 0;
    if (leftIsCaveman !== rightIsCaveman) return leftIsCaveman ? -1 : 1;
    return left.localeCompare(right, undefined, { sensitivity: "base" });
  });
}

export function resolveOutputStyleChipState(input: {
  availableStyles: ReadonlyArray<string> | undefined;
  activeStyle: string | undefined;
  pickedStyle: string | null | undefined;
  preferredStyle?: string;
}): OutputStyleChipState | null {
  const availableStyles = input.availableStyles ?? [];
  if (availableStyles.length === 0) {
    return null;
  }

  const pickedStyle = input.pickedStyle?.trim() ? input.pickedStyle.trim() : null;

  // Nothing picked yet: start on the style CH3 ships for that purpose (or
  // the user's own `defaultOutputStyle` setting), and fall back to the
  // driver's own resolved style only where it is absent. The last resort is
  // the driver's FIRST REPORTED style — the CLI lists its own default first —
  // which is why this reads the raw list rather than the display order built
  // below.
  const selectedStyle =
    pickedStyle ??
    resolveInitialOutputStyle(availableStyles, input.preferredStyle) ??
    input.activeStyle?.trim() ??
    availableStyles[0] ??
    null;

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
      // "None" leads, always. It is the way out of every other style, and the
      // way out belongs in the one position you can hit without reading the
      // list. It sat third for a while, under the two CH3 recommends; that
      // put the escape somewhere you had to look for it, which is the wrong
      // trade for a menu whose other entries are all opinions.
      //
      // This is ORDER ONLY. Nothing here decides what a conversation starts
      // on — `PREFERRED_OUTPUT_STYLE` still does, and it is still Caveman.
      if (isDefaultOutputStyle(left) !== isDefaultOutputStyle(right)) {
        return isDefaultOutputStyle(left) ? -1 : 1;
      }
      // Then CH3's own styles, in the order `PINNED_OUTPUT_STYLES` gives:
      // the style every conversation starts on should be read before whatever
      // the CLI happens to ship.
      const leftRank = pinnedOutputStyleRank(left);
      const rightRank = pinnedOutputStyleRank(right);
      if (leftRank !== rightRank) return leftRank - rightRank;
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
