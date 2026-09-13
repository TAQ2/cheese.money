// @effect-diagnostics nodeBuiltinImport:off - the keeper is process plumbing: a detached child, a Unix socket, a journal on disk.
/**
 * The server side of the keeper: spawn one, connect to one, and present it to
 * the Claude SDK as the process it thinks it spawned.
 *
 * `spawnClaudeCodeProcess` is the SDK's seam for running the CLI somewhere
 * other than a local child — a container, a VM, or here a detached keeper.
 * What it hands back must look like a child process: `stdin`, `stdout`,
 * `kill`, an `exit` event. {@link KeeperProcess} is that shape over a socket.
 *
 * Two things a real child does not have. `detach()` — the server is going
 * away and the CLI is not; every later `kill` and stdin close is a no-op, the
 * socket simply closes, and locally the object ends like a cleanly exited
 * process so its reader is not left waiting on a keeper nobody is listening
 * to. And `ackMessage(uuid)` — the keeper journals every
 * line under a sequence number, and the server tells it how far it got so a
 * reattach replays only what was never processed.
 *
 * On disk, per thread, under `<state>/claude-keepers/<threadId>/`:
 * - `meta.json`, written by the keeper: pids, socket, sequence, cached
 *   handshake, exit.
 * - `session.json`, written by the adapter: what `startSession` was called
 *   with and which turn is running, so the next server can rebuild the
 *   session context without asking anybody.
 * - `journal.ndjson`, `stderr.log`.
 *
 * @module provider/keeper/ClaudeKeeper
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeStream from "node:stream";

import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
} from "@ch3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CLAUDE_KEEPER_PROTOCOL_VERSION,
  CLAUDE_KEEPER_SCRIPT,
  CLAUDE_KEEPER_SCRIPT_FILENAME,
} from "./claudeKeeperScript.ts";

/** The directory name under the server's state directory. */
export const CLAUDE_KEEPERS_DIRNAME = "claude-keepers";

const META_FILENAME = "meta.json";
const SESSION_FILENAME = "session.json";
const JOURNAL_FILENAME = "journal.ndjson";
const STDERR_FILENAME = "stderr.log";
const KEEPER_LOG_FILENAME = "keeper.log";

/** How long a freshly spawned keeper gets to open its socket. */
const SOCKET_APPEAR_TIMEOUT = Duration.seconds(10);
const SOCKET_APPEAR_POLL = Duration.millis(50);

/**
 * Matches the keeper daemon's own SIGTERM-to-SIGKILL escalation
 * (`claudeKeeperScript.ts` `KILL_ESCALATION_MS`), plus margin for the OS to
 * deliver a kill and reap the process. `retireClaudeKeeper` waits at most
 * this long for a CLI it is ending to actually be gone before it gives up
 * and returns anyway, see `reapOrphanedCli`.
 */
const RETIRE_CONFIRM_TIMEOUT = Duration.seconds(10);
const RETIRE_CONFIRM_POLL = Duration.millis(100);

/**
 * Bounds `boundedCommandLineOf`, used for both the keeper pid and (via
 * `reapOrphanedCli`) the CLI pid. Both run on essentially every successful
 * retire, not just a rare case: the CLI-pid check's cheap pid-liveness
 * pre-check almost never short-circuits it either, because real signal
 * delivery across two separate processes takes longer than the microseconds
 * between one line of this module's own code and the next. An unbounded
 * subprocess spawn sitting in that path is a load-bearing risk on a slow
 * machine, confirmed by forcing a slow `ps` onto `PATH` locally and watching
 * the same 20s test timeout reproduce; this keeps it from ever stalling a
 * retire indefinitely.
 */
const COMMAND_LINE_LOOKUP_TIMEOUT = Duration.seconds(5);

/**
 * Unix socket paths are short on macOS (104 bytes), and the state directory
 * is not, so sockets live in the temp directory under a short name.
 */
const SOCKET_NAME_PREFIX = "ch3-keeper-";

const KeeperExit = Schema.Struct({
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  at: Schema.String,
  error: Schema.optional(Schema.String),
});

