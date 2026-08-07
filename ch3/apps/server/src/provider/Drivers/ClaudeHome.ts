import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@ch3tools/contracts";
import { fromJsonStringPretty } from "@ch3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

/**
 * The config directory Claude Code uses when `CLAUDE_CONFIG_DIR` is unset.
 */
export const defaultClaudeConfigDirPath = Effect.fn("defaultClaudeConfigDirPath")(
  function* (): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    return path.resolve(NodeOS.homedir(), ".claude");
  },
);

/**
 * The `homePath` setting reduced to its meaning: an explicit path pointing at
 * the CLI's own default config directory means exactly what an empty setting
 * means, and must be treated that way.
 *
 * The asymmetry that makes this necessary: with `CLAUDE_CONFIG_DIR` unset the
 * CLI keeps its config in `~/.claude.json`, BESIDE `~/.claude`; with the
 * variable set to X it keeps it in `X/.claude.json`, INSIDE. So
 * `CLAUDE_CONFIG_DIR=~/.claude` is NOT the same as leaving it unset — the CLI
 * finds no config there, writes a fresh empty one, and reports "Not logged in"
 * for an account that is in fact signed in. Every thread then fails with
 * "Please run /login", and switching back does not repair it because the
 * damage is a settings value, not a credential.
 */
export const effectiveClaudeHomePathSetting = Effect.fn("effectiveClaudeHomePathSetting")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const homePath = config.homePath.trim();
    if (homePath.length === 0) return "";
    const resolved = path.resolve(expandHomePath(homePath));
    return resolved === (yield* defaultClaudeConfigDirPath()) ? "" : homePath;
  },
);

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = yield* effectiveClaudeHomePathSetting(config);
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath({ homePath });
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * Make a profile share the default home's transcript store.
 *
 * Claude Code keeps conversations in `<CLAUDE_CONFIG_DIR>/projects/<slug>/
 * <sessionId>.jsonl`, and there is no environment variable that relocates
 * them independently — `CLAUDE_CONFIG_DIR` is the only knob the CLI reads.
 * So a profile that owns its own `projects` directory cannot see any
 * conversation started on another one, and resuming fails outright with
 * "No conversation found with session ID".
 *
 * That is not how Claude Code behaves natively: signing a different account
 * into the same config directory leaves every transcript exactly where it
 * was, so conversations continue across the switch. Pointing each profile's
 * `projects` at the default home's reproduces that: credentials stay separate
 * per account, conversations stay shared. Verified against the real CLI —
 * with the transcript reachable, `--resume` loads it under the other account.
 *
 * Idempotent, and it never destroys anything: where the same filename exists
 * on both sides the shared copy wins, and the profile's copy is set aside in
 * `projects.unmerged` rather than deleted or left in a position where it would
 * silently keep sharing switched off.
 */
export const ensureSharedClaudeTranscriptStore = Effect.fn("ensureSharedClaudeTranscriptStore")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
  ): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
    // Always created when absent: a machine that has never run the CLI still
    // needs somewhere for the first conversation to land.
    yield* shareClaudeConfigDirectory(config, "projects", { createWhenMissing: true });
  },
);

/**
 * The rest of what a config directory holds for the user, shared for exactly
 * the same reason as the transcripts.
 *
 * Skills, commands, agents and output styles are things the user WROTE, and
 * the CLI discovers them from the config directory. Natively they live in one
 * such directory and every account sees them; a profile gets its own empty
 * one, so a skill invoked yesterday is simply gone today — `/refresh` stops
 * resolving and the composer answers "No matching command", with nothing to
 * suggest the account switch caused it. Output styles fail the same way and
 * more quietly: the CLI reports only the built-ins for the profile, so the
 * response-style picker looks complete while every style the user wrote is
 * missing from it.
 *
 * `hooks` is deliberately NOT shared. Hooks are declared in `settings.json`
 * rather than discovered from a directory, so sharing the folder would move
 * executables between accounts and change nothing about what runs.
 *
 * Unlike `projects` these are not created when neither side has them: an
 * empty `commands` directory in someone's home helps nobody.
 */
const SHARED_CLAUDE_ASSET_DIRECTORIES = ["skills", "commands", "agents", "output-styles"] as const;

export const ensureSharedClaudeUserAssets = Effect.fn("ensureSharedClaudeUserAssets")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
  for (const directoryName of SHARED_CLAUDE_ASSET_DIRECTORIES) {
    yield* shareClaudeConfigDirectory(config, directoryName, { createWhenMissing: false });
  }
});

