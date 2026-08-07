import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@ch3tools/contracts";

const CLAUDE_DRIVER = "claudeAgent" as ProviderDriverKind;

/**
 * The settings map as this module reads it. Keys are plain strings: the
 * settings type brands them, but branding here makes every object-literal
 * fixture unusable for no safety gain, so the one cast lives at the boundary.
 */
export type ClaudeInstanceMap = Readonly<Record<string, ProviderInstanceConfig | undefined>>;

const readHomePath = (config: unknown): string | undefined => {
  if (config === null || typeof config !== "object") return undefined;
  const value = (config as { homePath?: unknown }).homePath;
  return typeof value === "string" ? value : undefined;
};

/**
 * The Claude config directory a Claude-facing feature should use.
 *
 * Reads the provider INSTANCE's config blob, which is where the account
 * switcher writes `homePath` and where `ClaudeDriver.create` reads it from.
 * The legacy `providers.claudeAgent` block is only a fallback: on this
 * machine it is an empty object, so anything reading it alone silently gets
 * the default account no matter which one is selected — the status line did
 * exactly that and kept reporting the personal account's plan usage after a
 * switch.
 *
 * Prefers the driver's default instance id, then any other Claude instance in
 * declaration order, so a single-instance setup (the normal case) is exact.
 */
/**
 * Claude instance ids, most-preferred first: the driver's default id, then the
 * rest in declaration order, disabled ones last.
 *
 * Everything that needs "the Claude instance" must agree on which one it is.
 * Reading the home path from one instance and writing the switch to another
 * silently evaluates one account's limits and repoints a different instance.
 */
/** The default Claude slot's id — the instance the reactors act on when none exists yet. */
export function defaultClaudeInstanceId(): string {
  return defaultInstanceIdForDriver(CLAUDE_DRIVER) as string;
}

export function orderedClaudeInstanceIds(
  providerInstances: ClaudeInstanceMap | undefined,
): ReadonlyArray<string> {
  const instances = providerInstances ?? {};
  const defaultId = defaultInstanceIdForDriver(CLAUDE_DRIVER) as string;
  const claudeIds = Object.keys(instances).filter((id) => instances[id]?.driver === CLAUDE_DRIVER);
  const enabledFirst = [
    ...claudeIds.filter((id) => instances[id]?.enabled !== false),
    ...claudeIds.filter((id) => instances[id]?.enabled === false),
  ];
  return enabledFirst.includes(defaultId)
    ? [defaultId, ...enabledFirst.filter((id) => id !== defaultId)]
    : enabledFirst;
}

export function resolveClaudeInstanceHomePath(input: {
  readonly providerInstances?: ClaudeInstanceMap | undefined;
  readonly legacyHomePath?: string | undefined;
}): string {
  const instances = input.providerInstances ?? {};
  const ordered = orderedClaudeInstanceIds(instances);

  for (const id of ordered) {
    const homePath = readHomePath(instances[id]?.config);
    if (homePath !== undefined && homePath.trim().length > 0) return homePath;
  }
  // An instance that exists but stores no homePath means the default home,
  // and must NOT fall through to the legacy block.
  if (ordered.length > 0) return "";
  return input.legacyHomePath ?? "";
}