export const ClaudeKeeperMeta = Schema.Struct({
  version: Schema.Number,
  keeperPid: Schema.Number,
  cliPid: Schema.NullOr(Schema.Number),
  socketPath: Schema.String,
  journalPath: Schema.String,
  startedAt: Schema.String,
  lastSeq: Schema.Number,
  lastAck: Schema.Number,
  initResponse: Schema.NullOr(Schema.String),
  cliSessionId: Schema.NullOr(Schema.String),
  exit: Schema.NullOr(KeeperExit),
});
export type ClaudeKeeperMeta = typeof ClaudeKeeperMeta.Type;

const decodeMeta = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeKeeperMeta));

const McpSessionConfigSchema = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  endpoint: Schema.String,
  authorizationHeader: Schema.String,
});

/**
 * What the adapter needs to rebuild a session it did not start: the start
 * input as given, the turn in flight, and the MCP credential the CLI holds.
 */
export const ClaudeKeeperSession = Schema.Struct({
  threadId: ThreadId,
  startInput: ProviderSessionStartInput,
  activeTurnId: Schema.NullOr(Schema.String),
  mcpSession: Schema.NullOr(McpSessionConfigSchema),
  savedAt: Schema.String,
});
export type ClaudeKeeperSession = typeof ClaudeKeeperSession.Type;

const sessionJson = Schema.fromJsonString(ClaudeKeeperSession);
const decodeSession = Schema.decodeUnknownEffect(sessionJson);
const encodeSession = Schema.encodeEffect(sessionJson);

export interface ClaudeKeeperPaths {
  readonly dir: string;
  readonly metaPath: string;
  readonly sessionPath: string;
  readonly journalPath: string;
  readonly stderrPath: string;
  readonly keeperLogPath: string;
}

export const claudeKeeperPaths = (keepersDir: string, threadId: string): ClaudeKeeperPaths => {
  const dir = `${keepersDir}/${threadId}`;
  return {
    dir,
    metaPath: `${dir}/${META_FILENAME}`,
    sessionPath: `${dir}/${SESSION_FILENAME}`,
    journalPath: `${dir}/${JOURNAL_FILENAME}`,
    stderrPath: `${dir}/${STDERR_FILENAME}`,
    keeperLogPath: `${dir}/${KEEPER_LOG_FILENAME}`,
  };
};

/** The exit shape the SDK's `SpawnedProcess` reports. */
export interface KeeperExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface KeeperWire {
  readonly t: string;
  readonly [key: string]: unknown;
}

const UUID_IN_LINE = /"uuid":"([0-9a-f-]{36})"/u;

/**
 * A keeper on the other end of a socket, wearing a child process's shape.
 *
 * `stdin` writes become `in` frames; `out` frames become `stdout` lines.
 * `kill` and closing `stdin` are forwarded unless {@link detach} has been
 * called, after which the process is somebody else's and both are ignored.
 */
export class KeeperProcess extends NodeEvents.EventEmitter {
  readonly stdin: NodeStream.Writable;
  readonly stdout: NodeStream.PassThrough;
  private socket: NodeNet.Socket | undefined;
  /** Frames written before the socket is up, sent on connect in order. */
  private readonly pendingFrames: Array<string> = [];
  private buffer = "";
  private detaching = false;
  private exited: KeeperExitInfo | undefined;
  private welcomed = false;
  private lastSeqSeen = 0;
  private lastAcked = 0;
  private readonly seqByUuid = new Map<string, number>();
  /** The keeper's `welcome`, resolved once. */
  readonly ready: Promise<{ readonly cliPid: number | null; readonly lastSeq: number }>;
  private resolveReady!: (value: {
    readonly cliPid: number | null;
    readonly lastSeq: number;
  }) => void;
  private rejectReady!: (error: Error) => void;

  readonly socketPath: string;
  private readonly since: number;

