// @effect-diagnostics nodeBuiltinImport:off - The point of this test is to run
// the generated resolver the way the shim does: a bare node process reading a
// real file, outside any Effect runtime.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { resolveClaudeInstanceHomePath } from "../provider/Drivers/claudeInstanceHome.ts";
import { claudeAccountResolverScript, claudeShimScript } from "./claudeAccountShim.ts";

/** Run the generated resolver exactly as the shim does: a bare node process. */
function runResolver(settings: unknown): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-shim-"));
  try {
    const settingsPath = NodePath.join(dir, "settings.json");
    NodeFS.writeFileSync(settingsPath, JSON.stringify(settings));
    const scriptPath = NodePath.join(dir, "resolve.cjs");
    NodeFS.writeFileSync(scriptPath, claudeAccountResolverScript(settingsPath));
    return NodeChildProcess.execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }).trim();
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

const instance = (homePath: string | undefined, over: Record<string, unknown> = {}) => ({
  driver: "claudeAgent",
  enabled: true,
  ...(homePath === undefined ? { config: {} } : { config: { homePath } }),
  ...over,
});

describe("the shim's account resolver", () => {
  it("prints the selected account's directory", () => {
    const home = NodeOS.homedir();
    expect(runResolver({ providerInstances: { claudeAgent: instance("~/.claude-3") } })).toBe(
      NodePath.join(home, ".claude-3"),
    );
  });

  it("prints nothing when the default home is selected", () => {
    // The CLI expects CLAUDE_CONFIG_DIR UNSET for the default home, so the
    // shim must have nothing to export rather than ~/.claude.
    expect(runResolver({ providerInstances: { claudeAgent: instance(undefined) } })).toBe("");
  });

  it("prefers an enabled instance over a disabled one", () => {
    const home = NodeOS.homedir();
    expect(
      runResolver({
        providerInstances: {
          "claudeAgent-2": instance("~/.claude-2", { enabled: false }),
          other: instance("~/.claude-9"),
        },
      }),
    ).toBe(NodePath.join(home, ".claude-9"));
  });

  it("falls back to the legacy block only when no instance exists", () => {
    const home = NodeOS.homedir();
    expect(
      runResolver({ providers: { claudeAgent: { homePath: "~/.claude-work" } } }),
    ).toBe(NodePath.join(home, ".claude-work"));
  });

  it("prints nothing rather than failing on unreadable settings", () => {
    expect(runResolver("not-an-object")).toBe("");
  });

  it("agrees with the app's own resolution rule", () => {
    // The shim re-implements the rule because it runs as a bare script with no
    // bundler. This is the guard against the two drifting apart.
    const cases = [
      { providerInstances: { claudeAgent: instance("~/.claude-3") } },
      { providerInstances: { claudeAgent: instance(undefined) } },
      {
        providerInstances: {
          "claudeAgent-2": instance("~/.claude-2", { enabled: false }),
          other: instance("~/.claude-9"),
        },
      },
      { providers: { claudeAgent: { homePath: "~/.claude-work" } } },
    ];
    for (const settings of cases) {
      const app = resolveClaudeInstanceHomePath({
        providerInstances: (settings as never as { providerInstances?: never }).providerInstances,
        legacyHomePath: (settings as never as { providers?: { claudeAgent?: { homePath?: string } } })
          .providers?.claudeAgent?.homePath,
      });
      const expected =
        app.trim().length === 0
          ? ""
          : NodePath.resolve(
              app.startsWith("~") ? NodePath.join(NodeOS.homedir(), app.slice(1)) : app,
            );
      expect(runResolver(settings)).toBe(expected);
    }
  });
});

describe("the shim launcher", () => {
  const script = claudeShimScript({
    shimDir: "/tmp/shim",
    nodePath: "/opt/node",
    resolverPath: "/tmp/shim/resolve.cjs",
  });

  it("strips its own directory from PATH so it cannot find itself", () => {
    expect(script).toContain('awk -v d="$shim_dir"');
    expect(script).toContain('PATH="$clean_path" command -v claude');
  });

  it("unsets the variable when the default home is selected", () => {
    expect(script).toContain("unset CLAUDE_CONFIG_DIR");
  });

  it("execs the real binary with the caller's arguments", () => {
    expect(script).toContain('exec "$real_claude" "$@"');
  });

  it("fails loudly when no real claude exists, rather than silently doing nothing", () => {
    expect(script).toContain("exit 127");
  });
});
