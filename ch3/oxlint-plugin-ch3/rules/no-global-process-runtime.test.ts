import { assert, describe, it } from "@effect/vitest";

import type { TestNode } from "../test/inProcessRule.ts";
import {
  asExpression,
  call,
  createRuleSession,
  defaultSpecifier,
  expressionStatement,
  identifier,
  importDeclaration,
  literal,
  member,
  namedSpecifier,
  namespaceSpecifier,
  nonNullExpression,
  program,
  runRule,
  runRuleMessages,
} from "../test/inProcessRule.ts";
import { createOxlintRuleHarness } from "../test/utils.ts";
import noGlobalProcessRuntime from "./no-global-process-runtime.ts";

const rule = createOxlintRuleHarness("ch3/no-global-process-runtime");

describe("ch3/no-global-process-runtime", () => {
  rule.valid(
    "allows injected host process references",
    `
      import { HostProcessPlatform } from "@ch3tools/shared/hostProcess";
      import * as Effect from "effect/Effect";

      export const isWindows = Effect.map(HostProcessPlatform, (platform) => platform === "win32");
    `,
  );

  rule.valid(
    "allows unrelated process members",
    `
      process.exitCode = 1;
      const nodeEnv = process.env.NODE_ENV;
    `,
  );

  rule.valid(
    "allows unrelated node os imports",
    `
      import { tmpdir } from "node:os";

      export const tempDirectory = tmpdir();
    `,
  );

  rule.invalid(
    "reports direct platform reads",
    `
      export const isWindows = process.platform === "win32";
    `,
    (output) => {
      assert.match(output, /Use HostProcessPlatform/);
    },
  );

  rule.invalid(
    "reports direct architecture reads",
    `
      export const isArm = process.arch === "arm64";
    `,
    (output) => {
      assert.match(output, /Use HostProcessArchitecture/);
    },
  );

  rule.invalid(
    "reports globalThis process platform reads",
    `
      export const terminalName = globalThis.process.platform === "win32" ? "xterm-color" : "xterm-256color";
    `,
  );

  rule.invalid(
    "reports node os namespace platform reads",
    `
      import * as NodeOS from "node:os";

      export const isWindows = NodeOS.platform() === "win32";
    `,
    (output) => {
      assert.match(output, /Use HostProcessPlatform/);
    },
  );

  rule.invalid(
    "reports renamed node os architecture imports",
    `
      import { arch as hostArch } from "node:os";

      export const isArm = hostArch() === "arm64";
    `,
    (output) => {
      assert.match(output, /Use HostProcessArchitecture/);
    },
  );

  rule.invalid(
    "reports default node os platform reads",
    `
      import os from "node:os";

      export const isWindows = os.platform() === "win32";
    `,
  );
});

// The harness above spawns the real `oxlint` binary, so the rule executes in a
// child process. These tests drive the same rule in this process, where the
// path normalisation, the `node:os` binding table and the per-file reset of
// that table are all observable.
const PLATFORM_MESSAGE =
  "Use HostProcessPlatform instead of process.platform; inject the runtime reference in Effect code and provide it explicitly in tests.";
const ARCHITECTURE_MESSAGE =
  "Use HostProcessArchitecture instead of process.arch; inject the runtime reference in Effect code and provide it explicitly in tests.";

const HOST_PROCESS_FILE = "/repo/packages/shared/src/hostProcess.ts";

