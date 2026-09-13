// @effect-diagnostics nodeBuiltinImport:off - The point of this test is to run
// the generated resolver the way the shim does: a bare node process reading a
// real file, outside any Effect runtime.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { resolveClaudeInstanceHomePath } from "../provider/Drivers/claudeInstanceHome.ts";
import {
  CLAUDE_ACCOUNT_PROBE_FILENAME,
  claudeAccountProbeScript,
  claudeAccountResolverScript,
  claudeShimPathLine,
  claudeShimScript,
  installClaudeAccountShim,
  resolveTerminalShimPathLine,
  withClaudeAccountShimOnPath,
} from "./claudeAccountShim.ts";

/**
 * The ambient environment minus the variables the launcher itself owns.
 *
 * Every one of these is something CH3 sets on the agents it spawns, so a
 * suite run from inside one inherits the very switches under test: "the
 * account left this tool alone" then reads as "switched off" for a reason
 * nothing in this file chose. Whether the launcher sets them is the whole
 * question, so the harness must not answer it first.
 */
function launcherBaseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const owned of [
    "CLAUDE_CODE_DISABLE_ARTIFACT",
    "ENABLE_CLAUDEAI_MCP_SERVERS",
    "CLAUDE_CONFIG_DIR",
  ]) {
    delete env[owned];
  }
  return env;
}

