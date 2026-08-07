import { describe, expect, it } from "vite-plus/test";

import {
  detectInlineCodeFileProbe,
  detectInlineCodeUrl,
  resolveInlineCodeProbeEntry,
} from "./inlineCodeTarget";

describe("detectInlineCodeUrl", () => {
  it("accepts http and https", () => {
    expect(detectInlineCodeUrl("https://example.com/a/b?c=1#d")).toEqual({
      kind: "url",
      href: "https://example.com/a/b?c=1#d",
    });
    expect(detectInlineCodeUrl("http://localhost:3000/health")?.kind).toBe("url");
  });

  it("keeps every character the span holds, brackets included", () => {
    // A backtick span has no surrounding sentence to have leaked
    // punctuation into it, and these are real parts of the address.
    expect(detectInlineCodeUrl("https://en.wikipedia.org/wiki/Foo_(bar)")?.href).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(detectInlineCodeUrl("https://example.com/docs.")?.href).toBe(
      "https://example.com/docs.",
    );
  });

  it("refuses everything that is not a web link", () => {
    for (const text of [
      "example.com",
      "file:///Users/me/notes.md",
      "mailto:someone@example.com",
      "data:text/plain,hello",
      "https://",
      "https://example.com with words",
      'SCORE_BUCKETS["idx2".."idx5"]',
      "",
    ]) {
      expect(detectInlineCodeUrl(text)).toBeNull();
    }
  });
});

describe("detectInlineCodeFileProbe", () => {
  it("probes a bare filename whose extension names a real kind of file", () => {
    expect(detectInlineCodeFileProbe("policy_definitions.py")).toEqual({
      path: "policy_definitions.py",
      fileName: "policy_definitions.py",
      hasDirectory: false,
    });
  });

  it("probes a path whose directories contain spaces", () => {
    // The case this exists for: the path resolver refuses anything with
    // whitespace, so a real directory named in prose never linked.
    expect(
      detectInlineCodeFileProbe(
        "LLM coding agent documents/change-requests/2026-08-04-idx2-5-lowrisk-25pct-reduction.md",
      ),
    ).toEqual({
      path: "LLM coding agent documents/change-requests/2026-08-04-idx2-5-lowrisk-25pct-reduction.md",
      fileName: "2026-08-04-idx2-5-lowrisk-25pct-reduction.md",
      hasDirectory: true,
    });
  });

  it("carries a line and column when the span states one", () => {
    expect(detectInlineCodeFileProbe("schema.sql:42")).toEqual({
      path: "schema.sql",
      fileName: "schema.sql",
      hasDirectory: false,
      line: 42,
    });
    expect(detectInlineCodeFileProbe("src/main.rs:12:5")).toEqual({
      path: "src/main.rs",
      fileName: "main.rs",
      hasDirectory: true,
      line: 12,
      column: 5,
    });
  });

  it("refuses identifiers, expressions, flags and prose", () => {
    for (const text of [
      // Property access and class names read exactly like filenames.
      "array.map",
      "React.Fragment",
      "DPDFloorProtectionPolicy",
      'SCORE_BUCKETS["idx2".."idx5"]',
      "[2:]",
      "e.g",
      "v1.2",
      ".gitignore",
      "trailing.",
      "--config=app.json",
      "cat app.json | jq .name",
      // A command whose last word ends in an extension: the "filename"
      // would be the whole command, and searching for it is guaranteed
      // to find nothing.
      "python manage.py",
      "kubectl apply -f deploy.yaml",
      "rm -rf notes.md",
      "the whole point of this sentence is that it merely ends in notes.md",
      "",
    ]) {
      expect(detectInlineCodeFileProbe(text)).toBeNull();
    }
  });
});

describe("resolveInlineCodeProbeEntry", () => {
  const entries = [
    { path: "src/policy_definitions.py", kind: "file" as const },
    { path: "docs/index.ts", kind: "file" as const },
    { path: "web/index.ts", kind: "file" as const },
    { path: "LLM coding agent documents/change-requests/notes.md", kind: "file" as const },
    { path: "src/policy_definitions", kind: "directory" as const },
  ];
  const probe = (text: string) => {
    const detected = detectInlineCodeFileProbe(text);
    if (!detected) throw new Error(`expected a probe for ${text}`);
    return detected;
  };

  it("resolves a bare filename that exists exactly once", () => {
    expect(resolveInlineCodeProbeEntry(probe("policy_definitions.py"), entries)).toBe(
      "src/policy_definitions.py",
    );
  });

  it("resolves a spaced path by matching the end of a real entry", () => {
    expect(resolveInlineCodeProbeEntry(probe("change-requests/notes.md"), entries)).toBe(
      "LLM coding agent documents/change-requests/notes.md",
    );
  });

  it("refuses a filename that more than one file answers to", () => {
    expect(resolveInlineCodeProbeEntry(probe("index.ts"), entries)).toBeNull();
  });

  it("refuses a path whose directories the project does not have", () => {
    // The basename exists, but the span said it was somewhere it is not.
    expect(resolveInlineCodeProbeEntry(probe("api/policy_definitions.py"), entries)).toBeNull();
  });

  it("refuses a filename nothing answers to, and never matches a directory", () => {
    expect(resolveInlineCodeProbeEntry(probe("missing.py"), entries)).toBeNull();
  });
});