const shareClaudeConfigDirectory = Effect.fn("shareClaudeConfigDirectory")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  directoryName: string,
  options: { readonly createWhenMissing: boolean },
): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* effectiveClaudeHomePathSetting(config);
  // The default home IS the shared store; nothing to point anywhere.
  if (homePath.length === 0) return;

  const profileStore = path.join(yield* resolveClaudeHomePath({ homePath }), directoryName);
  const sharedStore = path.join(yield* defaultClaudeConfigDirPath(), directoryName);
  if (profileStore === sharedStore) return;

  if (options.createWhenMissing) {
    yield* fs.makeDirectory(sharedStore, { recursive: true }).pipe(Effect.orElseSucceed(() => {}));
  } else {
    const sharedExists = yield* fs.exists(sharedStore).pipe(Effect.orElseSucceed(() => false));
    // `exists` FOLLOWS links, so a share whose target was later deleted reads
    // as absent on both sides. Skipping then would leave a dangling link the
    // profile can never resolve — worse than never having shared at all.
    const alreadyShared =
      (yield* fs.readLink(profileStore).pipe(Effect.orElseSucceed(() => ""))).length > 0;
    const profileExists =
      alreadyShared || (yield* fs.exists(profileStore).pipe(Effect.orElseSucceed(() => false)));
    // Neither side has this kind of asset; creating an empty pair of
    // directories would be noise in the user's home for no gain.
    if (!sharedExists && !profileExists) return;
    if (!sharedExists) {
      yield* fs
        .makeDirectory(sharedStore, { recursive: true })
        .pipe(Effect.orElseSucceed(() => {}));
    }
  }

  // `readLink` succeeding is the only reliable "this is a symlink" signal
  // here — `stat` follows links, so it reports an already-shared store as an
  // ordinary directory and the migration would run forever.
  const existingLink = yield* fs.readLink(profileStore).pipe(Effect.orElseSucceed(() => ""));
  if (existingLink.length > 0) {
    // Already a link. If it points elsewhere, someone meant it — leave it.
    return;
  }

  const isDirectory = yield* fs.stat(profileStore).pipe(
    Effect.map((stats) => stats.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
  if (isDirectory) {
    yield* mergeSharedDirectory({ from: profileStore, into: sharedStore });
    const leftovers = yield* fs
      .readDirectory(profileStore)
      .pipe(Effect.orElseSucceed(() => ["unreadable"]));
    if (leftovers.length > 0) {
      // Something could not be merged without overwriting. Set it aside
      // instead of either destroying it or abandoning the link — leaving the
      // directory in place silently disables sharing, which is the failure
      // this whole function exists to prevent.
      const setAside = `${profileStore}.unmerged`;
      const setAsideTaken = yield* fs.exists(setAside).pipe(Effect.orElseSucceed(() => true));
      if (setAsideTaken) return;
      const moved = yield* fs.rename(profileStore, setAside).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!moved) return;
    } else {
      yield* fs.remove(profileStore, { recursive: true }).pipe(Effect.orElseSucceed(() => {}));
    }
  }

  yield* fs.symlink(sharedStore, profileStore).pipe(Effect.orElseSucceed(() => {}));
});

/**
 * Give a profile the MCP servers the user configured at user scope.
 *
 * Same shape of failure as the transcript store, and the same cause. A server
 * added with `claude mcp add -s user` is written to the config file of
 * whichever config directory the CLI was pointed at — `~/.claude.json` with
 * `CLAUDE_CONFIG_DIR` unset, `<profile>/.claude.json` with it set. A terminal
 * has it unset; CH3 on a profile has it set. So a server the user added from
 * their terminal is simply invisible to every thread CH3 runs on a profile,
 * while project-scope `.mcp.json` servers still load and mask the problem.
 *
 * Natively there is nothing to reproduce here — `/login` switching keeps one
 * config directory, so user-scope servers never move. Profiles moved them, so
 * profiles have to carry them.
 *
 * Additive and idempotent: a name the profile already defines is left exactly
 * as it is, because that entry may point at a different endpoint and its OAuth
 * token is stored per endpoint. Nothing is ever removed — a server deleted
 * from the default home stays until the user deletes it here too, which is the
 * safe direction for a file the CLI also writes.
 */