/** Run the generated resolver exactly as the shim does: a bare node process. */
function runResolverRaw(settings: unknown, options: { readonly raw?: string } = {}): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-shim-"));
  try {
    const settingsPath = NodePath.join(dir, "settings.json");
    NodeFS.writeFileSync(settingsPath, options.raw ?? JSON.stringify(settings));
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

/** Line 1: the account. What every test below this line reads. */
function runResolver(settings: unknown, options: { readonly raw?: string } = {}): string {
  return (runResolverRaw(settings, options).split("\n")[0] ?? "").trim();
}

/** Line 2: the session tools to switch off, as the launcher reads them. */
function runResolverSessionTools(settings: unknown): string {
  return (runResolverRaw(settings).split("\n")[1] ?? "").trim();
}

const instance = (homePath: string | undefined, over: Record<string, unknown> = {}) => ({
  driver: "claudeAgent",
  enabled: true,
  ...(homePath === undefined ? { config: {} } : { config: { homePath } }),
  ...over,
});

describe("the shim's account resolver", () => {
  it("prints the app's recorded binary on the third line", () => {
    const raw = runResolverRaw({
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          enabled: true,
          config: { binaryPath: "/somewhere/.local/bin/claude" },
        },
      },
    });
    expect(raw.split("\n")[2]).toBe("/somewhere/.local/bin/claude");
  });

  it("leaves the third line empty when no binary was ever recorded", () => {
    const raw = runResolverRaw({ providerInstances: { claudeAgent: instance("~/.claude-1") } });
    expect((raw.split("\n")[2] ?? "").trim()).toBe("");
  });

  it("prints the selected account's directory", () => {
    const home = NodeOS.homedir();
    expect(runResolver({ providerInstances: { claudeAgent: instance("~/.claude-3") } })).toBe(
      NodePath.join(home, ".claude-3"),
    );
  });

  it("says `default` when the default home is selected", () => {
    // The CLI expects CLAUDE_CONFIG_DIR UNSET for the default home, so the
    // shim must unset rather than export ~/.claude. It is a spoken answer, not
    // silence, because silence is what "I could not tell" means.
    expect(runResolver({ providerInstances: { claudeAgent: instance(undefined) } })).toBe(
      "default",
    );
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
    expect(runResolver({ providers: { claudeAgent: { homePath: "~/.claude-work" } } })).toBe(
      NodePath.join(home, ".claude-work"),
    );
  });

  it("fails loudly rather than answering `default` on unreadable settings", () => {
    // The distinction this pins is the whole point: an unreadable settings file
    // must NOT look like "use the default account". When those two answers were
    // both silence, a resolver that could not read the settings silently moved
    // a running terminal onto the default account and burned the wrong plan.
    expect(() => runResolver(null, { raw: "{ not json" })).toThrow();
    // A settings file that is valid JSON but holds no Claude instance is a
    // real answer — the default account — not a failure.
    expect(runResolver({})).toBe("default");
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
        legacyHomePath: (
          settings as never as { providers?: { claudeAgent?: { homePath?: string } } }
        ).providers?.claudeAgent?.homePath,
      });
      const expected =
        app.trim().length === 0
          ? "default"
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

describe("the account probe", () => {
  /** Runs the real probe against a real resolver over the given settings. */
  const probe = (settings: unknown): { readonly output: string; readonly status: number } => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-probe-"));
    try {
      const settingsPath = NodePath.join(dir, "settings.json");
      NodeFS.writeFileSync(settingsPath, JSON.stringify(settings));
      const resolverPath = NodePath.join(dir, "resolve.cjs");
      NodeFS.writeFileSync(resolverPath, claudeAccountResolverScript(settingsPath));
      const probePath = NodePath.join(dir, CLAUDE_ACCOUNT_PROBE_FILENAME);
      NodeFS.writeFileSync(
        probePath,
        claudeAccountProbeScript({ nodePath: process.execPath, resolverPath }),
      );
      const run = NodeChildProcess.spawnSync("sh", [probePath], { encoding: "utf8" });
      return { output: run.stdout, status: run.status ?? -1 };
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("prints the selected directory, and only that", () => {
    const { output, status } = probe({
      providerInstances: { claudeAgent: instance("~/.claude-3") },
    });
    expect(status).toBe(0);
    expect(output).toBe(`${NodePath.join(NodeOS.homedir(), ".claude-3")}\n`);
  });

  it("says `default` for the default home, the same word the launcher reads", () => {
    const { output, status } = probe({ providerInstances: { claudeAgent: instance(undefined) } });
    expect(status).toBe(0);
    expect(output).toBe("default\n");
  });

  it("answers nothing, non-zero, when the account cannot be read", () => {
    // Two probes that both fail must not look like a switch to a caller
    // comparing them, so failure is silence, never a word.
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-probe-"));
    try {
      const probePath = NodePath.join(dir, CLAUDE_ACCOUNT_PROBE_FILENAME);
      NodeFS.writeFileSync(
        probePath,
        claudeAccountProbeScript({
          nodePath: process.execPath,
          resolverPath: NodePath.join(dir, "missing.cjs"),
        }),
      );
      const run = NodeChildProcess.spawnSync("sh", [probePath], { encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stdout).toBe("");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

it.layer(NodeServices.layer)("installing the shim", (it) => {
  const install = (platform: string) =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-shim-install-"));
      const shimDir = NodePath.join(dir, "bin");
      const written = yield* installClaudeAccountShim({
        shimDir,
        settingsPath: NodePath.join(dir, "settings.json"),
        nodePath: process.execPath,
        platform,
      });
      return { dir, shimDir, written };
    });

  it.effect("writes an executable launcher and its resolver", () =>
    Effect.gen(function* () {
      const { dir, shimDir, written } = yield* install("darwin");
      try {
        expect(written).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(shimDir, "claude"))).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(shimDir, "resolve-account.cjs"))).toBe(true);
        const probePath = NodePath.join(shimDir, CLAUDE_ACCOUNT_PROBE_FILENAME);
        expect(NodeFS.existsSync(probePath)).toBe(true);
        expect(NodeFS.statSync(probePath).mode & 0o111).not.toBe(0);
        // Not executable means the PATH entry resolves to a file the shell
        // refuses to run, which reads to the user as "claude is broken".
        expect(NodeFS.statSync(NodePath.join(shimDir, "claude")).mode & 0o111).not.toBe(0);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes nothing on Windows, where a POSIX launcher would not run", () =>
    Effect.gen(function* () {
      const { dir, shimDir, written } = yield* install("win32");
      try {
        expect(written).toBe(false);
        expect(NodeFS.existsSync(shimDir)).toBe(false);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});

describe("the session tools the shim switches off", () => {
  const claudeInstance = (config: Record<string, unknown>) => ({
    providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: true, config } },
  });

  it("switches all three off for an account that has never been configured", () => {
    // The shipped default. A tool costs its definition in every session
    // whether or not anybody calls it, and nobody here asked for these.
    expect(runResolverSessionTools(claudeInstance({}))).toBe(
      "artifact:off chrome:off connectors:off",
    );
  });

  it("asks for nothing once all three are switched back on", () => {
    expect(
      runResolverSessionTools(
        claudeInstance({
          artifactToolEnabled: true,
          chromeIntegrationEnabled: true,
          claudeAiConnectorsEnabled: true,
        }),
      ),
    ).toBe("");
  });

  it("switches on exactly the one that was asked for", () => {
    expect(runResolverSessionTools(claudeInstance({ chromeIntegrationEnabled: true }))).toBe(
      "artifact:off connectors:off",
    );
  });

  it("reads the switches off the account the app presents as selected", () => {
    // The account line and the tool line must come from the same instance, or
    // a person would be editing one account's switches and watching another
    // account's session ignore them.
    const settings = {
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          enabled: true,
          config: { homePath: "~/.claude-1", artifactToolEnabled: true },
        },
        other: {
          driver: "claudeAgent",
          enabled: true,
          config: { homePath: "~/.claude-2" },
        },
      },
    };
    expect(runResolver(settings)).toBe(NodePath.join(NodeOS.homedir(), ".claude-1"));
    expect(runResolverSessionTools(settings)).toBe("chrome:off connectors:off");
  });

  it("asks for nothing when the settings cannot be read", () => {
    // The resolver exits non-zero and prints nothing, so the launcher has no
    // second line to read. Silence has to leave the CLI as it was: guessing
    // "off" here would change a session because a file was briefly unreadable.
    expect(runResolverSessionTools.bind(null, undefined)).toThrow();
  });
});

describe("the account and its switches come from one instance", () => {
  // The bug this pins: the account is the first instance with a homePath, but
  // the switches used to be read off the FIRST instance. An instance with no
  // homePath means the default home, so the account loop walks past it — and
  // the two answers then come from different accounts. A person edits the
  // account they are using and every terminal ignores them.
  const noHome = {
    driver: "claudeAgent",
    enabled: true,
    config: {
      artifactToolEnabled: true,
      chromeIntegrationEnabled: true,
      claudeAiConnectorsEnabled: true,
    },
  };
  const withHome = {
    driver: "claudeAgent",
    enabled: true,
    config: { homePath: "~/.claude-work" },
  };

  it("reads the switches off the account it selected, not off the first one", () => {
    const settings = { providerInstances: { claudeAgent: noHome, "claude-work": withHome } };
    expect(runResolver(settings)).toBe(NodePath.join(NodeOS.homedir(), ".claude-work"));
    // The selected account switched nothing on, so everything stays off —
    // whatever the instance the loop walked past happens to say.
    expect(runResolverSessionTools(settings)).toBe("artifact:off chrome:off connectors:off");
  });

  it("honours the switches when the account with a home is the one that set them", () => {
    const settings = {
      providerInstances: {
        claudeAgent: noHome,
        "claude-work": {
          ...withHome,
          config: { homePath: "~/.claude-work", chromeIntegrationEnabled: true },
        },
      },
    };
    expect(runResolverSessionTools(settings)).toBe("artifact:off connectors:off");
  });
});

describe("the shim end to end, both halves generated", () => {
  /**
   * The seam neither suite covered: the real resolver reading a real
   * settings.json, feeding the real launcher. The resolver tests read line two
   * in JavaScript; the launcher tests hand it a canned answer. A defect that
   * lives in the join between them — which is exactly where two have been —
   * shows up only here.
   */
  function runInstalled(config: Record<string, unknown>): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-e2e-"));
    try {
      const shimDir = NodePath.join(dir, "shim");
      const binDir = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(shimDir);
      NodeFS.mkdirSync(binDir);

      const settingsPath = NodePath.join(dir, "settings.json");
      NodeFS.writeFileSync(
        settingsPath,
        JSON.stringify({
          providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: true, config } },
        }),
      );

      const realClaude = NodePath.join(binDir, "claude");
      NodeFS.writeFileSync(
        realClaude,
        `#!/bin/sh
if [ "$1" = "--help" ]; then echo "  --no-chrome Disable"; exit 0; fi
echo "ARGS=$*"
echo "ARTIFACT=\${CLAUDE_CODE_DISABLE_ARTIFACT:-unset}"
echo "CONNECTORS=\${ENABLE_CLAUDEAI_MCP_SERVERS:-unset}"
echo "CONFIG_DIR=\${CLAUDE_CONFIG_DIR:-unset}"
`,
      );
      NodeFS.chmodSync(realClaude, 0o755);

      const resolverPath = NodePath.join(shimDir, "resolve.cjs");
      NodeFS.writeFileSync(resolverPath, claudeAccountResolverScript(settingsPath));
      const launcherPath = NodePath.join(shimDir, "claude");
      NodeFS.writeFileSync(
        launcherPath,
        claudeShimScript({ shimDir, nodePath: process.execPath, resolverPath }),
      );
      NodeFS.chmodSync(launcherPath, 0o755);

      return NodeChildProcess.execFileSync(launcherPath, ["chat"], {
        encoding: "utf8",
        env: {
          ...launcherBaseEnv(),
          ELECTRON_RUN_AS_NODE: "1",
          PATH: `${shimDir}:${binDir}:/usr/bin:/bin`,
        },
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("carries a default account's switched-off tools all the way to the binary", () => {
    const output = runInstalled({});
    expect(output).toContain("ARGS=--no-chrome chat");
    expect(output).toContain("ARTIFACT=1");
    expect(output).toContain("CONNECTORS=false");
    // The default home wants the variable UNSET, and the second line must not
    // have leaked into it.
    expect(output).toContain("CONFIG_DIR=unset");
  });

  it("carries a switch the person turned back on", () => {
    const output = runInstalled({ chromeIntegrationEnabled: true, artifactToolEnabled: true });
    expect(output).toContain("ARGS=chat");
    expect(output).toContain("ARTIFACT=unset");
    expect(output).toContain("CONNECTORS=false");
  });

  it("still exports the account beside the switches", () => {
    const output = runInstalled({ homePath: "~/.claude-1" });
    expect(output).toContain(`CONFIG_DIR=${NodePath.join(NodeOS.homedir(), ".claude-1")}`);
    expect(output).toContain("ARTIFACT=1");
  });
});

describe("the launcher, run for real", () => {
  /**
   * Build a sandbox and run the generated shim in it: a fake `claude` that
   * reports what it was handed, and a fake resolver that answers whatever the
   * test wants. String assertions on the script prove the text; this proves
   * the behaviour, which is the part a person feels.
   */
  function runLauncher(input: {
    readonly sessionTools: string;
    readonly advertisesNoChrome: boolean;
    readonly args?: readonly string[];
    /** Third resolver line: a binary that exists, or a path that does not. */
    readonly configuredBinary?: "exists" | "missing";
    /** When false, the PATH carries no `claude` at all — a fresh machine. */
    readonly pathHasClaude?: boolean;
  }): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-launcher-"));
    try {
      const shimDir = NodePath.join(dir, "shim");
      const binDir = NodePath.join(dir, "bin");
      NodeFS.mkdirSync(shimDir);
      NodeFS.mkdirSync(binDir);

      const fakeClaudeBody = `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "  --chrome    Enable"
${input.advertisesNoChrome ? '  echo "  --no-chrome Disable"' : "  :"}
  exit 0
fi
echo "BIN=$0"
echo "ARGS=$*"
echo "ARTIFACT=\${CLAUDE_CODE_DISABLE_ARTIFACT:-unset}"
echo "CONNECTORS=\${ENABLE_CLAUDEAI_MCP_SERVERS:-unset}"
`;
      const realClaude = NodePath.join(binDir, "claude");
      if (input.pathHasClaude !== false) {
        NodeFS.writeFileSync(realClaude, fakeClaudeBody);
        NodeFS.chmodSync(realClaude, 0o755);
      }
      // The binary the resolver's third line names, when the test wants one.
      const configuredDir = NodePath.join(dir, "configured");
      const configuredClaude = NodePath.join(configuredDir, "claude");
      if (input.configuredBinary === "exists") {
        NodeFS.mkdirSync(configuredDir);
        NodeFS.writeFileSync(configuredClaude, fakeClaudeBody);
        NodeFS.chmodSync(configuredClaude, 0o755);
      }
      const thirdLine = input.configuredBinary === undefined ? "" : `\n${configuredClaude}`;

      // The resolver is a node script in production; here it only has to
      // print the lines the launcher reads.
      const resolverPath = NodePath.join(shimDir, "resolve.cjs");
      NodeFS.writeFileSync(
        resolverPath,
        `process.stdout.write("default\\n" + ${JSON.stringify(input.sessionTools)} + ${JSON.stringify(thirdLine)});`,
      );

      const launcherPath = NodePath.join(shimDir, "claude");
      NodeFS.writeFileSync(
        launcherPath,
        claudeShimScript({ shimDir, nodePath: process.execPath, resolverPath }),
      );
      NodeFS.chmodSync(launcherPath, 0o755);

      return NodeChildProcess.execFileSync(launcherPath, [...(input.args ?? ["chat"])], {
        encoding: "utf8",
        env: { ...launcherBaseEnv(), PATH: `${shimDir}:${binDir}:/usr/bin:/bin` },
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("switches the tools off through the environment and the flag", () => {
    const output = runLauncher({
      sessionTools: "artifact:off chrome:off connectors:off",
      advertisesNoChrome: true,
    });
    expect(output).toContain("ARGS=--no-chrome chat");
    expect(output).toContain("ARTIFACT=1");
    expect(output).toContain("CONNECTORS=false");
  });

  it("leaves every tool alone when the account has switched them on", () => {
    const output = runLauncher({ sessionTools: "", advertisesNoChrome: true });
    expect(output).toContain("ARGS=chat");
    expect(output).toContain("ARTIFACT=unset");
    expect(output).toContain("CONNECTORS=unset");
  });

  it("prefers the binary the app recorded over the one on PATH", () => {
    // The installer may have just upgraded into ~/.local/bin while an older
    // copy still shadows it on this shell's PATH. The driver runs the recorded
    // binary; a terminal or an orchestrator run must not run a different one.
    const output = runLauncher({
      sessionTools: "",
      advertisesNoChrome: true,
      configuredBinary: "exists",
    });
    expect(output).toContain(`${NodePath.sep}configured${NodePath.sep}claude`);
    expect(output).toContain("ARGS=chat");
  });

  it("runs the recorded binary on a machine whose PATH has no claude at all", () => {
    // The orchestrator on a fresh machine: CH3 installed Claude Code into
    // ~/.local/bin — on no GUI PATH anywhere — and recorded the path. The old
    // launcher exited 127 here and the run died before its first event.
    const output = runLauncher({
      sessionTools: "",
      advertisesNoChrome: true,
      configuredBinary: "exists",
      pathHasClaude: false,
    });
    expect(output).toContain(`${NodePath.sep}configured${NodePath.sep}claude`);
    expect(output).toContain("ARGS=chat");
  });

  it("falls back to PATH when the recorded binary is gone", () => {
    // A recorded path can go stale — the person deleted ~/.local/bin, or the
    // settings moved machines. A missing file must not beat a working PATH.
    const output = runLauncher({
      sessionTools: "",
      advertisesNoChrome: true,
      configuredBinary: "missing",
    });
    expect(output).toContain(`${NodePath.sep}bin${NodePath.sep}claude`);
    expect(output).toContain("ARGS=chat");
  });

  it("withholds --no-chrome from a CLI that has never heard of it", () => {
    // The failure this prevents is the worst kind: an unknown flag is an error
    // before the session starts, so a default nobody chose would break every
    // terminal on a machine with an older CLI. The environment variables still
    // apply — an older CLI ignores a variable it does not read.
    const output = runLauncher({
      sessionTools: "artifact:off chrome:off connectors:off",
      advertisesNoChrome: false,
    });
    expect(output).toContain("ARGS=chat");
    expect(output).not.toContain("--no-chrome");
    expect(output).toContain("ARTIFACT=1");
  });

  it("keeps the caller's own arguments, and puts the flag before them", () => {
    const output = runLauncher({
      sessionTools: "chrome:off",
      advertisesNoChrome: true,
      args: ["--model", "opus", "--chrome"],
    });
    // The person's explicit --chrome comes last and wins, which is how a
    // switched-off default should behave when somebody overrides it by hand.
    expect(output).toContain("ARGS=--no-chrome --model opus --chrome");
  });
});

describe("the shell line the account panel shows", () => {
  it("puts the shim ahead of everything already on PATH", () => {
    // Behind an existing entry the real `claude` wins and the line does
    // nothing, silently — the failure this whole mechanism exists to prevent.
    expect(claudeShimPathLine("/Users/someone/.ch3/bin")).toBe(
      'export PATH="/Users/someone/.ch3/bin:$PATH"',
    );
  });
});

it.layer(NodeServices.layer)("the line the account panel is given", (it) => {
  const withShimDir = <A, R>(
    run: (input: { shimDir: string; settingsPath: string }) => Effect.Effect<A, never, R>,
  ) =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-shim-line-"));
      try {
        return yield* run({
          shimDir: NodePath.join(dir, "bin"),
          settingsPath: NodePath.join(dir, "settings.json"),
        });
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });

  it.effect("installs the shim and points at it", () =>
    withShimDir(({ shimDir, settingsPath }) =>
      Effect.gen(function* () {
        const line = yield* resolveTerminalShimPathLine({
          shimDir,
          settingsPath,
          nodePath: process.execPath,
          platform: "darwin",
        });

        // The panel's advice and the file it refers to arrive together, or not
        // at all: a PATH entry with no runnable `claude` in it reads to the
        // user as a broken terminal.
        expect(line).toBe(`export PATH="${shimDir}:$PATH"`);
        expect(NodeFS.existsSync(NodePath.join(shimDir, "claude"))).toBe(true);
      }),
    ),
  );

  it.effect("says nothing on Windows, where the launcher would not run", () =>
    withShimDir(({ shimDir, settingsPath }) =>
      Effect.gen(function* () {
        const line = yield* resolveTerminalShimPathLine({
          shimDir,
          settingsPath,
          nodePath: process.execPath,
          platform: "win32",
        });

        expect(line).toBeNull();
        expect(NodeFS.existsSync(shimDir)).toBe(false);
      }),
    ),
  );

  it.effect("says nothing when the shim cannot be written", () =>
    withShimDir(({ settingsPath }) =>
      Effect.gen(function* () {
        // A path under a regular file: `mkdir -p` cannot make this, which is
        // the shape of an unwritable home rather than a contrived error.
        const blocker = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ch3-shim-block-"));
        const file = NodePath.join(blocker, "not-a-directory");
        NodeFS.writeFileSync(file, "");
        const line = yield* resolveTerminalShimPathLine({
          shimDir: NodePath.join(file, "bin"),
          settingsPath,
          nodePath: process.execPath,
          platform: "darwin",
        });
        NodeFS.rmSync(blocker, { recursive: true, force: true });

        expect(line).toBeNull();
      }),
    ),
  );
});

it("puts the shim first on PATH and drops an inherited config dir", () => {
  // What an orchestrator run inherits decides which Claude account its agents
  // spend. Inheriting the app's own environment ran a whole multi-repo run on
  // the default account — the one nobody selected — and every call failed on
  // that account's weekly limit while the selected account sat idle.
  const env = withClaudeAccountShimOnPath(
    {
      PATH: "/opt/homebrew/bin:/usr/bin",
      CLAUDE_CONFIG_DIR: "/Users/someone/.claude-3",
      HOME: "/Users/someone",
    },
    "/Users/someone/.ch3/userdata/bin",
  );

  expect(env.PATH).toBe("/Users/someone/.ch3/userdata/bin:/opt/homebrew/bin:/usr/bin");
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.HOME).toBe("/Users/someone");
});

it("drops a differently-cased config dir too", () => {
  // Case-insensitive on Windows: the same variable to the CLI, a different key
  // here. Left behind, the stale one outranks the shim's choice.
  const env = withClaudeAccountShimOnPath(
    { Claude_Config_Dir: "/Users/someone/.claude-9", PATH: "/usr/bin" },
    "/shim",
  );

  expect(Object.keys(env).some((key) => key.toUpperCase() === "CLAUDE_CONFIG_DIR")).toBe(false);
  expect(env.PATH).toBe("/shim:/usr/bin");
});

it("still sets PATH when the environment had none", () => {
  const empty: Record<string, string | undefined> = {};
  expect(withClaudeAccountShimOnPath(empty, "/shim").PATH).toBe("/shim");
});
