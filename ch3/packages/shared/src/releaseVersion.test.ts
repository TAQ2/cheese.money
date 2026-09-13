import { describe, expect, it } from "vite-plus/test";

import {
  displayVersion,
  formatReleaseVersion,
  nextReleaseAfter,
  nextReleaseVersion,
  parseReleaseVersion,
  releaseTagForVersion,
  releaseVersionToSemver,
} from "./releaseVersion.ts";

describe("releaseVersion", () => {
  it("reads both spellings and refuses what is not a release number", () => {
    expect(parseReleaseVersion("0.45")).toEqual({ major: 0, minor: 45 });
    expect(parseReleaseVersion("v0.45")).toEqual({ major: 0, minor: 45 });
    expect(parseReleaseVersion("0.45.0")).toEqual({ major: 0, minor: 45 });
    expect(parseReleaseVersion("1.00")).toEqual({ major: 1, minor: 0 });
    expect(parseReleaseVersion("1.0.0")).toEqual({ major: 1, minor: 0 });
    // The builds before this scheme, and anything with a real patch.
    expect(parseReleaseVersion("0.0.32-b44")).toBeNull();
    expect(parseReleaseVersion("v0.0.32-b44")).toBeNull();
    expect(parseReleaseVersion("0.45.1")).toBeNull();
    expect(parseReleaseVersion("0.100.0")).toBeNull();
    expect(parseReleaseVersion("nightly")).toBeNull();
  });

  it("shows two digits after the dot, always", () => {
    expect(formatReleaseVersion({ major: 0, minor: 45 })).toBe("0.45");
    expect(formatReleaseVersion({ major: 1, minor: 0 })).toBe("1.00");
    expect(formatReleaseVersion({ major: 1, minor: 7 })).toBe("1.07");
    expect(releaseTagForVersion({ major: 0, minor: 45 })).toBe("v0.45");
    expect(releaseVersionToSemver({ major: 1, minor: 7 })).toBe("1.7.0");
  });

  it("renders the app's own version, or leaves an unknown one alone", () => {
    expect(displayVersion("0.45.0")).toBe("0.45");
    expect(displayVersion("1.7.0")).toBe("1.07");
    expect(displayVersion("0.0.32-b44")).toBe("0.0.32-b44");
  });

  it("counts by one and rolls 0.99 over to 1.00", () => {
    expect(nextReleaseVersion({ major: 0, minor: 45 })).toEqual({ major: 0, minor: 46 });
    expect(nextReleaseVersion({ major: 0, minor: 99 })).toEqual({ major: 1, minor: 0 });
    expect(nextReleaseVersion({ major: 1, minor: 99 })).toEqual({ major: 2, minor: 0 });
  });

  it("takes the number after the newest published release, never below the floor", () => {
    const floor = { major: 0, minor: 45 };
    // Only legacy tags published: the floor is the first release.
    expect(nextReleaseAfter(["v0.0.32-b44", "v0.0.31-b40"], floor)).toEqual(floor);
    expect(nextReleaseAfter([], floor)).toEqual(floor);
    // Published out of order, mixed with legacy: the newest wins.
    expect(nextReleaseAfter(["v0.46", "v0.0.32-b44", "v0.47", "v0.45"], floor)).toEqual({
      major: 0,
      minor: 48,
    });
    // A floor raised past what is published jumps straight to it.
    expect(nextReleaseAfter(["v0.46"], { major: 0, minor: 60 })).toEqual({ major: 0, minor: 60 });
    // Rollover through the newest.
    expect(nextReleaseAfter(["v0.99"], floor)).toEqual({ major: 1, minor: 0 });
  });
});
