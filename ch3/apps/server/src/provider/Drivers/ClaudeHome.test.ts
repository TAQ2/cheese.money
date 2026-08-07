import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  effectiveClaudeHomePathSetting,
  ensureSharedClaudeMcpServers,
  ensureSharedClaudeTranscriptStore,
  ensureSharedClaudeUserAssets,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

// The repo bans raw JSON.parse/stringify in favour of schema codecs.
const toJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const fromJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("treats an explicit default config dir exactly like an empty setting", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        // The regression: `CLAUDE_CONFIG_DIR=~/.claude` makes the CLI look for
        // its config INSIDE that directory, while the default keeps it BESIDE,
        // in ~/.claude.json. Setting it explicitly therefore hides the signed-in
        // account and every thread fails with "Please run /login".
        const homePath = path.resolve(NodeOS.homedir(), ".claude");
        const emptyKey = yield* makeClaudeContinuationGroupKey({ homePath: "" });

        expect(yield* effectiveClaudeHomePathSetting({ homePath })).toBe("");
        expect(yield* effectiveClaudeHomePathSetting({ homePath: "~/.claude" })).toBe("");
        expect(yield* makeClaudeEnvironment({ homePath })).toBe(process.env);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(
          process.env.CLAUDE_CONFIG_DIR,
        );
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(emptyKey);
      }),
    );

    it.effect("keeps a genuinely custom home path untouched", () =>
      Effect.gen(function* () {
        expect(yield* effectiveClaudeHomePathSetting({ homePath: "~/.claude-work" })).toBe(
          "~/.claude-work",
        );
      }),
    );

    it.effect("points a profile's transcript store at the shared one, merging what it holds", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // NodeOS.homedir() honours $HOME on POSIX, so the whole exercise runs
        // in a temp directory and never touches the real ~/.claude.
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const profile = path.join(fakeHome, ".claude-work");
          // Mirrors the real layout: <config dir>/projects/<slug>/<uuid>.jsonl.
          const slug = "-Users-someone-Desktop-credit-risk";
          const transcript = "aaaaaaaa-0000-4000-8000-000000000001.jsonl";
          yield* fs.makeDirectory(path.join(profile, "projects", slug), { recursive: true });
          yield* fs.writeFileString(
            path.join(profile, "projects", slug, transcript),
            "started-on-the-work-account",
          );

          // A project folder holds more than transcripts: the CLI keeps a
          // `memory` directory in there too, and it exists on BOTH sides.
          // Skipping it left the source non-empty, which blocked the link and
          // silently left the profile with its own store.
          const shared0 = path.join(fakeHome, ".claude", "projects", slug);
          yield* fs.makeDirectory(path.join(shared0, "memory"), { recursive: true });
          yield* fs.writeFileString(path.join(shared0, "memory", "notes.md"), "shared note");
          yield* fs.makeDirectory(path.join(profile, "projects", slug, "memory"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(profile, "projects", slug, "memory", "work-only.md"),
            "work note",
          );

          yield* ensureSharedClaudeTranscriptStore({ homePath: profile });

          // The profile store is now a link to the default home's store, so a
          // conversation started under either account resolves under both.
          const shared = path.join(fakeHome, ".claude", "projects");
          expect(yield* fs.readLink(path.join(profile, "projects"))).toBe(shared);
          expect(yield* fs.exists(path.join(shared, slug, transcript))).toBe(true);
          expect(yield* fs.exists(path.join(profile, "projects", slug, transcript))).toBe(true);
          // Both sides' memory files survive the merge, neither overwritten.
          expect(yield* fs.exists(path.join(shared, slug, "memory", "notes.md"))).toBe(true);
          expect(yield* fs.exists(path.join(shared, slug, "memory", "work-only.md"))).toBe(true);
          expect(yield* fs.readFileString(path.join(shared, slug, "memory", "notes.md"))).toBe(
            "shared note",
          );

          // Idempotent: a rebuild must not disturb the link or re-migrate.
          yield* ensureSharedClaudeTranscriptStore({ homePath: profile });
          expect(yield* fs.readLink(path.join(profile, "projects"))).toBe(shared);
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("shares the skills the user wrote, and leaves absent kinds absent", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const profile = path.join(fakeHome, ".claude-work");
          yield* fs.makeDirectory(profile, { recursive: true });
          // A skill the user wrote, reachable only from the default home.
          yield* fs.makeDirectory(path.join(fakeHome, ".claude", "skills", "refresh"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(fakeHome, ".claude", "skills", "refresh", "SKILL.md"),
            "# refresh",
          );

          yield* ensureSharedClaudeUserAssets({ homePath: profile });

          // The profile now resolves it, so a skill invoked on one account
          // does not vanish on the next.
          expect(yield* fs.readLink(path.join(profile, "skills"))).toBe(
            path.join(fakeHome, ".claude", "skills"),
          );
          expect(yield* fs.exists(path.join(profile, "skills", "refresh", "SKILL.md"))).toBe(true);

          // Nothing has commands or agents, so neither side grows an empty
          // directory for them.
          expect(yield* fs.exists(path.join(profile, "commands"))).toBe(false);
          expect(yield* fs.exists(path.join(fakeHome, ".claude", "commands"))).toBe(false);

          // Idempotent.
          yield* ensureSharedClaudeUserAssets({ homePath: profile });
          expect(yield* fs.readLink(path.join(profile, "skills"))).toBe(
            path.join(fakeHome, ".claude", "skills"),
          );
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("shares the output styles the user wrote", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const profile = path.join(fakeHome, ".claude-work");
          yield* fs.makeDirectory(profile, { recursive: true });
          yield* fs.makeDirectory(path.join(fakeHome, ".claude", "output-styles"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(fakeHome, ".claude", "output-styles", "caveman.md"),
            "---\nname: Caveman\n---\n",
          );

          yield* ensureSharedClaudeUserAssets({ homePath: profile });

          // Without this the CLI reports only the built-in styles for the
          // profile, so the response-style picker silently omits every style
          // the user wrote.
          expect(yield* fs.readLink(path.join(profile, "output-styles"))).toBe(
            path.join(fakeHome, ".claude", "output-styles"),
          );
          expect(yield* fs.exists(path.join(profile, "output-styles", "caveman.md"))).toBe(true);
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("merges a profile's own skills into the shared set rather than losing them", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const profile = path.join(fakeHome, ".claude-work");
          yield* fs.makeDirectory(path.join(profile, "skills", "work-only"), { recursive: true });
          yield* fs.writeFileString(
            path.join(profile, "skills", "work-only", "SKILL.md"),
            "# work only",
          );
          yield* fs.makeDirectory(path.join(fakeHome, ".claude", "skills", "refresh"), {
            recursive: true,
          });

          yield* ensureSharedClaudeUserAssets({ homePath: profile });

          const shared = path.join(fakeHome, ".claude", "skills");
          expect(yield* fs.readLink(path.join(profile, "skills"))).toBe(shared);
          // Both survive: the profile's skill moved into the shared set.
          expect(yield* fs.exists(path.join(shared, "work-only", "SKILL.md"))).toBe(true);
          expect(yield* fs.exists(path.join(shared, "refresh"))).toBe(true);
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("carries the user's own MCP servers into a profile, without clobbering", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const profile = path.join(fakeHome, ".claude-work");
          yield* fs.makeDirectory(profile, { recursive: true });
          // The default home's config is BESIDE ~/.claude, the profile's is
          // INSIDE the profile directory.
          yield* fs.writeFileString(
            path.join(fakeHome, ".claude.json"),
            toJsonString({
              oauthAccount: { emailAddress: "someone@example.com" },
              mcpServers: {
                metabase: { type: "http", url: "https://metabase.example.com/mcp" },
                braze: { type: "http", url: "https://braze.example.com/mcp" },
              },
            }),
          );
          yield* fs.writeFileString(
            path.join(profile, ".claude.json"),
            toJsonString({
              oauthAccount: { emailAddress: "work@example.com" },
              mcpServers: {
                // Same name, different endpoint: the profile's own entry wins,
                // because its OAuth token is stored against that endpoint.
                braze: { type: "http", url: "https://braze-work.example.com/mcp" },
              },
            }),
          );

          yield* ensureSharedClaudeMcpServers({ homePath: profile });

          const merged = fromJsonString(
            yield* fs.readFileString(path.join(profile, ".claude.json")),
          ) as {
            oauthAccount: { emailAddress: string };
            mcpServers: Record<string, { url: string }>;
          };
          expect(Object.keys(merged.mcpServers).toSorted()).toEqual(["braze", "metabase"]);
          expect(merged.mcpServers["metabase"]?.url).toBe("https://metabase.example.com/mcp");
          expect(merged.mcpServers["braze"]?.url).toBe("https://braze-work.example.com/mcp");
          // The rest of the profile's config survives untouched — this file
          // holds the account the profile exists to keep separate.
          expect(merged.oauthAccount.emailAddress).toBe("work@example.com");

          // Idempotent: a rebuild changes nothing.
          const before = yield* fs.readFileString(path.join(profile, ".claude.json"));
          yield* ensureSharedClaudeMcpServers({ homePath: profile });
          expect(yield* fs.readFileString(path.join(profile, ".claude.json"))).toBe(before);
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("writes no config for a profile the CLI has never run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const profile = path.join(fakeHome, ".claude-fresh");
          yield* fs.makeDirectory(profile, { recursive: true });
          yield* fs.writeFileString(
            path.join(fakeHome, ".claude.json"),
            toJsonString({ mcpServers: { metabase: { type: "http", url: "https://x/mcp" } } }),
          );

          yield* ensureSharedClaudeMcpServers({ homePath: profile });

          // A config this side never wrote would read as "not logged in".
          expect(yield* fs.exists(path.join(profile, ".claude.json"))).toBe(false);
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("leaves the default home alone and survives an unreadable config", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const defaultConfig = path.join(fakeHome, ".claude.json");
          yield* fs.writeFileString(
            defaultConfig,
            toJsonString({ mcpServers: { metabase: { type: "http", url: "https://x/mcp" } } }),
          );
          // The default home is where those servers already live.
          yield* ensureSharedClaudeMcpServers({ homePath: "" });
          yield* ensureSharedClaudeMcpServers({ homePath: path.join(fakeHome, ".claude") });

          const profile = path.join(fakeHome, ".claude-broken");
          yield* fs.makeDirectory(profile, { recursive: true });
          yield* fs.writeFileString(path.join(profile, ".claude.json"), "{ not json");
          yield* ensureSharedClaudeMcpServers({ homePath: profile });

          expect(yield* fs.readFileString(path.join(profile, ".claude.json"))).toBe("{ not json");
          expect(yield* fs.exists(`${path.join(profile, ".claude.json")}.ch3-mcp-merge`)).toBe(
            false,
          );
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("sets a genuine collision aside rather than abandoning the link", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const profile = path.join(fakeHome, ".claude-work");
          const slug = "-Users-someone-Desktop-credit-risk";
          const clash = "aaaaaaaa-0000-4000-8000-000000000001.jsonl";
          // The same filename on both sides with different content: the shared
          // copy wins, and the profile's copy must survive somewhere.
          yield* fs.makeDirectory(path.join(fakeHome, ".claude", "projects", slug), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(fakeHome, ".claude", "projects", slug, clash),
            "shared",
          );
          yield* fs.makeDirectory(path.join(profile, "projects", slug), { recursive: true });
          yield* fs.writeFileString(path.join(profile, "projects", slug, clash), "profile");

          yield* ensureSharedClaudeTranscriptStore({ homePath: profile });

          const shared = path.join(fakeHome, ".claude", "projects");
          // Sharing is switched on regardless — leaving the directory in place
          // would silently disable it.
          expect(yield* fs.readLink(path.join(profile, "projects"))).toBe(shared);
          expect(yield* fs.readFileString(path.join(shared, slug, clash))).toBe("shared");
          // Nothing was destroyed: the losing copy is set aside intact.
          expect(
            yield* fs.readFileString(path.join(`${profile}/projects.unmerged`, slug, clash)),
          ).toBe("profile");
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("leaves the default home's own store alone", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped();
        const realHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          // Empty homePath already IS the shared store — linking it to itself
          // would be a loop.
          yield* ensureSharedClaudeTranscriptStore({ homePath: "" });
          const store = path.join(fakeHome, ".claude", "projects");
          expect(yield* fs.readLink(store).pipe(Effect.orElseSucceed(() => ""))).toBe("");
        } finally {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }
      }).pipe(Effect.scoped),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });
});
