// @effect-diagnostics nodeBuiltinImport:off - real processes and a real socket are the subject under test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { query, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  claudeKeeperPaths,
  connectClaudeKeeper,
  installClaudeKeeperScript,
  isClaudeKeeperAlive,
  KeeperProcess,
  readClaudeKeeperMeta,
  retireClaudeKeeper,
  spawnClaudeKeeper,
} from "./ClaudeKeeper.ts";

/**
 * A stand-in for the CLI that speaks just enough of the stream-json protocol:
 * an init line on start, an answer to the `initialize` control request, an
 * assistant + result pair for every user message. A SECOND `initialize` makes
 * it exit with code 3, which is how a test proves the keeper answered the
 * handshake itself rather than forwarding it.
 */
const FAKE_CLI = String.raw`
import { createInterface } from "node:readline";
let inits = 0;
let n = 0;
const uuid = () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0");
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
say({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", uuid: uuid() });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === "control_request" && m.request && m.request.subtype === "initialize") {
    inits += 1;
    if (inits > 1) { say({ type: "fake", error: "second initialize" }); process.exit(3); }
    say({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [] } } });
    return;
  }
  if (m.type === "user") {
    say({ type: "assistant", uuid: uuid(), message: { role: "assistant", content: [{ type: "text", text: "echo:" + JSON.stringify(m.message.content) }] } });
    say({ type: "result", subtype: "success", uuid: uuid(), result: "done" });
  }
});
lines.on("close", () => process.exit(0));
process.on("SIGTERM", () => { say({ type: "fake", bye: true }); process.exit(143); });
`;

const readLine = (keeper: KeeperProcess): Effect.Effect<string> =>
  Effect.callback<string>((resume) => {
    const onData = (chunk: Buffer | string) => {
      keeper.stdout.off("data", onData);
      resume(Effect.succeed(chunk.toString()));
    };
    keeper.stdout.on("data", onData);
    return Effect.sync(() => keeper.stdout.off("data", onData));
  });

/** Lines arrive batched; split a chunk and keep reading until `count` lines. */
const readLines = (keeper: KeeperProcess, count: number): Effect.Effect<Array<string>> =>
  Effect.gen(function* () {
    const collected: Array<string> = [];
    while (collected.length < count) {
      const chunk = yield* readLine(keeper);
      for (const line of chunk.split("\n")) if (line.length > 0) collected.push(line);
    }
    return collected;
  });

/**
 * The retirement being tested happens inside the keeper and kills a process
 * this one only knows by pid, so the pid ceasing to exist is the only signal
 * there is; there is no receipt to wait on.
 */
const waitForPidGone = (pid: number): Effect.Effect<void> =>
  Effect.suspend(() => {
    try {
      process.kill(pid, 0);
    } catch {
      return Effect.void;
    }
    return Effect.andThen(Effect.sleep("25 millis"), waitForPidGone(pid));
  });

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForExit = (keeper: KeeperProcess) =>
  Effect.callback<{ code: number | null; signal: string | null }>((resume) => {
    keeper.once("exit", (code, signal) => resume(Effect.succeed({ code, signal })));
  });

/**
 * A SIGTERM the fake CLI caught exits 143; one that arrived before its handler
 * was installed — Linux under load does that — ends it with the signal itself.
 * Either way the keeper delivered the kill, which is what the tests assert.
 */
const endedBySigterm = (exit: { code: number | null; signal: string | null }) =>
  exit.code === 143 || exit.signal === "SIGTERM";

class KeeperStreamFailed extends Schema.ErrorClass<KeeperStreamFailed>("KeeperStreamFailed")({
  _tag: Schema.tag("KeeperStreamFailed"),
  cause: Schema.Unknown,
}) {}

const parseJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const parse = (line: string) => parseJson(line) as Record<string, unknown>;
const toJson = Schema.encodeSync(Schema.UnknownFromJsonString);

const write = (keeper: KeeperProcess, message: unknown) =>
  Effect.sync(() => {
    keeper.stdin.write(`${toJson(message)}\n`);
  });

const initialize = (requestId: string) => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "initialize", hooks: {} },
});

const userMessage = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
});

