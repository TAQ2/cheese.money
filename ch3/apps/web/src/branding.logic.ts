const NIGHTLY_SERVER_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

/**
 * The sidebar everyone opens on: the inbox.
 *
 * It was a beta that nightly and dev opted into while Alpha and Latest stayed
 * on the project tree, which meant the first thing a new install showed was a
 * folder list rather than the work waiting. The inbox answers the question
 * somebody actually has on opening the app — what is still open — so it is the
 * default now, on every stage.
 *
 * The stage label is still taken so the call sites and their tests keep their
 * shape while this is a one-liner; it is deliberately unused rather than
 * removed, because the argument for a stage-varying default may come back and
 * the plumbing is worth more than the line it costs.
 */
export function resolveSidebarV2Default(_stageLabel: string): boolean {
  return true;
}

/**
 * Resolved sidebar v2 state: an explicit choice if the user has made one,
 * otherwise the default for this build stage.
 *
 * A stored `enabled: true` counts as an explicit choice even without the
 * companion flag. `true` was never the schema default, so it can only have come
 * from the Settings → Beta toggle — settings written before that flag existed
 * would otherwise lose the opt-in and drop such users back to v1 on production.
 * Mirrors how `normalizeDesktopSettingsDocument` treats a legacy stored
 * `updateChannel: "nightly"` as user-configured.
 *
 * `settingsHydrated` guards the startup window: client settings load
 * asynchronously and the pre-hydration snapshot is just the schema defaults, so
 * resolving against it would mount one sidebar and swap it out a tick later,
 * remounting the tree. While hydrating, hold the DEFAULT — which is where the
 * great majority of sessions end up, so the common path never swaps. Somebody
 * who has explicitly chosen the project tree pays one swap on load, which is
 * the cost the inbox used to pay.
 */
export function resolveSidebarV2Enabled(input: {
  readonly enabled: boolean;
  readonly configuredByUser: boolean;
  readonly settingsHydrated: boolean;
  readonly stageLabel: string;
}): boolean {
  if (!input.settingsHydrated) {
    return resolveSidebarV2Default(input.stageLabel);
  }

  return input.configuredByUser || input.enabled
    ? input.enabled
    : resolveSidebarV2Default(input.stageLabel);
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}
