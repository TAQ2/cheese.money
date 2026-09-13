/**
 * CH3's release number: two parts, shown as `0.45`, counting up by one.
 *
 * The number people see is `<major>.<minor>` with the minor always two digits:
 * `0.45`, `0.46`, … `0.99`, then `1.00`, `1.01`. Nothing else — no patch, no
 * build suffix. The packager and the in-app updater, however, only understand
 * three-part semver, so the app itself carries `0.45.0`, `0.46.0`, `1.0.0`,
 * `1.1.0`, and this module is the one place that converts between the two.
 * Both orderings agree, which is what lets the updater compare them.
 *
 * Every build of `main` is a release, and each one takes the next number after
 * the newest already published, so nobody bumps anything by hand. The version
 * in `apps/desktop/package.json` is only a floor: the first number the scheme
 * may use, and what a local build calls itself.
 *
 * @module releaseVersion
 */

export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
}

const TWO_PART = /^v?(\d+)\.(\d{1,2})$/u;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/u;

/**
 * Reads a release number from either spelling — `0.45`, `v0.45`, `0.45.0` —
 * and refuses anything else: the old `0.0.32-b44` builds, a patch that is not
 * zero, a minor over 99. Those are not release numbers under this scheme, and
 * a caller that treats them as one would count from the wrong place.
 */
export function parseReleaseVersion(value: string): ReleaseVersion | null {
  const trimmed = value.trim();
  const two = TWO_PART.exec(trimmed);
  if (two !== null) {
    return { major: Number(two[1]), minor: Number(two[2]) };
  }
  const three = SEMVER.exec(trimmed);
  if (three === null || three[3] !== "0") return null;
  const minor = Number(three[2]);
  if (minor > 99) return null;
  return { major: Number(three[1]), minor };
}

/** `0.45`, `1.00`, `1.07` — the number as people read it. */
export function formatReleaseVersion(version: ReleaseVersion): string {
  return `${version.major}.${String(version.minor).padStart(2, "0")}`;
}

/** `0.45.0`, `1.0.0` — the number as the packager and updater need it. */
export function releaseVersionToSemver(version: ReleaseVersion): string {
  return `${version.major}.${version.minor}.0`;
}

/** The tag a release is published under: `v0.45`. */
export function releaseTagForVersion(version: ReleaseVersion): string {
  return `v${formatReleaseVersion(version)}`;
}

/**
 * What the app should call itself on screen, given whatever version string it
 * was built with. A release number renders as `0.45`; anything the scheme does
 * not cover — a legacy `0.0.32-b44`, a dev placeholder — is shown verbatim,
 * because a made-up number would be worse than an old one.
 */
export function displayVersion(appVersion: string): string {
  const parsed = parseReleaseVersion(appVersion);
  return parsed === null ? appVersion : formatReleaseVersion(parsed);
}

/** `0.45` → `0.46`; `0.99` → `1.00`. */
export function nextReleaseVersion(version: ReleaseVersion): ReleaseVersion {
  return version.minor >= 99
    ? { major: version.major + 1, minor: 0 }
    : { major: version.major, minor: version.minor + 1 };
}

export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

/**
 * The number the next release takes: one past the newest already published,
 * but never below the floor. With nothing published under this scheme yet
 * (only legacy tags, or none), the floor itself is the first release.
 */
export function nextReleaseAfter(
  publishedTags: ReadonlyArray<string>,
  floor: ReleaseVersion,
): ReleaseVersion {
  let newest: ReleaseVersion | null = null;
  for (const tag of publishedTags) {
    const parsed = parseReleaseVersion(tag);
    if (parsed === null) continue;
    if (newest === null || compareReleaseVersions(parsed, newest) > 0) newest = parsed;
  }
  if (newest === null) return floor;
  const next = nextReleaseVersion(newest);
  return compareReleaseVersions(next, floor) >= 0 ? next : floor;
}
