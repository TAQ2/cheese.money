// @effect-diagnostics nodeBuiltinImport:off - Authoring-time script; runs before any Effect runtime exists.
// @effect-diagnostics globalConsole:off - Authoring-time script; its one line of output is the build log.
/**
 * Pack the shipped response styles into a JSON module the server can import.
 *
 * The styles are authored as ordinary markdown in `assets/output-styles/` —
 * that is where they should be read and edited. This script folds them into
 * `apps/server/src/provider/Drivers/bundledOutputStyles.json`, which the server
 * imports directly so the content survives being packed into `app.asar` with
 * no filesystem lookup and no asset-resolution step at runtime.
 *
 * JSON rather than a TypeScript module of template literals on purpose: these
 * files contain fenced code blocks, backticks and `${`, all of which a
 * template literal would either break on or silently interpolate.
 *
 * Run after editing any style:
 *
 *   node scripts/bundle-output-styles.ts
 *
 * The generated file is committed: a build that reaches for a generator is a
 * build that can fail on somebody else's machine.
 *
 * @module bundle-output-styles
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const sourceDir = NodePath.join(repoRoot, "assets", "output-styles");
const outputFile = NodePath.join(
  repoRoot,
  "apps",
  "server",
  "src",
  "provider",
  "Drivers",
  "bundledOutputStyles.json",
);

const entries = (await NodeFSP.readdir(sourceDir))
  .filter((name) => name.endsWith(".md"))
  .sort((a, b) => a.localeCompare(b));

const styles: Array<{ readonly fileName: string; readonly contents: string }> = [];
for (const fileName of entries) {
  const contents = await NodeFSP.readFile(NodePath.join(sourceDir, fileName), "utf8");
  if (!contents.startsWith("---\n")) {
    throw new Error(`${fileName} has no frontmatter; Claude Code needs name + description.`);
  }
  styles.push({ fileName, contents });
}

await NodeFSP.writeFile(outputFile, `${JSON.stringify({ styles }, null, 2)}\n`, "utf8");
console.log(
  `Bundled ${styles.length} response styles into ${NodePath.relative(repoRoot, outputFile)}`,
);
