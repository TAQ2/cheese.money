import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BUNDLED_OUTPUT_STYLE_NAMES,
  DEFAULT_OUTPUT_STYLE,
  ensureBundledClaudeOutputStyles,
} from "./BundledOutputStyles.ts";

const stylesIn = Effect.fn(function* (configDir: string) {
  const path = yield* Path.Path;
  return path.join(configDir, "output-styles");
});

const tempConfigDir = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "ch3-output-styles-" });
});

it.layer(NodeServices.layer)("BundledOutputStyles", (it) => {
  it.effect("installs the shipped styles on a machine that has none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* tempConfigDir();
      yield* ensureBundledClaudeOutputStyles(configDir);

      const written = (yield* fs.readDirectory(yield* stylesIn(configDir))).toSorted();
      assert.deepEqual(written, [
        "action-first.md",
        "caveman.md",
        "design-director.md",
        "executive-brief.md",
        "first-principles.md",
        "im-tired.md",
        "no-caveats.md",
        "simplified-technical-english.md",
        "whiteboard.md",
      ]);
    }),
  );

  it.effect("never overwrites a style the user already has", () =>
    Effect.gen(function* () {
      // These files live in the user's home beside styles they wrote. Somebody
      // who edited a shipped one edited it on purpose; restoring our copy on
      // every launch would make the app unusable for exactly that person.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* tempConfigDir();
      const dir = yield* stylesIn(configDir);
      yield* fs.makeDirectory(dir, { recursive: true });
      const mine = path.join(dir, "caveman.md");
      yield* fs.writeFileString(mine, "---\nname: Caveman\n---\n\nmy own version");

      yield* ensureBundledClaudeOutputStyles(configDir);

      assert.equal(yield* fs.readFileString(mine), "---\nname: Caveman\n---\n\nmy own version");
      // The rest still land — the shipped set is a floor, not all-or-nothing.
      assert.ok(yield* fs.exists(path.join(dir, "whiteboard.md")));
    }),
  );

  it.effect("leaves styles it does not ship alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* tempConfigDir();
      const dir = yield* stylesIn(configDir);
      yield* fs.makeDirectory(dir, { recursive: true });
      const personal = path.join(dir, "zoom.md");
      yield* fs.writeFileString(personal, "---\nname: Zoom\n---\n\npersonal");

      yield* ensureBundledClaudeOutputStyles(configDir);

      assert.ok(yield* fs.exists(personal));
      assert.equal(yield* fs.readFileString(personal), "---\nname: Zoom\n---\n\npersonal");
    }),
  );

  it.effect("is idempotent, because it runs on every driver init", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* tempConfigDir();
      const caveman = path.join(yield* stylesIn(configDir), "caveman.md");
      yield* ensureBundledClaudeOutputStyles(configDir);
      const first = yield* fs.readFileString(caveman);
      yield* ensureBundledClaudeOutputStyles(configDir);
      assert.equal(yield* fs.readFileString(caveman), first);
    }),
  );

  it("ships exactly the agreed nine, and the default is one of them", () => {
    assert.deepEqual([...BUNDLED_OUTPUT_STYLE_NAMES].sort(), [
      "Action First",
      "Caveman",
      "Design Director",
      "Executive Brief",
      "First Principles",
      "I'm Tired",
      "No Caveats",
      "Simplified Technical English",
      "Whiteboard",
    ]);
    // The name is matched verbatim against what the CLI advertises, so a
    // rename in the markdown frontmatter would silently stop the default
    // applying.
    assert.ok(BUNDLED_OUTPUT_STYLE_NAMES.includes(DEFAULT_OUTPUT_STYLE));
  });

  it.effect("tells every style to answer in the user's language", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* tempConfigDir();
      const dir = yield* stylesIn(configDir);
      yield* ensureBundledClaudeOutputStyles(configDir);
      for (const fileName of yield* fs.readDirectory(dir)) {
        const contents = yield* fs.readFileString(path.join(dir, fileName));
        assert.ok(
          contents.includes("Answer in the language the person wrote in"),
          `${fileName} is missing the language rule`,
        );
      }
    }),
  );
});