  constructor(socketPath: string, since: number) {
    super();
    this.socketPath = socketPath;
    this.since = since;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Whoever needs the outcome awaits `ready` and handles its rejection; on
    // the reattach path nobody does, and an unhandled rejection from a socket
    // that could not connect (a keeper whose pid was reused, its socket gone)
    // crashed the whole server on boot. This no-op keeps the rejection
    // "handled" so it can never do that; real awaiters still see it.
    void this.ready.catch(() => undefined);
    this.stdout = new NodeStream.PassThrough();
    this.stdin = new NodeStream.Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.writeInput(chunk.toString());
        callback();
      },
      final: (callback) => {
        if (!this.detaching) this.send({ t: "end" });
        callback();
      },
    });
    this.lastSeqSeen = since;
    this.lastAcked = since;
  }

  /**
   * Open the socket. Separate from construction because a freshly spawned
   * keeper needs a moment to listen, and the SDK wants its process object
   * before that moment: frames written meanwhile wait in order.
   */
  connect(): void {
    if (this.socket !== undefined) return;
    const socket = NodeNet.createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ t: "hello", since: this.since, version: CLAUDE_KEEPER_PROTOCOL_VERSION })}\n`,
      );
      for (const frame of this.pendingFrames.splice(0)) socket.write(frame);
    });
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error: Error) => {
      if (!this.welcomed) this.rejectReady(error);
      if (this.detaching) return;
      // A socket error is the keeper being unreachable — a connect that never
      // landed (ENOENT on a vanished socket) or a live one dropping. Report it
      // as the process exiting, which the SDK and the stream loop handle by
      // ending the turn. Re-emitting a raw `error` instead makes the SDK throw
      // it as an uncaught exception, which crash-looped the server on boot.
      this.settleExit({ code: null, signal: null });
    });
    socket.on("close", () => {
      if (!this.welcomed) this.rejectReady(new Error("keeper socket closed before welcome"));
      if (this.detaching || this.exited !== undefined) return;
      // The keeper itself went away under a live server. To the SDK that is
      // the process dying; there is nothing else it could be.
      this.settleExit({ code: null, signal: "SIGHUP" });
    });
  }

  /** The keeper could not be started at all: report it as a process that died. */
  failToStart(error: Error): void {
    if (!this.welcomed) this.rejectReady(error);
    this.settleExit({ code: null, signal: null });
  }

  get killed(): boolean {
    return this.exited !== undefined;
  }

  get exitCode(): number | null {
    return this.exited?.code ?? null;
  }

  /** The highest sequence number received so far. */
  get lastSeq(): number {
    return this.lastSeqSeen;
  }

  get isDetached(): boolean {
    return this.detaching;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.detaching || this.exited !== undefined) return false;
    this.send({ t: "kill", signal });
    return true;
  }

  /**
   * Let go of the CLI without touching it. The socket closes, the keeper
   * keeps the CLI, and the next server can reattach.
   *
   * Silence is only for the wire. Locally this still has to end like a
   * process, because the SDK is reading `stdout` and waiting on `exit`, and
   * neither ever comes from a keeper we have stopped listening to: the socket
   * guards below swallow the close, so `settleExit` would never run. Its
   * reader then parks forever, and an async generator parked on an await
   * cannot be returned — which is what made `Fiber.interrupt` on the stream
   * fiber, and with it the whole provider-instance rebuild, never come back.
   * So: end `stdout`, report a clean exit to whoever holds this object, and
   * send the keeper nothing at all.
   */
  detach(): void {
    if (this.detaching) return;
    this.detaching = true;
    this.socket?.end();
    this.socket?.destroy();
    this.settleExit({ code: null, signal: null });
  }

  /**
   * The server has processed the SDK message with this uuid — and, since
   * lines are processed in order, everything the keeper sent before it.
   */
  ackMessage(uuid: string | undefined): void {
    if (uuid === undefined) return;
    const seq = this.seqByUuid.get(uuid);
    if (seq === undefined) return;
    this.ack(seq);
  }

  ack(seq: number): void {
    if (seq <= this.lastAcked) return;
    this.lastAcked = seq;
    for (const [uuid, known] of this.seqByUuid) {
      if (known <= seq) this.seqByUuid.delete(uuid);
    }
    if (!this.detaching) this.send({ t: "ack", seq });
  }

  private writeInput(chunk: string): void {
    if (this.detaching) return;
    for (const line of chunk.split("\n")) {
      if (line.length === 0) continue;
      this.send({ t: "in", line });
    }
  }

  private send(message: KeeperWire): void {
    const frame = `${JSON.stringify(message)}\n`;
    if (this.socket === undefined || this.socket.connecting) {
      this.pendingFrames.push(frame);
      return;
    }
    if (this.socket.destroyed) return;
    this.socket.write(frame);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (raw.length === 0) continue;
      let message: KeeperWire;
      try {
        message = JSON.parse(raw) as KeeperWire;
      } catch {
        continue;
      }
      this.handle(message);
    }
  }

  private handle(message: KeeperWire): void {
    switch (message.t) {
      case "welcome": {
        this.welcomed = true;
        this.resolveReady({
          cliPid: typeof message.cliPid === "number" ? message.cliPid : null,
          lastSeq: typeof message.lastSeq === "number" ? message.lastSeq : 0,
        });
        return;
      }
      case "out": {
        const seq = typeof message.seq === "number" ? message.seq : 0;
        const line = typeof message.line === "string" ? message.line : "";
        if (seq <= this.lastSeqSeen) return;
        this.lastSeqSeen = seq;
        const uuid = UUID_IN_LINE.exec(line)?.[1];
        if (uuid !== undefined) this.seqByUuid.set(uuid, seq);
        this.stdout.write(`${line}\n`);
        return;
      }
      case "exit": {
        const code = typeof message.code === "number" ? message.code : null;
        const signal =
          typeof message.signal === "string" ? (message.signal as NodeJS.Signals) : null;
        this.settleExit({ code, signal });
        return;
      }
      default:
        return;
    }
  }

  private settleExit(info: KeeperExitInfo): void {
    if (this.exited !== undefined) return;
    this.exited = info;
    this.stdout.end();
    this.emit("exit", info.code, info.signal);
    if (!this.detaching) {
      this.socket?.end();
      this.socket?.destroy();
    }
  }
}

/**
 * Write the keeper script where the server's shim scripts live. Idempotent;
 * an upgrade rewrites it, and a keeper already running keeps the old copy in
 * memory, which is fine — the protocol is versioned in the frame.
 */
export const installClaudeKeeperScript = Effect.fn("installClaudeKeeperScript")(function* (
  shimDir: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scriptPath = path.join(shimDir, CLAUDE_KEEPER_SCRIPT_FILENAME);
  yield* fileSystem.makeDirectory(shimDir, { recursive: true }).pipe(Effect.ignore);
  const current = yield* fileSystem
    .readFileString(scriptPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (current !== CLAUDE_KEEPER_SCRIPT) {
    yield* fileSystem.writeFileString(scriptPath, CLAUDE_KEEPER_SCRIPT).pipe(Effect.ignore);
  }
  return scriptPath;
});

export class ClaudeKeeperError extends Schema.TaggedErrorClass<ClaudeKeeperError>()(
  "ClaudeKeeperError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Half the thread id and a nonce, which with a macOS temp directory stays
 * under the 104-byte socket path limit. The nonce makes the path the keeper's
 * own rather than the thread's. Two keepers for one thread exist whenever a
 * server could not reattach to the first and the thread's next turn started a
 * second; with one shared path, the first one's exit unlinked the socket the
 * live one was listening on, the next boot read that as "socket gone", spawned
 * a third, and the cycle repeated on every restart. Sixteen hex characters of
 * a v4 thread id are 64 random bits, so the thread part alone does not collide
 * between threads either.
 */
const socketPathFor = (tmpDir: string, threadId: string) =>
  `${tmpDir}/${SOCKET_NAME_PREFIX}${threadId.replaceAll("-", "").slice(0, 16)}-${NodeCrypto.randomBytes(4).toString("hex")}.sock`;

/** Where keeper sockets live: the temp directory, for the path-length reason above. */
export const claudeKeeperSocketDir = (): string => NodeOS.tmpdir();

export interface LaunchClaudeKeeperInput {
  readonly keepersDir: string;
  readonly tmpDir: string;
  readonly scriptPath: string;
  readonly nodePath: string;
  readonly threadId: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /**
   * How long the keeper waits with nobody connected before it retires itself,
   * in milliseconds. Tests only: production leaves it unset and the keeper
   * uses its own two-hour default.
   */
  readonly idleMs?: number;
}

/**
 * Start a keeper for a CLI, synchronously, and hand back its process object
 * before the socket is up — the SDK's spawn hook is synchronous and wants a
 * process immediately. Follow with {@link awaitClaudeKeeper}, which waits for
 * the socket and connects; frames written in between are held in order.
 *
 * The keeper is spawned detached with its own stdio on a log file, so it
 * shares nothing with the server: not a pipe, not a process group. The
 * server's death cannot reach it, which is the whole point.
 */
export const launchClaudeKeeper = (input: LaunchClaudeKeeperInput): KeeperProcess => {
  const paths = claudeKeeperPaths(input.keepersDir, input.threadId);
  const socketPath = socketPathFor(input.tmpDir, input.threadId);
  const keeper = new KeeperProcess(socketPath, 0);
  try {
    NodeFS.rmSync(paths.dir, { recursive: true, force: true });
    NodeFS.mkdirSync(paths.dir, { recursive: true });
    // Stamp the directory before anything can write into it. The keeper only
    // writes `meta.json` while this stamp is its own, which is what stops a
    // keeper being retired right now from claiming the file its replacement
    // is about to need — a race whose loser is a live CLI nobody can reach.
    const owner = NodeCrypto.randomUUID();
    NodeFS.writeFileSync(`${paths.metaPath}.owner`, owner);
    const log = NodeFS.openSync(paths.keeperLogPath, "a");
    const child = NodeChildProcess.spawn(
      input.nodePath,
      [
        input.scriptPath,
        "--meta",
        paths.metaPath,
        "--journal",
        paths.journalPath,
        "--socket",
        socketPath,
        "--owner",
        owner,
        ...(input.idleMs === undefined ? [] : ["--idle-ms", String(input.idleMs)]),
        "--stderr",
        paths.stderrPath,
        ...(input.cwd ? ["--cwd", input.cwd] : []),
        "--",
        input.command,
        ...input.args,
      ],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      },
    );
    child.unref();
    NodeFS.closeSync(log);
  } catch (cause) {
    keeper.failToStart(cause instanceof Error ? cause : new Error(String(cause)));
  }
  return keeper;
};

/**
 * Wait for a launched keeper's socket, connect, and wait for its welcome.
 */
export const awaitClaudeKeeper = Effect.fn("awaitClaudeKeeper")(function* (
  keeper: KeeperProcess,
): Effect.fn.Return<KeeperProcess, ClaudeKeeperError> {
  if (keeper.killed) {
    return yield* new ClaudeKeeperError({ detail: "The keeper could not be started." });
  }
  const deadline = Duration.toMillis(SOCKET_APPEAR_TIMEOUT);
  let waited = 0;
  while (!NodeFS.existsSync(keeper.socketPath)) {
    if (waited >= deadline) {
      keeper.failToStart(new Error("The keeper never opened its socket."));
      return yield* new ClaudeKeeperError({ detail: "The keeper never opened its socket." });
    }
    yield* Effect.sleep(SOCKET_APPEAR_POLL);
    waited += Duration.toMillis(SOCKET_APPEAR_POLL);
  }
  keeper.connect();
  yield* Effect.tryPromise({
    try: () => keeper.ready,
    catch: (cause) => new ClaudeKeeperError({ detail: "The keeper did not answer.", cause }),
  });
  return keeper;
});

/** Launch and wait, in one step: what a caller outside the SDK's spawn hook wants. */
export const spawnClaudeKeeper = Effect.fn("spawnClaudeKeeper")(function* (
  input: LaunchClaudeKeeperInput,
): Effect.fn.Return<KeeperProcess, ClaudeKeeperError> {
  return yield* awaitClaudeKeeper(launchClaudeKeeper(input));
});

/**
 * Connect to a keeper that is already running and replay from `since`.
 * Fails when nothing answers on the socket — the keeper is gone.
 */
export const connectClaudeKeeper = Effect.fn("connectClaudeKeeper")(function* (input: {
  readonly socketPath: string;
  readonly since: number;
}): Effect.fn.Return<KeeperProcess, ClaudeKeeperError> {
  const keeper = new KeeperProcess(input.socketPath, input.since);
  keeper.connect();
  yield* Effect.tryPromise({
    try: () => keeper.ready,
    catch: (cause) => new ClaudeKeeperError({ detail: "Could not connect to the keeper.", cause }),
  });
  return keeper;
});

export const readClaudeKeeperMeta = Effect.fn("readClaudeKeeperMeta")(function* (
  metaPath: string,
): Effect.fn.Return<Option.Option<ClaudeKeeperMeta>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(metaPath).pipe(
    Effect.flatMap((raw) => decodeMeta(raw)),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<ClaudeKeeperMeta>()),
  );
});

export const writeClaudeKeeperSession = Effect.fn("writeClaudeKeeperSession")(function* (
  sessionPath: string,
  session: ClaudeKeeperSession,
): Effect.fn.Return<void, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const encoded = yield* encodeSession(session).pipe(Effect.orDie);
  // The keeper creates the directory when it launches; a session started
  // through a fake query has no keeper, and the file is still the record.
  const dir = sessionPath.slice(0, sessionPath.lastIndexOf("/"));
  yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
  yield* fileSystem.writeFileString(sessionPath, encoded).pipe(Effect.ignore);
});

export const readClaudeKeeperSession = Effect.fn("readClaudeKeeperSession")(function* (
  sessionPath: string,
): Effect.fn.Return<Option.Option<ClaudeKeeperSession>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(sessionPath).pipe(
    Effect.flatMap((raw) => decodeSession(raw)),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<ClaudeKeeperSession>()),
  );
});

/** Every thread id with a keeper directory, whatever state it is in. */
export const listClaudeKeeperThreadIds = Effect.fn("listClaudeKeeperThreadIds")(function* (
  keepersDir: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readDirectory(keepersDir).pipe(Effect.orElseSucceed(() => []));
});

export const removeClaudeKeeperDir = Effect.fn("removeClaudeKeeperDir")(function* (
  dir: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(dir, { recursive: true }).pipe(Effect.ignore);
});

/**
 * Thread ids whose keeper is alive right now — the set both boot-time
 * reconcilers leave alone, read from disk so neither depends on when the
 * reattach itself runs.
 */
export const liveClaudeKeeperThreadIds = Effect.fn("liveClaudeKeeperThreadIds")(function* (
  keepersDir: string,
): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem> {
  const threadIds = yield* listClaudeKeeperThreadIds(keepersDir);
  const live = new Set<string>();
  for (const threadId of threadIds) {
    const meta = yield* readClaudeKeeperMeta(claudeKeeperPaths(keepersDir, threadId).metaPath);
    if (Option.isSome(meta) && isClaudeKeeperAlive(meta.value)) live.add(threadId);
  }
  return live;
});

/** Signal 0: existence check, no signal delivered. */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether a keeper's pid is still a live process. */
export const isClaudeKeeperAlive = (meta: ClaudeKeeperMeta): boolean =>
  meta.exit === null && isPidAlive(meta.keeperPid);

export type ClaudeKeeperRetirement = "retired" | "gone" | "not-a-keeper";

/** The command line of a live process, or nothing when there is none to ask. */
const commandLineOf = (pid: number): Effect.Effect<string | undefined> =>
  Effect.callback<string | undefined>((resume) => {
    NodeChildProcess.execFile("ps", ["-ww", "-o", "command=", "-p", String(pid)], (error, stdout) =>
      resume(Effect.succeed(error ? undefined : stdout.trim())),
    );
  });

/**
 * `commandLineOf`, bounded. A subprocess spawn with no timeout of its own is
 * a load-bearing risk on a slow machine, and this runs on essentially every
 * successful retire, not just a rare case: nothing here is optional. A
 * timeout is treated exactly like "nothing to ask" (`undefined`): every
 * caller already refuses to act without a real answer, so a slow `ps` costs
 * a bounded wait and a safe no-op, never an indefinite stall.
 */
const boundedCommandLineOf = (pid: number): Effect.Effect<string | undefined> =>
  commandLineOf(pid).pipe(
    Effect.timeoutOption(COMMAND_LINE_LOOKUP_TIMEOUT),
    Effect.map(Option.getOrUndefined),
  );

/** Poll until a pid is gone, bounded by `RETIRE_CONFIRM_TIMEOUT`. Same idiom
 * as `awaitClaudeKeeper`'s socket-appear wait above: this file does not want
 * a second way to poll for a process event. */
const waitForPidExit = Effect.fn("waitForPidExit")(function* (pid: number) {
  const deadline = Duration.toMillis(RETIRE_CONFIRM_TIMEOUT);
  let waited = 0;
  while (isPidAlive(pid)) {
    if (waited >= deadline) return false;
    yield* Effect.sleep(RETIRE_CONFIRM_POLL);
    waited += Duration.toMillis(RETIRE_CONFIRM_POLL);
  }
  return true;
});

/**
 * The keeper is supposed to take its CLI down with it before it exits
 * (`claudeKeeperScript.ts` traps SIGTERM/SIGINT/SIGHUP and kills the child
 * first). When it does not (caught live as an orphaned `claude` process
 * still resuming a session a fresh keeper had just been asked to resume too,
 * the two racing on one Claude session until the orphan happened to finish
 * on its own), this is the backstop that runs before a caller is allowed to
 * start that fresh keeper. Only acts with a `cliSessionId` to match against
 * the orphan's own command line, the same reused-pid guard below uses for
 * the keeper itself; without one, it leaves the pid alone rather than guess.
 */
const reapOrphanedCli = Effect.fn("reapOrphanedCli")(function* (meta: ClaudeKeeperMeta) {
  if (meta.cliPid === null || meta.cliSessionId === null || !isPidAlive(meta.cliPid)) return;
  const commandLine = yield* boundedCommandLineOf(meta.cliPid);
  if (commandLine === undefined || !commandLine.includes(meta.cliSessionId)) return;
  try {
    process.kill(meta.cliPid, "SIGTERM");
  } catch {
    return;
  }
  if (yield* waitForPidExit(meta.cliPid)) return;
  try {
    process.kill(meta.cliPid, "SIGKILL");
  } catch {}
});

/**
 * End a keeper the server is giving up on: one it could not reattach to, or
 * one still alive for a thread whose next turn is about to start a fresh one.
 * Left alone it keeps a CLI running for nobody. The pid comes from a file and
 * pids are reused, so the signal goes only to a process whose command line is
 * this keeper's — the script, with this thread's meta path — and anything
 * else is reported as not ours and left alone.
 */
export const retireClaudeKeeper = Effect.fn("retireClaudeKeeper")(function* (
  meta: ClaudeKeeperMeta,
  metaPath: string,
): Effect.fn.Return<ClaudeKeeperRetirement> {
  if (!isClaudeKeeperAlive(meta)) {
    yield* reapOrphanedCli(meta);
    return "gone";
  }
  // "Not a keeper" says nothing about the CLI. The pid in the meta file may
  // have been recycled, or `ps` may have timed out, and either way the CLI it
  // recorded can still be alive with nobody above it — which is the orphan
  // state, not the absence of one. The reap below is self-guarding, so running
  // it here costs a pid check and closes the gap.
  if (meta.keeperPid <= 1 || meta.keeperPid === process.pid) {
    yield* reapOrphanedCli(meta);
    return "not-a-keeper";
  }
  const commandLine = yield* boundedCommandLineOf(meta.keeperPid);
  if (commandLine === undefined || !commandLine.includes(`--meta ${metaPath} --journal `)) {
    yield* reapOrphanedCli(meta);
    return "not-a-keeper";
  }
  try {
    process.kill(meta.keeperPid, "SIGTERM");
  } catch {
    yield* reapOrphanedCli(meta);
    return "gone";
  }
  // The keeper's own retire() kills its CLI before it exits, but only once
  // it actually receives and acts on the signal, or is alive to receive it
  // at all. A caller that moves on before that is confirmed can start a
  // second CLI resuming the same session while the first is still holding
  // it, so this closes that window instead of trusting the signal worked.
  yield* reapOrphanedCli(meta);
  return "retired";
});

/**
 * Retire whatever keeper the thread's directory still names, before a fresh
 * one is launched on the same paths.
 */
export const retireStaleClaudeKeeper = Effect.fn("retireStaleClaudeKeeper")(function* (
  paths: ClaudeKeeperPaths,
): Effect.fn.Return<
  Option.Option<{ readonly keeperPid: number; readonly outcome: ClaudeKeeperRetirement }>,
  never,
  FileSystem.FileSystem
> {
  const meta = yield* readClaudeKeeperMeta(paths.metaPath);
  if (Option.isNone(meta)) return Option.none();
  const outcome = yield* retireClaudeKeeper(meta.value, paths.metaPath);
  return Option.some({ keeperPid: meta.value.keeperPid, outcome });
});