export const ensureSharedClaudeMcpServers = Effect.fn("ensureSharedClaudeMcpServers")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* effectiveClaudeHomePathSetting(config);
  // The default home IS where user-scope servers are kept.
  if (homePath.length === 0) return;

  // With CLAUDE_CONFIG_DIR unset the config sits BESIDE `~/.claude`, not in
  // it; with it set it sits inside the directory. That asymmetry is the whole
  // reason these two paths are built differently.
  const sourceFile = path.resolve(NodeOS.homedir(), ".claude.json");
  const targetFile = path.join(yield* resolveClaudeHomePath({ homePath }), ".claude.json");
  if (sourceFile === targetFile) return;

  const sourceServers = yield* readClaudeConfigMcpServers(sourceFile);
  if (Object.keys(sourceServers).length === 0) return;

  const targetRaw = yield* fs.readFileString(targetFile).pipe(Effect.orElseSucceed(() => ""));
  // No config yet means the CLI has never run for this profile. Writing one
  // here would hand it a file it did not create, and a config without the
  // account block reads as "not logged in" — the exact failure the home-path
  // handling above exists to prevent.
  if (targetRaw.trim().length === 0) return;

  const targetConfig = yield* decodeClaudeConfigJson(targetRaw).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (targetConfig === null || typeof targetConfig !== "object" || Array.isArray(targetConfig)) {
    return;
  }

  const existing = (targetConfig as { mcpServers?: unknown }).mcpServers;
  const existingServers =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  // `in` walks the prototype chain, so a server named `toString` or
  // `constructor` would read as already present and never be copied.
  const missing = Object.entries(sourceServers).filter(
    ([name]) => !Object.hasOwn(existingServers, name),
  );
  if (missing.length === 0) return;

  const merged = {
    ...targetConfig,
    mcpServers: { ...existingServers, ...Object.fromEntries(missing) },
  };
  const encoded = yield* encodeClaudeConfigJson(merged).pipe(Effect.orElseSucceed(() => ""));
  if (encoded.length === 0) return;
  // Written through a temporary file: the CLI writes this same config, and a
  // half-written one would cost the user their session state.
  const temporaryFile = `${targetFile}.ch3-mcp-merge`;
  const wrote = yield* fs.writeFileString(temporaryFile, `${encoded}\n`).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!wrote) return;
  // This file holds the signed-in account and any headers an HTTP MCP server
  // carries. The CLI keeps it at 0600; a fresh temporary file is 0644, and
  // `rename` would carry that mode onto the target, quietly widening it.
  yield* fs.chmod(temporaryFile, 0o600).pipe(Effect.orElseSucceed(() => {}));
  const renamed = yield* fs.rename(temporaryFile, targetFile).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!renamed) {
    yield* fs.remove(temporaryFile).pipe(Effect.orElseSucceed(() => {}));
  }
});

/** The CLI's own config file, read and written whole: only `mcpServers` is
    ours to touch, and everything else must survive byte-for-byte in meaning. */
const ClaudeConfigJson = fromJsonStringPretty(Schema.Unknown);
const decodeClaudeConfigJson = Schema.decodeEffect(ClaudeConfigJson);
const encodeClaudeConfigJson = Schema.encodeUnknownEffect(ClaudeConfigJson);

const readClaudeConfigMcpServers = Effect.fn("readClaudeConfigMcpServers")(function* (
  configFile: string,
): Effect.fn.Return<Record<string, unknown>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(configFile).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return {};
  const parsed = yield* decodeClaudeConfigJson(raw).pipe(Effect.orElseSucceed(() => null));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
});

/** Deep enough for `projects/<slug>/<any nesting the CLI adds>`. */
const MERGE_MAX_DEPTH = 8;

/**
 * Moves a profile's transcripts into the shared store, never overwriting.
 *
 * Recursive on purpose. A project folder holds more than transcripts — the CLI
 * also keeps a `memory` directory in there — and those subdirectories exist on
 * both sides. Skipping any entry that already exists left the source directory
 * non-empty, which blocked the symlink and quietly left the profile with its
 * own store: transcripts merged, sharing never switched on.
 *
 * Only a genuine file-vs-file collision is left behind, and the shared copy
 * wins because it is the one both accounts can already see.
 */
const mergeSharedDirectory = Effect.fn("mergeSharedDirectory")(function* (input: {
  readonly from: string;
  readonly into: string;
  readonly depth?: number;
}): Effect.fn.Return<void, never, Path.Path | FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const depth = input.depth ?? 0;
  if (depth > MERGE_MAX_DEPTH) return;

  const entries = yield* fs.readDirectory(input.from).pipe(Effect.orElseSucceed(() => []));
  for (const entry of entries) {
    const from = path.join(input.from, entry);
    const into = path.join(input.into, entry);
    // `exists` failing is treated as "present" so an unreadable target is
    // never overwritten.
    const targetExists = yield* fs.exists(into).pipe(Effect.orElseSucceed(() => true));
    if (!targetExists) {
      yield* fs.rename(from, into).pipe(Effect.orElseSucceed(() => {}));
      continue;
    }
    const bothDirectories = yield* Effect.all([
      fs.stat(from).pipe(
        Effect.map((stats) => stats.type === "Directory"),
        Effect.orElseSucceed(() => false),
      ),
      fs.stat(into).pipe(
        Effect.map((stats) => stats.type === "Directory"),
        Effect.orElseSucceed(() => false),
      ),
    ]).pipe(Effect.map(([fromIsDirectory, intoIsDirectory]) => fromIsDirectory && intoIsDirectory));
    if (!bothDirectories) continue;

    yield* mergeSharedDirectory({ from, into, depth: depth + 1 });
    const remaining = yield* fs
      .readDirectory(from)
      .pipe(Effect.orElseSucceed(() => ["unreadable"]));
    if (remaining.length === 0) {
      yield* fs.remove(from, { recursive: true }).pipe(Effect.orElseSucceed(() => {}));
    }
  }
});

// Both keys normalize first, so a setting of `~/.claude` and an empty setting
// land in the same continuation group and share one capability probe — they
// launch the identical environment.
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const homePath = yield* effectiveClaudeHomePathSetting(config);
    const resolvedHomePath = yield* resolveClaudeHomePath({ homePath });
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const homePath = yield* effectiveClaudeHomePathSetting(config);
    const resolvedHomePath = yield* resolveClaudeHomePath({ homePath });
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);
