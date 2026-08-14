// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off - Host-side dev-stack orchestration drives Node subprocesses, timers, and HTTP probes directly.

/**
 * Boot (or attach to) the CH3 dev stack for a visual run, and mint the auth
 * credential the browser needs.
 *
 * Two facts drive every decision here:
 *
 * 1. `dev-runner` picks its own ports (base + hashed instance offset, then a
 *    free-port scan), so the ports are only knowable from its own startup
 *    line. Nothing here assumes 5733/13773.
 * 2. The pairing token printed at server startup is one-time — consumed by the
 *    first browser that visits `/pair`. Re-reading it from the log is therefore
 *    a trap. `ch3 auth pairing create` mints a fresh one against the same state
 *    directory any number of times, which is what this module uses.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export interface DevStackAddress {
  readonly serverPort: number;
  readonly webPort: number;
  readonly homeDir: string;
}

export interface DevStack {
  readonly webUrl: string;
  /** Where the running instance keeps `state.sqlite` (null when unknown). */
  readonly stateDir: string | null;
  /** True when this process started the stack and must tear it down. */
  readonly owned: boolean;
  readonly logPath: string | null;
  readonly stop: () => Promise<void>;
}

/** The line `dev-runner` logs before spawning Vite+ — the only source of truth for the ports. */
const DEV_RUNNER_ADDRESS_PATTERN =
  /\[dev-runner\].*serverPort=(?<server>\d+) webPort=(?<web>\d+) baseDir=(?<baseDir>.+?)\s*$/m;

export function parseDevRunnerAddress(output: string): DevStackAddress | null {
  const match = DEV_RUNNER_ADDRESS_PATTERN.exec(output);
  const groups = match?.groups;
  if (!groups) return null;
  const { server, web, baseDir } = groups;
  if (server === undefined || web === undefined || baseDir === undefined) return null;
  const serverPort = Number.parseInt(server, 10);
  const webPort = Number.parseInt(web, 10);
  if (!Number.isFinite(serverPort) || !Number.isFinite(webPort)) return null;
  return { serverPort, webPort, homeDir: baseDir.trim() };
}

export function parsePairingCredential(output: string): string {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error(`\`ch3 auth pairing create\` returned no JSON:\n${output}`);
  }
  const parsed = JSON.parse(output.slice(start, end + 1)) as { readonly credential?: unknown };
  if (typeof parsed.credential !== "string" || parsed.credential.length === 0) {
    throw new Error(`\`ch3 auth pairing create\` returned no credential:\n${output}`);
  }
  return parsed.credential;
}

/**
 * Which CLI flags reach a given state directory.
 *
 * `deriveServerPaths` puts state in `<baseDir>/userdata` whenever a base dir is
 * explicit (`--base-dir` *or* an ambient `CH3CODE_HOME`), and in `<baseDir>/dev`
 * only for a dev server that was given neither. So a `.../userdata` state dir is
 * reachable with `--base-dir <parent>`, and the default `~/.ch3/dev` is reachable
 * only by passing no base dir at all plus a `--dev-url`. Anything else (a `dev`
 * state dir under a non-default home) is unreachable, and the caller must be
 * told rather than handed a token minted against the wrong database.
 */
export function pairingCliArguments(input: {
  readonly stateDir: string;
  readonly webUrl: string;
  readonly defaultHomeDir?: string;
}): ReadonlyArray<string> | null {
  const stateDir = NodePath.resolve(input.stateDir);
  const parent = NodePath.dirname(stateDir);
  const leaf = NodePath.basename(stateDir);
  if (leaf === "userdata") {
    return ["--base-dir", parent];
  }
  const defaultHome = NodePath.resolve(
    input.defaultHomeDir ?? NodePath.join(NodeOS.homedir(), ".ch3"),
  );
  if (leaf === "dev" && parent === defaultHome) {
    return ["--dev-url", input.webUrl];
  }
  return null;
}

