import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "./pairingUrl";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly";

/**
 * The hosted origin this bundle was built for, or null when none was
 * configured. Null is the shipped state: there is no default, because a
 * default naming an unregistered domain hands the pairing endpoint to whoever
 * registers it. Callers must handle null rather than fall back.
 */
export function configuredHostedAppUrl(): string | null {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || null;
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isHostedStaticApp(url: URL = new URL(window.location.href)): boolean {
  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  const hostedUrl = configuredHostedAppUrl();
  if (hostedUrl === null) return false;
  const hostedOrigin = originFromUrl(hostedUrl);
  return hostedOrigin !== null && url.origin === hostedOrigin;
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string | null {
  const hostedUrl = configuredHostedAppUrl();
  // No hosted origin configured: there is no link to build. Returning null
  // makes the caller show that, rather than a link to a domain nobody owns.
  if (hostedUrl === null) return null;
  const url = new URL("/pair", hostedUrl);
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string | null {
  const hostedUrl = configuredHostedAppUrl();
  if (hostedUrl === null) return null;
  const url = new URL("/__ch3/channel", hostedUrl);
  url.searchParams.set("channel", input.channel);
  return url.toString();
}