describe("ch3/no-global-process-runtime (in process)", () => {
  const lint = (ast: TestNode, options?: { filename?: string; cwd?: string }) =>
    runRuleMessages(noGlobalProcessRuntime, ast, options);

  const read = (object: TestNode, property: TestNode, computed = false) =>
    program([expressionStatement(member(object, property, computed))]);

  it("reports a direct platform read and points the diagnostic at the member expression", () => {
    const expression = member(identifier("process"), identifier("platform"));
    const reports = runRule(noGlobalProcessRuntime, program([expressionStatement(expression)]));

    assert.deepStrictEqual(
      reports.map((report) => report.message),
      [PLATFORM_MESSAGE],
    );
    assert.strictEqual(reports[0]?.reportedNode, expression);
  });

  it("names the architecture reference for an arch read", () => {
    assert.deepStrictEqual(lint(read(identifier("process"), identifier("arch"))), [
      ARCHITECTURE_MESSAGE,
    ]);
  });

  it("reaches process through globalThis, computed keys and type wrappers", () => {
    const globalProcess = member(identifier("globalThis"), identifier("process"));
    const computedGlobalProcess = member(identifier("globalThis"), literal("process"), true);

    assert.deepStrictEqual(lint(read(globalProcess, identifier("platform"))), [PLATFORM_MESSAGE]);
    assert.deepStrictEqual(lint(read(computedGlobalProcess, identifier("platform"))), [
      PLATFORM_MESSAGE,
    ]);
    assert.deepStrictEqual(lint(read(identifier("process"), literal("arch"), true)), [
      ARCHITECTURE_MESSAGE,
    ]);
    assert.deepStrictEqual(lint(read(asExpression(identifier("process")), identifier("arch"))), [
      ARCHITECTURE_MESSAGE,
    ]);
    assert.deepStrictEqual(
      lint(read(nonNullExpression(identifier("process")), identifier("platform"))),
      [PLATFORM_MESSAGE],
    );
  });

  it("leaves unrelated members and unrelated objects alone", () => {
    assert.deepStrictEqual(lint(read(identifier("process"), identifier("env"))), []);
    assert.deepStrictEqual(lint(read(identifier("process"), identifier("exitCode"))), []);
    assert.deepStrictEqual(lint(read(identifier("navigator"), identifier("platform"))), []);
    assert.deepStrictEqual(
      lint(read(member(identifier("globalThis"), identifier("worker")), identifier("platform"))),
      [],
    );
    // A computed key that is not a string literal cannot be resolved to a name.
    assert.deepStrictEqual(lint(read(identifier("process"), identifier("key"), true)), []);
  });

  it("exempts only the shared host process reference file, whatever the path separators", () => {
    assert.deepStrictEqual(
      lint(read(identifier("process"), identifier("platform")), { filename: HOST_PROCESS_FILE }),
      [],
    );
    // A trailing separator on the cwd must not shift the repo-relative path.
    assert.deepStrictEqual(
      lint(read(identifier("process"), identifier("platform")), {
        filename: HOST_PROCESS_FILE,
        cwd: "/repo///",
      }),
      [],
    );
    assert.deepStrictEqual(
      lint(read(identifier("process"), identifier("arch")), {
        filename: "C:\\repo\\packages\\shared\\src\\hostProcess.ts",
        cwd: "C:\\repo",
      }),
      [],
    );
  });

  it("still reports a host process file that is not inside the repo root", () => {
    assert.deepStrictEqual(
      lint(read(identifier("process"), identifier("platform")), {
        filename: "/elsewhere/packages/shared/src/hostProcess.ts",
        cwd: "/repo",
      }),
      [PLATFORM_MESSAGE],
    );
  });

  it("does not extend the exemption to a neighbour of the host process file", () => {
    assert.deepStrictEqual(
      lint(read(identifier("process"), identifier("platform")), {
        filename: "/repo/packages/shared/src/hostProcessFake.ts",
      }),
      [PLATFORM_MESSAGE],
    );
  });

  it("reports runtime reads through every shape of node:os binding", () => {
    const bindings = [
      {
        name: "namespace",
        specifier: namespaceSpecifier("NodeOS"),
        source: "node:os",
        callee: member(identifier("NodeOS"), identifier("platform")),
        expected: PLATFORM_MESSAGE,
      },
      {
        name: "namespace with a computed key",
        specifier: namespaceSpecifier("NodeOS"),
        source: "node:os",
        callee: member(identifier("NodeOS"), literal("arch"), true),
        expected: ARCHITECTURE_MESSAGE,
      },
      {
        name: "default import",
        specifier: defaultSpecifier("os"),
        source: "node:os",
        callee: member(identifier("os"), identifier("platform")),
        expected: PLATFORM_MESSAGE,
      },
      {
        name: "renamed named import",
        specifier: namedSpecifier("arch", "hostArch"),
        source: "node:os",
        callee: identifier("hostArch"),
        expected: ARCHITECTURE_MESSAGE,
      },
      {
        // `NODE_OS_MODULES` covers the un-prefixed specifier too.
        name: "bare os specifier",
        specifier: namedSpecifier("platform"),
        source: "os",
        callee: identifier("platform"),
        expected: PLATFORM_MESSAGE,
      },
    ] as const;

    for (const binding of bindings) {
      assert.deepStrictEqual(
        lint(
          program([
            importDeclaration(binding.source, [binding.specifier]),
            expressionStatement(call(binding.callee)),
          ]),
        ),
        [binding.expected],
        binding.name,
      );
    }
  });

  it("ignores node:os bindings that are not runtime reads, and platform reads from elsewhere", () => {
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("node:os", [namedSpecifier("tmpdir")]),
          expressionStatement(call(identifier("tmpdir"))),
        ]),
      ),
      [],
    );
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("node:process", [namedSpecifier("platform")]),
          expressionStatement(call(identifier("platform"))),
        ]),
      ),
      [],
    );
    // No import at all: the identifier is not a tracked `node:os` binding.
    assert.deepStrictEqual(
      lint(program([expressionStatement(call(member(identifier("NodeOS"), identifier("arch"))))])),
      [],
    );
    // A namespace member that is never invoked is not a runtime read.
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("node:os", [namespaceSpecifier("NodeOS")]),
          expressionStatement(member(identifier("NodeOS"), identifier("platform"))),
        ]),
      ),
      [],
    );
    // A tracked namespace, but not one of the runtime properties.
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("node:os", [namespaceSpecifier("NodeOS")]),
          expressionStatement(call(member(identifier("NodeOS"), identifier("homedir")))),
        ]),
      ),
      [],
    );
  });

  it("forgets the node:os bindings of the previous file", () => {
    const session = createRuleSession(noGlobalProcessRuntime);
    const platformCall = () =>
      program([expressionStatement(call(member(identifier("NodeOS"), identifier("platform"))))]);

    const withImport = session.lint(
      program([
        importDeclaration("node:os", [namespaceSpecifier("NodeOS")]),
        expressionStatement(call(member(identifier("NodeOS"), identifier("platform")))),
      ]),
      { filename: "/repo/apps/server/src/first.ts" },
    );
    const withoutImport = session.lint(platformCall(), {
      filename: "/repo/apps/server/src/second.ts",
    });

    assert.deepStrictEqual(
      withImport.map((report) => report.message),
      [PLATFORM_MESSAGE],
    );
    assert.deepStrictEqual(withoutImport, []);
  });

  it("reports each offending read in a file", () => {
    assert.deepStrictEqual(
      lint(
        program([
          importDeclaration("node:os", [namespaceSpecifier("NodeOS")]),
          expressionStatement(member(identifier("process"), identifier("platform"))),
          expressionStatement(call(member(identifier("NodeOS"), identifier("arch")))),
          expressionStatement(member(identifier("process"), identifier("env"))),
        ]),
      ),
      [PLATFORM_MESSAGE, ARCHITECTURE_MESSAGE],
    );
  });
});
