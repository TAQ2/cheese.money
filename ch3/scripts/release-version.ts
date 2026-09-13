/**
 * The release number, for the build workflow.
 *
 *   node scripts/release-version.ts next <floor-semver> [published-tag ...]
 *     prints the semver the next release carries, e.g. `0.46.0`
 *   node scripts/release-version.ts display <semver>
 *     prints how that version is shown, e.g. `0.46`
 *   node scripts/release-version.ts tag <semver>
 *     prints the release tag, e.g. `v0.46`
 *
 * All of the arithmetic lives in @ch3tools/shared/releaseVersion, which the app
 * uses for its About panel, so the number CI mints and the number the app
 * shows cannot drift apart.
 */
import {
  displayVersion,
  nextReleaseAfter,
  parseReleaseVersion,
  releaseTagForVersion,
  releaseVersionToSemver,
} from "@ch3tools/shared/releaseVersion";

const [command, first, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`release-version: ${message}\n`);
  process.exit(2);
}

switch (command) {
  case "next": {
    const floor = first === undefined ? null : parseReleaseVersion(first);
    if (floor === null) fail(`the floor must be a release number like 0.45.0, got ${first}`);
    process.stdout.write(`${releaseVersionToSemver(nextReleaseAfter(rest, floor))}\n`);
    break;
  }
  case "display": {
    if (first === undefined) fail("display needs a version");
    process.stdout.write(`${displayVersion(first)}\n`);
    break;
  }
  case "tag": {
    const parsed = first === undefined ? null : parseReleaseVersion(first);
    if (parsed === null) fail(`tag needs a release number like 0.45.0, got ${first}`);
    process.stdout.write(`${releaseTagForVersion(parsed)}\n`);
    break;
  }
  default:
    fail("usage: next <floor> [tag ...] | display <version> | tag <version>");
}