async function commandOutput(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${String(code)}:\n${stderr}`));
    });
  });
}

/**
 * Mint a fresh single-use pairing credential against the instance's own state
 * directory. Safe to call on every run: the credential this issues is
 * independent of the (already consumed) one printed at server startup.
 */
export async function issuePairingCredential(input: {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly webUrl: string;
}): Promise<string> {
  const locationArgs = pairingCliArguments({ stateDir: input.stateDir, webUrl: input.webUrl });
  if (!locationArgs) {
    throw new Error(
      `Cannot mint a pairing credential for state dir ${input.stateDir}: the CH3 CLI can only address ` +
        `'<home>/userdata' (via --base-dir <home>) or the default '~/.ch3/dev' (via --dev-url). ` +
        `Re-run the stack with --home-dir, or pair the browser once by hand.`,
    );
  }
  // CH3CODE_HOME/VITE_DEV_SERVER_URL inherited from an ambient dev shell would
  // silently redirect the CLI at a different database than the flags name.
  const env: NodeJS.ProcessEnv = { ...NodeProcess.env, NO_COLOR: "1" };
  delete env.CH3CODE_HOME;
  delete env.VITE_DEV_SERVER_URL;
  const output = await commandOutput(
    NodeProcess.execPath,
    ["apps/server/src/bin.ts", "auth", "pairing", "create", ...locationArgs, "--json"],
    { cwd: input.repoRoot, env },
  );
  return parsePairingCredential(output);
}

async function probe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    // Any answer proves the listener is up; 401/302 are expected before pairing.
    return response.status > 0;
  } catch {
    return false;
  }
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** `<homeDir>/userdata` once the server has created it. */
async function resolveStateDir(homeDir: string, timeoutMs: number): Promise<string> {
  const stateDir = NodePath.join(homeDir, "userdata");
  await waitFor(
    `${stateDir}/state.sqlite`,
    async () =>
      await NodeFSP.access(NodePath.join(stateDir, "state.sqlite")).then(
        () => true,
        () => false,
      ),
    timeoutMs,
  );
  return stateDir;
}

export interface StartDevStackOptions {
  readonly repoRoot: string;
  readonly homeDir: string;
  /** Seeds the port offset so a visual run never collides with a hand-run stack. */
  readonly instance: string;
  readonly logPath: string;
  readonly timeoutMs: number;
}

export async function startDevStack(options: StartDevStackOptions): Promise<DevStack> {
  await NodeFSP.mkdir(options.homeDir, { recursive: true });
  await NodeFSP.mkdir(NodePath.dirname(options.logPath), { recursive: true });
  // The child writes to the log file descriptor, not to a pipe owned by this
  // process. A pipe would tie the stack's lifetime to this process: on exit the
  // read end closes and the next line dev-runner logs kills it with EPIPE,
  // which silently defeats --keep-stack. A truncating open ("w") also means the
  // address parsed below can only come from this boot.
  const logFd = NodeFS.openSync(options.logPath, "w");

  const env: NodeJS.ProcessEnv = {
    ...NodeProcess.env,
    // dev-runner spawns `vp`, which lives in the workspace bin dir and is not
    // necessarily on an agent's PATH.
    PATH: `${NodePath.join(options.repoRoot, "node_modules/.bin")}:${NodeProcess.env.PATH ?? ""}`,
    CH3CODE_DEV_INSTANCE: options.instance,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  delete env.CH3CODE_HOME;
  delete env.CH3CODE_PORT;
  delete env.VITE_DEV_SERVER_URL;

  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    ["scripts/dev-runner.ts", "dev", "--home-dir", options.homeDir],
    {
      cwd: options.repoRoot,
      env,
      stdio: ["ignore", logFd, logFd],
      // Own process group: the stack is dev-runner → vp → vite + server, and a
      // group kill is the only teardown that reaches all of them.
      detached: true,
    },
  );
  // The child holds its own duplicate of the descriptor from here on.
  NodeFS.closeSync(logFd);

  let address: DevStackAddress | null = null;
  let exited: number | null = null;
  const readAddress = async (): Promise<DevStackAddress | null> =>
    parseDevRunnerAddress(await NodeFSP.readFile(options.logPath, "utf8").catch(() => ""));
  const groupId = child.pid;
  const hasExited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      exited = code ?? -1;
      resolve();
    });
  });

  const signalGroup = (signal: NodeJS.Signals) => {
    if (groupId === undefined) return;
    try {
      NodeProcess.kill(-groupId, signal);
    } catch {
      // Already gone.
    }
  };

  const stop = async (): Promise<void> => {
    if (exited !== null) return;
    signalGroup("SIGTERM");
    // Vite+ and the server get a grace period; anything still holding the port
    // after it is taken down hard, because the next run reuses these ports.
    await Promise.race([hasExited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
    if (exited === null) {
      signalGroup("SIGKILL");
      await Promise.race([hasExited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
  };

  try {
    await waitFor(
      `the dev-runner startup line in ${options.logPath}`,
      async () => {
        if (exited !== null) {
          throw new Error(`dev-runner exited with ${String(exited)}; see ${options.logPath}.`);
        }
        address = await readAddress();
        return address !== null;
      },
      options.timeoutMs,
    );
    const resolved = address as DevStackAddress | null;
    if (!resolved) throw new Error("dev-runner printed no address.");
    const webUrl = `http://localhost:${String(resolved.webPort)}`;
    await waitFor(`the web dev server on ${webUrl}`, () => probe(webUrl, 5_000), options.timeoutMs);
    await waitFor(
      `the CH3 server on port ${String(resolved.serverPort)}`,
      () => probe(`${webUrl}/api/auth/session`, 5_000),
      options.timeoutMs,
    );
    const stateDir = await resolveStateDir(resolved.homeDir, 30_000);
    return { webUrl, stateDir, owned: true, logPath: options.logPath, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function attachDevStack(input: {
  readonly webUrl: string;
  readonly stateDir: string | null;
  readonly timeoutMs: number;
}): Promise<DevStack> {
  const webUrl = input.webUrl.replace(/\/+$/, "");
  await waitFor(`the running stack on ${webUrl}`, () => probe(webUrl, 5_000), input.timeoutMs);
  return {
    webUrl,
    stateDir: input.stateDir,
    owned: false,
    logPath: null,
    stop: async () => {
      // Attached stacks belong to whoever started them.
    },
  };
}
