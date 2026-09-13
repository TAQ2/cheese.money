import type {
  ServerProvider,
  ServerProviderUpdateState,
  ServerProviderVersionAdvisory,
} from "@ch3tools/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in CH3.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export interface ProviderVersionAdvisoryPresentation {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  /** True when the last attempt did not land, so the button offers a retry. */
  readonly retry: boolean;
}

/**
 * What the update badge says.
 *
 * An update that is still on offer *after* an attempt that did not land is the
 * shape a person reads as "this button does nothing": the server knows why —
 * a rate-limited updater, a global prefix it could not write — and until that
 * reason is shown here it may as well not exist. So the last attempt outranks
 * the advisory, and the button becomes a deliberate retry rather than the same
 * unexplained offer.
 */
export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  updateState?: ServerProviderUpdateState | undefined,
): ProviderVersionAdvisoryPresentation | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);
  const available = {
    title: label,
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    retry: false,
  };

  if (updateState?.status === "failed") {
    return {
      ...available,
      title: "Update failed",
      detail: updateState.message ?? "The update command did not finish.",
      emphasis: "strong",
      retry: true,
    };
  }
  if (updateState?.status === "unchanged") {
    return {
      ...available,
      title: "Update did not install",
      detail:
        updateState.message ??
        "The update command completed, but this provider is still on the old version.",
      emphasis: "strong",
      retry: true,
    };
  }
  return available;
}
