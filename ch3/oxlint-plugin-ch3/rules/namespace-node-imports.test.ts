import { assert, describe, it } from "@effect/vitest";

import type { TestNode } from "../test/inProcessRule.ts";
import {
  defaultSpecifier,
  identifier,
  importDeclaration,
  literal,
  namedSpecifier,
  namespaceSpecifier,
  program,
  runRule,
  runRuleMessages,
} from "../test/inProcessRule.ts";
import { createOxlintRuleHarness } from "../test/utils.ts";
import namespaceNodeImports from "./namespace-node-imports.ts";

const rule = createOxlintRuleHarness("ch3/namespace-node-imports");

describe("ch3/namespace-node-imports", () => {
  rule.valid(
    "allows canonical Node namespaces",
    `
      import * as NodeFS from "node:fs";
      import * as NodeFSP from "node:fs/promises";
      import * as NodeAssert from "node:assert/strict";
      import * as NodeChildProcess from "node:child_process";
      import * as NodeTimersPromises from "node:timers/promises";
      import type * as NodeStream from "node:stream";

      NodeAssert.ok(NodeChildProcess.spawn && NodeTimersPromises.setTimeout);
      export const read = NodeFS.readFileSync;
      export const readAsync = NodeFSP.readFile;
      export type Input = NodeStream.Readable;
    `,
  );

  rule.valid(
    "does not apply to non-Node packages",
    `
      import { BrowserWindow } from "electron";
    `,
  );

  rule.invalid(
    "reports named imports",
    `
      import { readFile } from "node:fs/promises";
    `,
    (output) => {
      assert.match(output, /namespace named NodeFSP/);
    },
  );

  rule.invalid(
    "reports default imports",
    `
      import path from "node:path";
    `,
    (output) => {
      assert.match(output, /namespace named NodePath/);
    },
  );

  rule.invalid(
    "reports non-canonical namespace aliases",
    `
      import * as Crypto from "node:crypto";
      import * as NodeOs from "node:os";
    `,
    (output) => {
      assert.match(output, /namespace named NodeCrypto/);
      assert.match(output, /namespace named NodeOS/);
    },
  );
});

// The harness above spawns the real `oxlint` binary, so the rule executes in a
// child process. These tests drive the same rule in this process, which is what
// makes its own branches — the alias tables, the PascalCase split, the
// specifier-shape checks — observable and coverable here.
describe("ch3/namespace-node-imports (in process)", () => {
  const lint = (ast: TestNode) => runRuleMessages(namespaceNodeImports, ast);

  const canonicalAliases = [
    ["node:fs", "NodeFS"],
    ["node:os", "NodeOS"],
    ["node:url", "NodeURL"],
    ["node:vm", "NodeVM"],
    ["node:path", "NodePath"],
    ["node:fs/promises", "NodeFSP"],
    ["node:assert/strict", "NodeAssert"],
    ["node:child_process", "NodeChildProcess"],
    ["node:worker_threads", "NodeWorkerThreads"],
    ["node:timers/promises", "NodeTimersPromises"],
    ["node:dns/promises", "NodeDnsPromises"],
    // Empty module name: every segment is filtered out, leaving just the prefix.
    ["node:", "Node"],
  ] as const;

  for (const [source, expectedAlias] of canonicalAliases) {
    it(`accepts ${source} imported as ${expectedAlias}`, () => {
      assert.deepStrictEqual(
        lint(program([importDeclaration(source, [namespaceSpecifier(expectedAlias)])])),
        [],
      );
    });

    it(`demands ${expectedAlias} for ${source}`, () => {
      assert.deepStrictEqual(
        lint(program([importDeclaration(source, [namespaceSpecifier("Wrong")])])),
        [`Import ${source} as a namespace named ${expectedAlias}.`],
      );
    });
  }

  it("reports a named import and points the diagnostic at the whole declaration", () => {
    const declaration = importDeclaration("node:fs/promises", [namedSpecifier("readFile")]);
    const reports = runRule(namespaceNodeImports, program([declaration]));

    assert.deepStrictEqual(
      reports.map((report) => report.message),
      ["Import node:fs/promises as a namespace named NodeFSP."],
    );
    assert.strictEqual(reports[0]?.reportedNode, declaration);
  });

  it("reports a default import", () => {
    assert.deepStrictEqual(
      lint(program([importDeclaration("node:path", [defaultSpecifier("path")])])),
      ["Import node:path as a namespace named NodePath."],
    );
  });

  it("reports a bare side-effect import, which carries no namespace to check", () => {
    assert.deepStrictEqual(lint(program([importDeclaration("node:crypto")])), [
      "Import node:crypto as a namespace named NodeCrypto.",
    ]);
  });

  it("reports a canonical namespace that arrives alongside a second specifier", () => {
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("node:fs", [defaultSpecifier("fs"), namespaceSpecifier("NodeFS")]),
        ]),
      ),
      ["Import node:fs as a namespace named NodeFS."],
    );
  });

  it("reports every offending declaration in one file and skips the compliant one", () => {
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("node:crypto", [namespaceSpecifier("Crypto")]),
          importDeclaration("node:os", [namespaceSpecifier("NodeOs")]),
          importDeclaration("node:fs", [namespaceSpecifier("NodeFS")]),
        ]),
      ),
      [
        "Import node:crypto as a namespace named NodeCrypto.",
        "Import node:os as a namespace named NodeOS.",
      ],
    );
  });

  it("ignores modules that are not Node built-ins", () => {
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("electron", [namedSpecifier("BrowserWindow")]),
          importDeclaration("effect/Effect", [namespaceSpecifier("Effect")]),
          // A package whose name merely contains the prefix is not a Node module.
          importDeclaration("my-node:fs", [namedSpecifier("readFile")]),
        ]),
      ),
      [],
    );
  });

  it("ignores a declaration whose source is not a string literal", () => {
    assert.deepStrictEqual(
      lint(
        program([
          { type: "ImportDeclaration", source: literal(42), specifiers: [] },
          { type: "ImportDeclaration", source: identifier("dynamic"), specifiers: [] },
          { type: "ImportDeclaration", specifiers: [] },
        ]),
      ),
      [],
    );
  });
});
