import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeOutputStyles, discoverClaudeSkills } from "./ClaudeSkills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverClaudeSkills", (it) => {
  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(configDir, "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over user skills on name collisions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "deploy",
        ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Project deploy.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.scope, "project");
      assert.equal(skills[0]?.description, "Project deploy.");
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      yield* writeSkill(skillsDir, "broken-yaml", "---\nname: [unclosed\n---\n");
      // The realistic break: one bare `: ` inside an unquoted description
      // invalidates the whole block even though `name:` is perfectly readable.
      yield* writeSkill(
        skillsDir,
        "bare-colon",
        "---\nname: renamed-in-frontmatter\ndescription: Levels: one, two.\n---\n",
      );
      // A stray file (not a directory with SKILL.md) must be skipped.
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // Every one of these still loads in Claude Code, under its DIRECTORY
      // name — CLI 2.1.263 ignores the `name:` a broken block claims, which
      // is why `bare-colon` appears here and `renamed-in-frontmatter` does
      // not. Skipping them would hide working skills from the `$` picker.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["bare-colon", "broken-yaml", "no-frontmatter"],
      );
      assert.deepEqual(
        skills.map((skill) => skill.description),
        [undefined, undefined, undefined],
      );
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR from the environment when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["env-skill"],
      );

      // An explicit homePath wins over the environment variable, matching
      // makeClaudeEnvironment which overwrites CLAUDE_CONFIG_DIR for the CLI.
      const explicitHome = path.join(tempDir, "explicit-home");
      yield* writeSkill(
        path.join(explicitHome, "skills"),
        "explicit-skill",
        ["---", "name: explicit-skill", "---"].join("\n"),
      );
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ["explicit-skill"],
      );
    }),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // The spawned CLI resolves a relative CLAUDE_CONFIG_DIR against its own
      // cwd (the workspace), so discovery must do the same.
      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, workspace, {
        CLAUDE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("returns an empty list when no skill roots exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-skills-" });

      const skills = yield* discoverClaudeSkills(
        { homePath: path.join(tempDir, "missing-home") },
        path.join(tempDir, "missing-workspace"),
      );

      assert.deepEqual(skills, []);
    }),
  );
});

const writeOutputStyle = Effect.fn(function* (
  stylesDir: string,
  fileName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(stylesDir, { recursive: true });
  yield* fs.writeFileString(path.join(stylesDir, fileName), contents);
});

const BUILT_INS = ["default", "Explanatory", "Learning", "Proactive"];

it.layer(NodeServices.layer)("discoverClaudeOutputStyles", (it) => {
  it.effect("reports the built-ins alone when the styles directory is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-styles-" });

      const styles = yield* discoverClaudeOutputStyles({
        homePath: path.join(tempDir, "missing-home"),
      });

      // `default` must survive an empty config dir: it is what the composer
      // chip shows when the thread has picked no style.
      assert.deepEqual(styles, BUILT_INS);
    }),
  );

  it.effect("identifies a style by its frontmatter name, not its filename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-styles-" });
      const configDir = path.join(tempDir, "claude-home");

      // The CLI resolves `outputStyle: "Simplified Technical English"` for
      // this file and rejects the filename stem, so the stem must never be
      // what CH3 offers.
      yield* writeOutputStyle(
        path.join(configDir, "output-styles"),
        "simplified-technical-english.md",
        ["---", "name: Simplified Technical English", "description: STE.", "---", "", "Body"].join(
          "\n",
        ),
      );

      const styles = yield* discoverClaudeOutputStyles({ homePath: configDir });

      assert.deepEqual(styles, [...BUILT_INS, "Simplified Technical English"]);
    }),
  );

  it.effect("recovers a name from a broken block, falls back to the stem, skips non-markdown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-styles-" });
      const configDir = path.join(tempDir, "claude-home");
      const stylesDir = path.join(configDir, "output-styles");

      yield* writeOutputStyle(stylesDir, "no-frontmatter.md", "# Just a heading\n");
      yield* writeOutputStyle(stylesDir, "notes.txt", "---\nname: Not A Style\n---\n");
      // Styles keep their declared name through a broken block: the CLI
      // resolves `outputStyle: "Caveman"` for this file and rejects the
      // filename stem, so the stem must not be what CH3 offers.
      yield* writeOutputStyle(
        stylesDir,
        "caveman.md",
        "---\nname: Caveman\ndescription: Levels: lite, full, ultra.\n---\n",
      );

      const styles = yield* discoverClaudeOutputStyles({ homePath: configDir });

      assert.deepEqual(styles, [...BUILT_INS, "Caveman", "no-frontmatter"]);
    }),
  );

  it.effect("does not offer a style twice when it only differs from a built-in in case", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-styles-" });
      const configDir = path.join(tempDir, "claude-home");
      const stylesDir = path.join(configDir, "output-styles");

      // The CLI matches style names case-insensitively, so this file IS the
      // built-in rather than a second entry offering the same style.
      yield* writeOutputStyle(stylesDir, "explanatory.md", "---\nname: explanatory\n---\n");
      // Two files claiming the same style: the first in sorted filename order
      // wins, so the list is stable rather than dependent on directory order.
      yield* writeOutputStyle(stylesDir, "a-caveman.md", "---\nname: Caveman\n---\n");
      yield* writeOutputStyle(stylesDir, "b-caveman.md", "---\nname: CAVEMAN\n---\n");

      const styles = yield* discoverClaudeOutputStyles({ homePath: configDir });

      assert.deepEqual(styles, [...BUILT_INS, "Caveman"]);
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ch3-claude-styles-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      // Account rotation is the whole reason this matters: a thread bound to a
      // non-default account must see that account's styles.
      yield* writeOutputStyle(
        path.join(environmentConfigDir, "output-styles"),
        "receipts.md",
        "---\nname: Receipts\n---\n",
      );

      const styles = yield* discoverClaudeOutputStyles({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(styles, [...BUILT_INS, "Receipts"]);
    }),
  );
});