const makeSandbox = Effect.sync(() => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bdx-keeper-"));
  const fakeCliPath = NodePath.join(root, "fake-claude.mjs");
  NodeFS.writeFileSync(fakeCliPath, FAKE_CLI);
  return { root, keepersDir: NodePath.join(root, "keepers"), fakeCliPath };
});

const spawn = (
  sandbox: { root: string; keepersDir: string; fakeCliPath: string },
  threadId: string,
  idleMs?: number,
) =>
  Effect.gen(function* () {
    const scriptPath = yield* installClaudeKeeperScript(NodePath.join(sandbox.root, "bin"));
    return yield* spawnClaudeKeeper({
      ...(idleMs === undefined ? {} : { idleMs }),
      keepersDir: sandbox.keepersDir,
      tmpDir: NodeOS.tmpdir(),
      scriptPath,
      nodePath: process.execPath,
      threadId,
      command: process.execPath,
      args: [sandbox.fakeCliPath],
      cwd: sandbox.root,
      env: { PATH: process.env["PATH"] ?? "" },
    });
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("ClaudeKeeper", (it) => {
  describe("a keeper between the server and the CLI", () => {
    it.effect(
      "replays what the server missed and answers a second handshake itself",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000001";
          const first = yield* spawn(sandbox, threadId);

          // The CLI's own init line is journaled before anyone asked.
          const [initLine] = yield* readLines(first, 1);
          expect(parse(initLine!)["subtype"]).toBe("init");

          yield* write(first, initialize("req-1"));
          const [initAnswer] = yield* readLines(first, 1);
          expect((parse(initAnswer!)["response"] as { request_id: string }).request_id).toBe(
            "req-1",
          );

          yield* write(first, userMessage("hello"));
          const [assistant, result] = yield* readLines(first, 2);
          expect(parse(assistant!)["type"]).toBe("assistant");
          expect(parse(result!)["type"]).toBe("result");
          // Acknowledge only the init answer: the reply is "unprocessed".
          first.ack(2);
          expect(first.lastSeq).toBe(4);

          // The server goes away without touching the CLI.
          first.detach();
          expect(first.kill("SIGTERM")).toBe(false);

          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
          const meta = yield* readClaudeKeeperMeta(paths.metaPath);
          expect(Option.isSome(meta)).toBe(true);
          const metaValue = Option.getOrThrow(meta);
          expect(metaValue.exit).toBeNull();
          expect(metaValue.initResponse).not.toBeNull();
          expect(isClaudeKeeperAlive(metaValue)).toBe(true);

          // The next server reconnects from where the first one had got to.
          const second = yield* connectClaudeKeeper({
            socketPath: metaValue.socketPath,
            since: 2,
          });
          const replayed = yield* readLines(second, 2);
          expect(replayed.map((line) => parse(line)["type"])).toEqual(["assistant", "result"]);
          expect(second.lastSeq).toBe(4);

          // The SDK greets what it thinks is a fresh process. The keeper
          // answers; the CLI, which would exit on a second greeting, never
          // hears it.
          yield* write(second, initialize("req-2"));
          const [secondAnswer] = yield* readLines(second, 1);
          const answer = parse(secondAnswer!);
          expect(answer["type"]).toBe("control_response");
          expect((answer["response"] as { request_id: string }).request_id).toBe("req-2");

          // Still talking to the same CLI.
          yield* write(second, userMessage("again"));
          const [again] = yield* readLines(second, 2);
          expect(parse(again!)["type"]).toBe("assistant");

          second.kill("SIGTERM");
          const exit = yield* waitForExit(second);
          expect(endedBySigterm(exit)).toBe(true);
        }),
      20_000,
    );

    it.effect(
      "a kill through the keeper ends the CLI and the keeper records it",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000002";
          const keeper = yield* spawn(sandbox, threadId);
          yield* readLines(keeper, 1);

          expect(keeper.kill("SIGTERM")).toBe(true);
          const exit = yield* waitForExit(keeper);
          expect(endedBySigterm(exit)).toBe(true);
          expect(keeper.killed).toBe(true);

          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
          // The keeper writes its meta on exit before telling the client.
          const meta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(meta.exit).not.toBeNull();
          expect(endedBySigterm({ code: meta.exit!.code, signal: meta.exit!.signal })).toBe(true);
          expect(isClaudeKeeperAlive(meta)).toBe(false);
        }),
      20_000,
    );

    it.effect(
      "a keeper whose socket is gone reports an exit, never an uncaught crash",
      () =>
        Effect.gen(function* () {
          // The boot crash: a keeper's pid was reused, its socket gone, and the
          // reattach connect hit ENOENT. The error must settle as a process
          // exit (handled), not a raw 'error' the SDK rethrows, and the
          // rejected `ready` must never be an unhandled rejection.
          const keeper = new KeeperProcess(
            NodePath.join(NodeOS.tmpdir(), "ch3-keeper-does-not-exist-xyz.sock"),
            0,
          );
          keeper.connect();
          const exit = yield* waitForExit(keeper);
          expect(keeper.killed).toBe(true);
          expect(exit.code).toBeNull();
        }),
      20_000,
    );

    it.effect(
      "a second keeper for the thread has its own socket, and retiring the first takes nothing from it",
      () =>
        Effect.gen(function* () {
          // The restart cycle: a server could not reattach to the first keeper,
          // the thread's next turn started a second, and the first one's exit
          // used to unlink the socket the second was listening on and rewrite
          // the meta file over it — so the next boot dropped the thread again.
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000003";
          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
          const first = yield* spawn(sandbox, threadId);
          yield* readLines(first, 1);
          const firstMeta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));

          const second = yield* spawn(sandbox, threadId);
          yield* readLines(second, 1);
          expect(second.socketPath).not.toBe(first.socketPath);

          // `KeeperProcess` fires "exit" at most once, and a listener attached
          // after it already fired never sees it: nothing replays a past
          // EventEmitter event. Ending a live keeper goes through a real OS
          // signal, a second process waking to kill its own child, and a wire
          // message back: real latency, and `reapOrphanedCli`'s own work below
          // only adds to it. Forking the wait before triggering the retire
          // (rather than calling `waitForExit` only after) attaches the
          // listener first, so the race is gone regardless of how fast the
          // other side gets there.
          const exitFiber = yield* Effect.forkChild(waitForExit(first));
          // The first is ended by pid, once its command line says it is that keeper.
          expect(yield* retireClaudeKeeper(firstMeta, paths.metaPath)).toBe("retired");
          const exit = yield* Fiber.join(exitFiber);
          expect(endedBySigterm(exit)).toBe(true);

          // The second keeper still has its socket and still owns the meta file.
          expect(NodeFS.existsSync(second.socketPath)).toBe(true);
          const meta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(meta.keeperPid).not.toBe(firstMeta.keeperPid);
          expect(meta.exit).toBeNull();
          yield* write(second, initialize("req-1"));
          yield* readLines(second, 1);
          yield* write(second, userMessage("still here"));
          const [assistant] = yield* readLines(second, 2);
          expect(parse(assistant!)["type"]).toBe("assistant");

          const secondExitFiber = yield* Effect.forkChild(waitForExit(second));
          second.kill("SIGTERM");
          yield* Fiber.join(secondExitFiber);
        }),
      20_000,
    );

    /**
     * The incident this test reproduces: a keeper that dies without ever
     * running its own retire() (an external kill, not a signal it can trap)
     * used to leave its CLI orphaned and running. `retireClaudeKeeper` then
     * reported the keeper simply "gone" and a caller would start a second
     * CLI resuming the same session while the first was still alive, caught
     * live on a real machine as two `claude` processes racing one
     * `--resume` id.
     *
     * `FAKE_CLI` exits the moment its stdin pipe closes, which happens on its
     * own the instant the keeper holding the other end is killed, too
     * well-behaved to stand in for a real CLI mid-turn, which does not tie
     * its life to stdin. This stand-in only exits on a direct SIGTERM.
     */
    it.effect(
      "a keeper killed without a trappable signal still has its CLI reaped on retire",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000004";
          const cliSessionId = "11111111-1111-4111-8111-111111111111";
          const orphanCliPath = NodePath.join(sandbox.root, "orphan-claude.mjs");
          NodeFS.writeFileSync(
            orphanCliPath,
            String.raw`
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "${cliSessionId}", uuid: "u" }) + "\n");
process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 3600_000);
`,
          );
          const scriptPath = yield* installClaudeKeeperScript(NodePath.join(sandbox.root, "bin"));
          const keeper = yield* spawnClaudeKeeper({
            keepersDir: sandbox.keepersDir,
            tmpDir: NodeOS.tmpdir(),
            scriptPath,
            nodePath: process.execPath,
            threadId,
            command: process.execPath,
            // The real CLI carries its own session id on the command line via
            // `--resume=<id>`; this stands in for that so the reap's
            // reused-pid guard has something to match.
            args: [orphanCliPath, `--resume=${cliSessionId}`],
            cwd: sandbox.root,
            env: { PATH: process.env["PATH"] ?? "" },
          });
          yield* readLines(keeper, 1);

          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
          const meta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(meta.cliSessionId).toBe(cliSessionId);
          const cliPid = meta.cliPid!;

          // SIGKILL cannot be trapped: the keeper goes with no chance to run
          // its own retire() or touch its CLI, exactly the failure mode a
          // plain SIGTERM cannot exercise.
          process.kill(meta.keeperPid, "SIGKILL");
          yield* waitForPidGone(meta.keeperPid);
          expect(isPidAlive(cliPid)).toBe(true);

          const outcome = yield* retireClaudeKeeper(meta, paths.metaPath);
          expect(outcome).toBe("gone");
          yield* waitForPidGone(cliPid);
          expect(isPidAlive(cliPid)).toBe(false);
        }),
      20_000,
    );

    /**
     * The same orphan, reached down the other exit.
     *
     * "Not a keeper" is what `retireClaudeKeeper` says when the recorded pid is
     * not the keeper it expects — a recycled pid, or a `ps` lookup that timed
     * out. It says nothing about the CLI, and the CLI is exactly what is still
     * running with nobody above it in that state. This drives it with a
     * `keeperPid` that names a live process which is not the keeper, and a real
     * orphaned CLI underneath.
     */
    it.effect("reaps the orphan even when the recorded pid is not the keeper", () =>
      Effect.gen(function* () {
        const sandbox = yield* makeSandbox;
        const threadId = "aaaaaaaa-0000-4000-8000-000000000005";
        const cliSessionId = "22222222-2222-4222-8222-222222222222";
        const orphanCliPath = NodePath.join(sandbox.root, "orphan-claude.mjs");
        NodeFS.writeFileSync(
          orphanCliPath,
          String.raw`
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "${cliSessionId}", uuid: "u" }) + "\n");
process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 3600_000);
`,
        );
        const scriptPath = yield* installClaudeKeeperScript(NodePath.join(sandbox.root, "bin"));
        const keeper = yield* spawnClaudeKeeper({
          keepersDir: sandbox.keepersDir,
          tmpDir: NodeOS.tmpdir(),
          scriptPath,
          nodePath: process.execPath,
          threadId,
          command: process.execPath,
          args: [orphanCliPath, `--resume=${cliSessionId}`],
          cwd: sandbox.root,
          env: { PATH: process.env["PATH"] ?? "" },
        });
        yield* readLines(keeper, 1);

        const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
        const meta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
        const cliPid = meta.cliPid!;
        process.kill(meta.keeperPid, "SIGKILL");
        yield* waitForPidGone(meta.keeperPid);
        expect(isPidAlive(cliPid)).toBe(true);

        // A recycled pid is a live process whose command line is somebody
        // else's. The orphan itself stands in for that: it is alive, and its
        // command line carries `--resume=<id>` rather than the keeper script's
        // `--meta ... --journal `, so the lookup says "not our keeper" — which
        // used to end the call with the orphan still running.
        const outcome = yield* retireClaudeKeeper({ ...meta, keeperPid: cliPid }, paths.metaPath);

        expect(outcome).toBe("not-a-keeper");
        yield* waitForPidGone(cliPid);
        expect(isPidAlive(cliPid)).toBe(false);
      }),
    );

    /**
     * The regression this file exists to hold shut.
     *
     * A settings edit that replaces the Claude provider instance closes the
     * outgoing adapter's scope, whose finalizer detaches every keeper-backed
     * session and lets its stream fiber go. `detach()` silences the socket by
     * design, so before the fix nothing ever ended the keeper's `stdout`: the
     * SDK's read never settled, its async generator sat inside an `await`,
     * and an async generator parked on an await cannot be returned — which is
     * exactly what `Stream.fromAsyncIterable` does when its scope closes.
     * The stream fiber never ended, the finalizer never returned, the scope
     * close never returned, and the registry's reconcile never reached the
     * line that opens the rebuild latch it had already shut. Every turn after
     * that waited 30 s and read `claudeAgent` as absent until a restart.
     *
     * Nothing here is a stand-in: the real keeper, the real CLI stand-in, the
     * real SDK reading it through the same `spawnClaudeCodeProcess` seam the
     * adapter uses, and the real `Stream.fromAsyncIterable` teardown.
     */
    it.effect(
      "detaching ends the stream the SDK is reading, and leaves the CLI running",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000002";
          const keeper = yield* spawn(sandbox, threadId);

          // A prompt that never ends is a session waiting for its next turn.
          const openPrompt: AsyncIterable<never> = {
            [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
          };
          const session = query({
            prompt: openPrompt,
            options: {
              pathToClaudeCodeExecutable: sandbox.fakeCliPath,
              spawnClaudeCodeProcess: () => keeper as unknown as SpawnedProcess,
            },
          });

          // Watch the pulls without changing them, so the detach below lands
          // while the generator is genuinely parked inside a read rather than
          // resting on a yield, where returning it would always have worked.
          //
          // Counting pulls is not enough on its own: if a later SDK delivered a
          // second message here, the second pull would settle, the detach would
          // land between pulls, and the whole thing would pass against broken
          // code. So the pull's pending-ness is tracked and asserted below —
          // the fixture fails loudly rather than quietly stopping testing
          // anything.
          let signalParked: () => void = () => undefined;
          const parked = new Promise<void>((resolve) => {
            signalParked = resolve;
          });
          let pulls = 0;
          let secondPullSettled = false;
          const watched: AsyncIterable<unknown> = {
            [Symbol.asyncIterator]: () => {
              const inner = session[Symbol.asyncIterator]();
              return {
                next: () => {
                  pulls += 1;
                  const pull = inner.next();
                  if (pulls === 2) {
                    const settled = () => {
                      secondPullSettled = true;
                    };
                    void pull.then(settled, settled);
                    signalParked();
                  }
                  return pull;
                },
                return: (value?: unknown) => inner.return(value as never),
              } as AsyncIterator<unknown>;
            },
          };

          const seen: Array<string> = [];
          const fiber = yield* Effect.forkChild(
            Stream.fromAsyncIterable(watched, (cause) => new KeeperStreamFailed({ cause })).pipe(
              Stream.runForEach((message) =>
                Effect.sync(() => {
                  seen.push(String((message as { type?: unknown }).type));
                }),
              ),
            ),
          );
          // The CLI's own init line, then the read that never comes.
          yield* Effect.promise(() => parked);
          expect(seen).toEqual(["system"]);
          // Drain the microtasks a resolved pull would have used, then insist
          // the read really is outstanding. This is the whole premise: a
          // generator suspended at a yield can always be returned, one parked
          // inside an await cannot.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(secondPullSettled).toBe(false);

          keeper.detach();

          // Before the fix this never returned, and neither did anything
          // waiting behind it.
          const exit = yield* Fiber.await(fiber);
          expect(exit._tag).toBe("Success");
          expect(keeper.stdout.readableEnded).toBe(true);
          expect(keeper.killed).toBe(true);
          // Interrupting a fiber that has already ended is what the adapter
          // does next; it must stay a no-op.
          yield* Fiber.interrupt(fiber);

          // Detach is not a kill: the keeper still has the CLI, and its meta
          // records no exit, so the next owner can take it over.
          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
          const meta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(meta.exit).toBeNull();
          expect(isClaudeKeeperAlive(meta)).toBe(true);

          // And the CLI really is still answering, not merely unreaped.
          const next = yield* connectClaudeKeeper({
            socketPath: meta.socketPath,
            since: meta.lastSeq,
          });
          yield* write(next, userMessage("still there?"));
          // Whatever the replay window still holds comes first; the answer to
          // the message just sent is what proves the CLI is alive.
          let answered: Record<string, unknown> | undefined;
          while (answered === undefined) {
            const [line] = yield* readLines(next, 1);
            const message = parse(line!);
            if (message["type"] === "assistant") answered = message;
          }
          expect(toJson(answered["message"])).toContain("still there?");

          next.kill("SIGTERM");
          expect(endedBySigterm(yield* waitForExit(next))).toBe(true);
        }),
      30_000,
    );

    /**
     * The retired keeper must not be able to claim the file its replacement
     * needs.
     *
     * In the wild the trigger is the launch sequence: the server signals the
     * old keeper, clears the directory and starts a new one, and the old
     * keeper's dying write lands in the ~60 ms before the new keeper writes
     * its own. Ownership used to be decided by whoever wrote first into that
     * empty directory, and the dying one usually won — from then on meta.json
     * named a dead pid with an exit recorded, the live keeper was locked out
     * of its own file for good, and the next boot read that exit, called the
     * keeper gone and removed the directory, orphaning a CLI that was still
     * running with nobody able to reach it.
     *
     * That window is a race, so this drives the guard that closes it rather
     * than the timing that opens it: a directory stamped for somebody else is
     * a directory this keeper does not write to, whether or not the file is
     * there to be claimed.
     */
    it.effect(
      "a keeper never writes meta for a directory stamped for another keeper",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000003";
          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);

          const first = yield* spawn(sandbox, threadId);
          yield* readLines(first, 1);
          const mine = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(isClaudeKeeperAlive(mine)).toBe(true);

          // What the launch of a replacement leaves behind: a fresh stamp and
          // no meta file at all.
          yield* Effect.sync(() => {
            NodeFS.writeFileSync(`${paths.metaPath}.owner`, "someone-else");
            NodeFS.rmSync(paths.metaPath, { force: true });
          });

          // The retired keeper's last act is to record its exit.
          first.kill("SIGTERM");
          expect(endedBySigterm(yield* waitForExit(first))).toBe(true);

          // It stayed out of a file that is no longer its business.
          expect(NodeFS.existsSync(paths.metaPath)).toBe(false);
        }),
      30_000,
    );

    /**
     * And the whole sequence end to end: a second keeper for the same thread
     * owns the file, and the first one's death does not take it back.
     */
    it.effect(
      "a replaced keeper cannot claim the meta file of the one that replaced it",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000005";
          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);

          const first = yield* spawn(sandbox, threadId);
          yield* readLines(first, 1);
          const firstMeta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));

          const second = yield* spawn(sandbox, threadId);
          yield* readLines(second, 1);
          const secondMeta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(secondMeta.keeperPid).not.toBe(firstMeta.keeperPid);

          first.kill("SIGTERM");
          expect(endedBySigterm(yield* waitForExit(first))).toBe(true);

          const after = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(after.keeperPid).toBe(secondMeta.keeperPid);
          expect(after.exit).toBeNull();
          expect(isClaudeKeeperAlive(after)).toBe(true);

          second.kill("SIGTERM");
          expect(endedBySigterm(yield* waitForExit(second))).toBe(true);
        }),
      30_000,
    );

    /**
     * meta.json's `lastAck` is written at most once a second, so a server that
     * reattaches from it can ask for messages the previous server had already
     * processed. The keeper's own ack watermark has no such lag and survives
     * the server, so it is the one that decides where the replay starts —
     * otherwise the same assistant text and the same tool rows arrive twice on
     * a continued turn, and nothing downstream de-duplicates them.
     */
    it.effect(
      "a reattach never replays what the previous server had already acknowledged",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000004";
          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);

          const first = yield* spawn(sandbox, threadId);
          yield* readLines(first, 1);
          yield* write(first, initialize("req-1"));
          yield* readLines(first, 1);
          yield* write(first, userMessage("hello"));
          yield* readLines(first, 2);
          // Everything so far is processed, and the keeper is told so.
          first.ack(first.lastSeq);
          const acked = first.lastSeq;
          first.detach();

          // The stale figure on disk: written before the acks landed.
          const meta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(meta.lastAck).toBeLessThan(acked);

          // A new server reattaches from exactly what the file claims.
          const next = yield* connectClaudeKeeper({
            socketPath: meta.socketPath,
            since: meta.lastAck,
          });
          yield* write(next, userMessage("again"));
          const replayed = yield* readLines(next, 2);
          // Only the answer to the new message — no second copy of the first.
          expect(replayed.map((line) => parse(line)["type"])).toEqual(["assistant", "result"]);

          next.kill("SIGTERM");
          expect(endedBySigterm(yield* waitForExit(next))).toBe(true);
        }),
      30_000,
    );

    /**
     * Detach is meant to survive a restart, not a machine. A worktree whose
     * state directory was deleted, an instance the user renamed, a dev server
     * somebody Ctrl-C'd and never came back to — each used to leave a CLI
     * resident for good, holding its stdin open with nobody able to reach it.
     * Two hours in production; milliseconds here, through the --idle-ms the
     * server never passes.
     */
    it.effect(
      "a keeper nobody reconnects to retires itself, CLI and all",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000006";
          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
          const keeper = yield* spawn(sandbox, threadId, 400);
          yield* readLines(keeper, 1);
          const before = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          const cliPid = before.cliPid;
          expect(cliPid).not.toBeNull();
          expect(before.exit).toBeNull();

          // The server goes away and never comes back.
          keeper.detach();

          // The keeper's own exit frame is gone with the socket, so the wait is
          // on the CLI itself: the pid stops existing.
          yield* waitForPidGone(cliPid!);

          const after = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(after.exit).not.toBeNull();
          expect(isClaudeKeeperAlive(after)).toBe(false);
        }),
      30_000,
    );

    it.effect(
      "a keeper somebody reconnects to inside the window is not retired",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeSandbox;
          const threadId = "aaaaaaaa-0000-4000-8000-000000000007";
          const paths = claudeKeeperPaths(sandbox.keepersDir, threadId);
          const first = yield* spawn(sandbox, threadId, 600);
          yield* readLines(first, 1);
          const meta = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));

          first.detach();
          // Back well inside the window: the clock is cleared, not merely reset.
          const second = yield* connectClaudeKeeper({
            socketPath: meta.socketPath,
            since: meta.lastSeq,
          });

          // Past what would have been the deadline, the CLI is still answering.
          // This suite runs with `excludeTestServices`, so the clock is real
          // and a sleep here is the only way to outlast a deadline that lives
          // in another process.
          yield* Effect.sleep("1200 millis");
          yield* write(second, userMessage("still there?"));
          let answered = false;
          while (!answered) {
            const [line] = yield* readLines(second, 1);
            if (parse(line!)["type"] === "assistant") answered = true;
          }
          const alive = Option.getOrThrow(yield* readClaudeKeeperMeta(paths.metaPath));
          expect(alive.exit).toBeNull();

          second.kill("SIGTERM");
          expect(endedBySigterm(yield* waitForExit(second))).toBe(true);
        }),
      30_000,
    );

    it.effect("retiring signals only a process that is that keeper", () =>
      Effect.gen(function* () {
        const meta = {
          version: 1,
          keeperPid: process.pid,
          cliPid: null,
          socketPath: "/nowhere.sock",
          journalPath: "/nowhere.ndjson",
          startedAt: "2026-09-06T00:00:00.000Z",
          lastSeq: 0,
          lastAck: 0,
          initResponse: null,
          cliSessionId: null,
          exit: null,
        };
        // This test process is alive and is not a keeper: left alone.
        expect(yield* retireClaudeKeeper(meta, "/nowhere/meta.json")).toBe("not-a-keeper");
        // A pid nobody has: nothing to retire.
        expect(
          yield* retireClaudeKeeper({ ...meta, keeperPid: 2_147_483_647 }, "/nowhere/meta.json"),
        ).toBe("gone");
      }),
    );

    it.effect(
      "connecting to a keeper that is gone fails rather than hanging",
      () =>
        Effect.gen(function* () {
          const result = yield* connectClaudeKeeper({
            socketPath: NodePath.join(NodeOS.tmpdir(), "ch3-keeper-does-not-exist.sock"),
            since: 0,
          }).pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
        }),
      20_000,
    );
  });
});
