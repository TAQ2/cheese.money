// @effect-diagnostics preferSchemaOverJson:off - Fixtures write Claude Code's
// own settings.json, whose shape is defined by Claude Code rather than by us.
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import * as ClaudeStatusLine from "./ClaudeStatusLine.ts";
import * as ProcessRunner from "../../processRunner.ts";

const testLayer = ClaudeStatusLine.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** Write a project-scoped settings.json declaring `command` as the status line. */
const writeProjectStatusLine = Effect.fn("writeProjectStatusLine")(function* (
  cwd: string,
  command: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(cwd, ".claude"), { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(cwd, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command } }),
  );
});

/**
 * Runs `effect` with `$HOME` pointed at a scratch directory.
 *
 * The resolver falls back to the DEFAULT home's settings.json when a profile
 * has none of its own, so without this a test asserting "nothing configured"
 * picks up the developer's real ~/.claude/settings.json and runs their actual
 * status line.
 */
const withScratchHome = <A, E, R>(
  effect: (home: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PlatformError, R | FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    const realHome = process.env.HOME;
    process.env.HOME = home;
    return yield* effect(home).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }),
      ),
    );
  });

describe("ClaudeStatusLine", () => {
  it.effect("returns no text when no statusLine is configured", () =>
    withScratchHome(() =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

        // homePath points at an empty dir so the user-level file is absent too.
        const result = yield* statusLine.render({ cwd }, { homePath: cwd });

        assert.strictEqual(result.text, null);
        assert.strictEqual(result.failed, false);
      }),
    ).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("falls back to the default home when a profile has no settings", () =>
    withScratchHome((home) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const profile = yield* fileSystem.makeTempDirectoryScoped();
        const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

        // A freshly added account owns no settings, so the user's global
        // status line would silently vanish the moment they switched to it.
        yield* fileSystem.makeDirectory(path.join(home, ".claude"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(home, ".claude", "settings.json"),
          JSON.stringify({ statusLine: { type: "command", command: "printf global" } }),
        );

        const result = yield* statusLine.render({ cwd }, { homePath: profile });

        assert.strictEqual(result.text, "global");
        assert.strictEqual(result.failed, false);
      }),
    ).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("lets a profile's own statusLine win over the default home's", () =>
    withScratchHome((home) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const profile = yield* fileSystem.makeTempDirectoryScoped();
        const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

        yield* fileSystem.makeDirectory(path.join(home, ".claude"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(home, ".claude", "settings.json"),
          JSON.stringify({ statusLine: { type: "command", command: "printf global" } }),
        );
        yield* fileSystem.writeFileString(
          path.join(profile, "settings.json"),
          JSON.stringify({ statusLine: { type: "command", command: "printf profile" } }),
        );

        const result = yield* statusLine.render({ cwd }, { homePath: profile });

        assert.strictEqual(result.text, "profile");
      }),
    ).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("hands the account's CLAUDE_CONFIG_DIR to the command", () =>
    withScratchHome(() =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        const profile = yield* fileSystem.makeTempDirectoryScoped();
        const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

        // Without this the script inherits CH3's own environment, reads the
        // default account's credentials, and reports the wrong account's plan
        // usage after a switch.
        yield* writeProjectStatusLine(cwd, 'printf "%s" "$CLAUDE_CONFIG_DIR"');

        const result = yield* statusLine.render({ cwd }, { homePath: profile });

        assert.strictEqual(result.text, profile);
      }),
    ).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("runs the configured command and returns its output", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* writeProjectStatusLine(cwd, "printf 'hello from status line'");
      const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

      const result = yield* statusLine.render({ cwd }, { homePath: cwd });

      assert.strictEqual(result.text, "hello from status line");
      assert.strictEqual(result.failed, false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("feeds Claude Code's stdin contract to the command", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      // Echo back the fields a real status line reads, so a contract change here
      // fails loudly instead of silently blanking someone's status line.
      yield* writeProjectStatusLine(
        cwd,
        "jq -r '[.workspace.current_dir, .model.display_name, .version," +
          ' (.context_window.remaining_percentage|tostring)] | join("|")\'',
      );
      const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

      const result = yield* statusLine.render(
        {
          cwd,
          modelDisplayName: "Opus 5",
          version: "2.1.220",
          contextRemainingPercentage: 61,
        },
        { homePath: cwd },
      );

      assert.strictEqual(result.text, `${cwd}|Opus 5|2.1.220|61`);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reports failure without text when the command exits non-zero", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* writeProjectStatusLine(cwd, "printf 'partial'; exit 3");
      const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

      const result = yield* statusLine.render({ cwd }, { homePath: cwd });

      assert.strictEqual(result.text, null);
      assert.strictEqual(result.failed, true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps at most two lines", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* writeProjectStatusLine(cwd, "printf 'one\\ntwo\\nthree'");
      const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

      const result = yield* statusLine.render({ cwd }, { homePath: cwd });

      assert.strictEqual(result.text, "one\ntwo");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("prefers settings.local.json over settings.json", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* writeProjectStatusLine(cwd, "printf 'shared'");
      yield* fileSystem.writeFileString(
        path.join(cwd, ".claude", "settings.local.json"),
        JSON.stringify({ statusLine: { type: "command", command: "printf 'local'" } }),
      );
      const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

      const result = yield* statusLine.render({ cwd }, { homePath: cwd });

      assert.strictEqual(result.text, "local");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("ignores a malformed settings file rather than failing", () =>
    withScratchHome(() =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.makeDirectory(path.join(cwd, ".claude"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(cwd, ".claude", "settings.json"), "{ not json");
        const statusLine = yield* ClaudeStatusLine.ClaudeStatusLine;

        const result = yield* statusLine.render({ cwd }, { homePath: cwd });

        assert.strictEqual(result.text, null);
        assert.strictEqual(result.failed, false);
      }),
    ).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
