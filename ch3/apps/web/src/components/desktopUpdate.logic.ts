import type { DesktopUpdateActionResult, DesktopUpdateState } from "@ch3tools/contracts";
import { displayVersion } from "@ch3tools/shared/releaseVersion";
import { isWindowsPlatform } from "../lib/utils";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but CH3 is still running the Intel build under Rosetta. Install the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but CH3 is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but CH3 is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

/**
 * Versions on screen are the two-part release number (`0.46`), never the
 * three-part semver the updater carries (`0.46.0`). Null stays null so the
 * callers' own fallbacks ("available", "ready") still apply.
 */
const shown = (version: string | null | undefined): string | null =>
  version === null || version === undefined ? null : displayVersion(version);

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `Update ${shown(state.availableVersion) ?? "available"} ready to install`;
  }
  if (state.status === "downloading") {
    // The installer narrates its log into `message` — "Downloading…",
    // "Quitting CH3…" — and the updater shows it here as it happens.
    return state.message ?? DESKTOP_UPDATE_IN_PROGRESS_MESSAGE;
  }
  if (state.status === "downloaded") {
    return `Update ${shown(state.downloadedVersion) ?? shown(state.availableVersion) ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Update to ${shown(state.availableVersion)} failed${state.message ? `: ${state.message}` : ""}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

/** Shown while install.sh runs, until its own log says something more specific. */
export const DESKTOP_UPDATE_IN_PROGRESS_MESSAGE =
  "Updating — CH3 closes and reopens by itself. Leave it; there is nothing to click.";

/**
 * What the person agrees to before the update runs. The update is
 * install.sh: it downloads the release, QUITS CH3, swaps the app and
 * reopens it. A person who did not know the quit was coming reopened the
 * app by hand in the middle of it; this says so up front, in the order it
 * happens.
 */
export function getDesktopUpdateDownloadConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "currentVersion">,
): string {
  const version = shown(state.availableVersion) ?? "the new version";
  return `Update CH3 ${shown(state.currentVersion) ?? state.currentVersion} → ${version}?\n\nCH3 will download the release, close, and reopen by itself on ${version} — usually within a minute. Leave it closed while that happens; do not open it yourself.\n\nAny running tasks will be interrupted.`;
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  platform = "",
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const windowsInstallWarning = isWindowsPlatform(platform)
    ? "\n\nOn Windows, CH3 may remain closed for several minutes while the update installs, and no installer window may appear. CH3 will reopen automatically when installation finishes."
    : "";
  return `Install update${version ? ` ${version}` : ""} and restart CH3?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.${windowsInstallWarning}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}
