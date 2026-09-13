import { describe, expect, it } from "vite-plus/test";

import { detectProseFilePaths } from "./proseFilePaths";

const pathsIn = (text: string) => detectProseFilePaths(text).map((match) => match.path);

describe("detectProseFilePaths", () => {
  it("finds a path whose directories contain spaces and an em dash", () => {
    // The reported message, verbatim. A forward scan cannot find the end of
    // this path; anchoring on the extension and scanning back can.
    const text =
      "Meanwhile, I started an orchestrator run to implement this one: " +
      "/Users/conradws/Desktop/CH3 Repos For Documentation/iOS Alt-Data Program — CCRs and Briefs/ORCH-20260904-3-behaviour-usage-trust.md" +
      " and I want you to review their understanding.";

    expect(pathsIn(text)).toEqual([
      "/Users/conradws/Desktop/CH3 Repos For Documentation/iOS Alt-Data Program — CCRs and Briefs/ORCH-20260904-3-behaviour-usage-trust.md",
    ]);
  });

  it("reports the range it matched, so the text around it survives", () => {
    const text = "open /tmp/notes.md now";
    const [match] = detectProseFilePaths(text);

    expect(match).toBeDefined();
    expect(text.slice(0, match?.start)).toBe("open ");
    expect(text.slice(match?.end)).toBe(" now");
  });

  it("keeps two paths in one sentence apart", () => {
    // The nearest opening slash wins. A first-slash-wins scan would return one
    // match spanning "or" and everything between them.
    expect(pathsIn("compare /tmp/a.md or /tmp/b.md")).toEqual(["/tmp/a.md", "/tmp/b.md"]);
  });

  it("takes a tilde path", () => {
    expect(pathsIn("see ~/Desktop/plan.md please")).toEqual(["~/Desktop/plan.md"]);
  });

  it("stops at the extension, not at the sentence punctuation", () => {
    expect(pathsIn("read /tmp/notes.md, then stop.")).toEqual(["/tmp/notes.md"]);
    expect(pathsIn("read /tmp/notes.md.")).toEqual(["/tmp/notes.md"]);
    expect(pathsIn("read (/tmp/notes.md)")).toEqual(["/tmp/notes.md"]);
  });

  it("leaves a URL alone", () => {
    // No special case for URLs: the opening slash has to follow whitespace,
    // and neither slash in "https://host/x.md" does.
    expect(pathsIn("see https://example.com/notes.md for detail")).toEqual([]);
    expect(pathsIn("see http://example.com/a/b/readme.md")).toEqual([]);
  });

  it("ignores an extension that is not a file extension", () => {
    expect(pathsIn("call /srv/thing.doSomething next")).toEqual([]);
    expect(pathsIn("we shipped /rel/v1.2 today")).toEqual([]);
  });

  it("ignores a directory that only looks like a file", () => {
    expect(pathsIn("under /var/app.config/settings and below")).toEqual([]);
  });

  it("needs an absolute path, not a bare filename", () => {
    expect(pathsIn("open notes.md")).toEqual([]);
    expect(pathsIn("open src/notes.md")).toEqual([]);
  });

  it("refuses to span a line break", () => {
    // The backward scan would otherwise reach across a paragraph and call the
    // whole thing a path.
    expect(pathsIn("open /tmp/here\nand then notes.md")).toEqual([]);
  });

  it("finds a path at the very start and the very end of the text", () => {
    expect(pathsIn("/tmp/a.md is the one")).toEqual(["/tmp/a.md"]);
    expect(pathsIn("the one is /tmp/a.md")).toEqual(["/tmp/a.md"]);
  });

  it("returns nothing for prose with no path in it", () => {
    expect(pathsIn("no paths here at all")).toEqual([]);
    expect(pathsIn("")).toEqual([]);
  });
});
