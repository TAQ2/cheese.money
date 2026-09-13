import type { ChatAttachment } from "@ch3tools/contracts";
import type { QuestionRequest } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@ch3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@ch3tools/shared/Net";

import {
  buildOpenCodePermissionRules,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  parseAgentListCliOutput,
  parseModelsCliOutput,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
} from "./opencodeRuntime.ts";

describe("describing an OpenCode failure", () => {
  it("keeps its own error's detail rather than re-stringifying it", () => {
    const error = new OpenCodeRuntimeError({
      operation: "provider.list",
      detail: "OpenCode provider list was empty.",
    });
    expect(openCodeRuntimeErrorDetail(error)).toBe("OpenCode provider list was empty.");
    expect(OpenCodeRuntimeError.is(error)).toBe(true);
    expect(OpenCodeRuntimeError.is(new Error("provider.list"))).toBe(false);
  });

  it("unpacks the SDK v2 throw shape into a status and a body", () => {
    // What `@opencode-ai/sdk/v2` actually throws with `throwOnError`: a
    // `{ response, request, error }` triple whose own `toString` is
    // "[object Object]". Reporting that told nobody anything.
    expect(
      openCodeRuntimeErrorDetail({
        response: { status: 401, statusText: "Unauthorized" },
        request: { method: "GET", url: "http://127.0.0.1:9999/provider" },
        error: { data: { message: "invalid api key" } },
      }),
    ).toBe('status=401 body={"data":{"message":"invalid api key"}}');
  });

  it("says the status is unknown rather than pretending it was zero", () => {
    expect(openCodeRuntimeErrorDetail({ error: "boom" })).toBe('status=? body="boom"');
    // No `error`/`data`/`body` key at all: the whole throw is the evidence.
    expect(openCodeRuntimeErrorDetail({ response: { status: 500 } })).toBe(
      'status=500 body={"response":{"status":500}}',
    );
  });

  it("prefers an Error's message, and falls back when it is blank", () => {
    expect(openCodeRuntimeErrorDetail(new Error("  ECONNREFUSED 127.0.0.1:9999  "))).toBe(
      "ECONNREFUSED 127.0.0.1:9999",
    );
    // A blank message falls past the `instanceof Error` arm (it requires a
    // non-empty trimmed message) and into the object arm, because an Error IS
    // an object. There is no status and no `error`/`data`/`body` key, so the
    // Error itself gets encoded — and JSON renders an Error as `{}`.
    // So a blank-message Error reports as the shape below, NOT as "Error".
    // Pinned deliberately: it is a poor diagnostic, and this asserts the
    // current contract so that improving it has to be a deliberate change.
    expect(openCodeRuntimeErrorDetail(new Error("   "))).toBe("status=? body={}");
  });

  it("survives a value JSON cannot encode", () => {
    // A cyclic throw is real: SDK error objects reference their own request,
    // which references the response. `JSON.stringify` throws on it, and an
    // exception raised while building an error message loses the error.
    const cyclic: Record<string, unknown> = { response: { status: 502 } };
    cyclic.self = cyclic;
    expect(openCodeRuntimeErrorDetail(cyclic)).toBe("[object Object]");
  });

  it("describes the primitives without inventing a shape", () => {
    expect(openCodeRuntimeErrorDetail(null)).toBe("null");
    expect(openCodeRuntimeErrorDetail(undefined)).toBe("undefined");
    expect(openCodeRuntimeErrorDetail("plain string")).toBe("plain string");
    expect(openCodeRuntimeErrorDetail(404)).toBe("404");
  });
});

describe("wrapping an SDK promise", () => {
  it.effect("passes a resolved value through untouched", () =>
    Effect.gen(function* () {
      expect(
        yield* runOpenCodeSdk("app.agents", () => Promise.resolve({ data: ["build"] })),
      ).toEqual({ data: ["build"] });
    }),
  );

  it.effect("turns a rejection into a tagged error naming the operation", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runOpenCodeSdk("command.list", () =>
          Promise.reject({ response: { status: 404 }, error: { message: "no route" } }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = yield* Effect.flip(
        runOpenCodeSdk("command.list", () =>
          Promise.reject({ response: { status: 404 }, error: { message: "no route" } }),
        ),
      );
      // The operation is how the log line says which call broke; the detail is
      // how it says why.
      expect(failure.operation).toBe("command.list");
      expect(failure.detail).toBe('status=404 body={"message":"no route"}');
    }),
  );
});

/**
 * `opencode models --verbose` prints a bare `provider/model` slug on its own
 * line followed by that model's JSON, pretty-printed and indented. This is the
 * fallback inventory path: when the SDK server cannot be reached, the CLI's
 * stdout is the only description of what models exist.
 */
describe("parsing the models CLI output", () => {
  const modelBlock = (id: string, name: string) =>
    ["{", `  "id": "${id}",`, `  "name": "${name}",`, '  "attachment": true', "}"].join("\n");

  it("groups models under their provider and reports the provider order", () => {
    const parsed = parseModelsCliOutput(
      [
        "anthropic/claude-sonnet-4-5",
        modelBlock("claude-sonnet-4-5", "Claude Sonnet 4.5"),
        "anthropic/claude-haiku-4-5",
        modelBlock("claude-haiku-4-5", "Claude Haiku 4.5"),
        "openai/gpt-5",
        modelBlock("gpt-5", "GPT-5"),
      ].join("\n"),
    );

    expect(parsed.connected).toEqual(["anthropic", "openai"]);
    expect(Object.keys(parsed.providers.get("anthropic")!.models)).toEqual([
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
    expect(parsed.providers.get("anthropic")!.models["claude-sonnet-4-5"]!.name).toBe(
      "Claude Sonnet 4.5",
    );
    // The provider's own display name is not in this output, so the id stands
    // in for it rather than the row rendering blank.
    expect(parsed.providers.get("openai")).toMatchObject({ id: "openai", name: "openai" });
  });

  it("splits on the first slash, so a model id may itself contain slashes", () => {
    // Real slugs from OpenRouter and Bedrock carry a nested path.
    const parsed = parseModelsCliOutput(
      ["openrouter/anthropic/claude-sonnet-4-5", modelBlock("x", "X")].join("\n"),
    );
    expect(parsed.connected).toEqual(["openrouter"]);
    expect(Object.keys(parsed.providers.get("openrouter")!.models)).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("skips a model whose JSON is broken without losing the next one", () => {
    // The failure that mattered: one truncated block used to abort the parse
    // and report the whole machine as having no models at all.
    const parsed = parseModelsCliOutput(
      ["anthropic/broken", '{ "id": "broken", ', "openai/gpt-5", modelBlock("gpt-5", "GPT-5")].join(
        "\n",
      ),
    );
    expect(parsed.connected).toEqual(["openai"]);
    expect(parsed.providers.has("anthropic")).toBe(false);
    expect(parsed.providers.get("openai")!.models["gpt-5"]!.name).toBe("GPT-5");
  });

  it("drops a slug with no JSON body after it", () => {
    expect(parseModelsCliOutput("anthropic/claude-sonnet-4-5\n\n   \n").connected).toEqual([]);
  });

  it("ignores preamble printed before the first slug", () => {
    const parsed = parseModelsCliOutput(
      ["Loading providers...", "", "openai/gpt-5", modelBlock("gpt-5", "GPT-5")].join("\n"),
    );
    expect(parsed.connected).toEqual(["openai"]);
  });

  it("tolerates trailing whitespace on the slug line", () => {
    expect(
      parseModelsCliOutput(["openai/gpt-5   ", modelBlock("gpt-5", "GPT-5")].join("\n")).connected,
    ).toEqual(["openai"]);
  });

  it("reports nothing for empty output rather than throwing", () => {
    expect(parseModelsCliOutput("")).toEqual({ providers: new Map(), connected: [] });
    expect(parseModelsCliOutput("\n\n\n").connected).toEqual([]);
  });
});

/**
 * `opencode agent list` prints `name (mode)` and then that agent's permission
 * JSON. The CLI does not print the hidden flag, so the runtime supplies it
 * from a list kept in step with OpenCode's own agent definitions.
 */
describe("parsing the agent list CLI output", () => {
  const permissionBlock = '{\n  "bash": "ask",\n  "edit": "allow"\n}';

  it("reads each agent's name, mode and permissions", () => {
    const agents = parseAgentListCliOutput(
      ["build (primary)", permissionBlock, "general (subagent)", permissionBlock].join("\n"),
    );
    expect(agents).toEqual([
      {
        name: "build",
        mode: "primary",
        hidden: false,
        permission: { bash: "ask", edit: "allow" },
        options: {},
      },
      {
        name: "general",
        mode: "subagent",
        hidden: false,
        permission: { bash: "ask", edit: "allow" },
        options: {},
      },
    ]);
  });

  it("hides the three agents OpenCode itself never shows", () => {
    // `compaction`, `summary` and `title` are internal. Listing them puts three
    // agents nobody can pick into the picker.
    const agents = parseAgentListCliOutput(
      [
        "compaction (subagent)",
        permissionBlock,
        "summary (subagent)",
        permissionBlock,
        "title (subagent)",
        permissionBlock,
        "plan (primary)",
        permissionBlock,
      ].join("\n"),
    );
    expect(agents.map((agent) => [agent.name, agent.hidden])).toEqual([
      ["compaction", true],
      ["summary", true],
      ["title", true],
      ["plan", false],
    ]);
  });

  it("keeps a multi-word agent name intact", () => {
    expect(
      parseAgentListCliOutput(["code review (subagent)", permissionBlock].join("\n"))[0],
    ).toMatchObject({ name: "code review", mode: "subagent" });
  });

  it("skips a header with no body and one with broken JSON", () => {
    expect(parseAgentListCliOutput("build (primary)")).toEqual([]);
    expect(parseAgentListCliOutput(["build (primary)", '{ "bash": '].join("\n"))).toEqual([]);
    // And a broken one does not take its healthy neighbour with it.
    expect(
      parseAgentListCliOutput(
        ["build (primary)", '{ "bash": ', "plan (primary)", permissionBlock].join("\n"),
      ).map((agent) => agent.name),
    ).toEqual(["plan"]);
  });

  it("reports nothing for empty output", () => {
    expect(parseAgentListCliOutput("")).toEqual([]);
    expect(parseAgentListCliOutput("no agents configured")).toEqual([]);
  });
});

describe("parsing a model slug", () => {
  it("splits a well-formed slug on its first separator", () => {
    expect(parseOpenCodeModelSlug("anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
    expect(parseOpenCodeModelSlug("  openrouter/anthropic/claude-sonnet-4-5  ")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4-5",
    });
  });

  it("refuses a slug that names only half of a model", () => {
    // Each of these used to be split into a provider or a model of "", which
    // the SDK accepts and then answers with a 404 nobody could read.
    for (const slug of ["", "   ", "anthropic", "/claude-sonnet-4-5", "anthropic/", "/"]) {
      expect(parseOpenCodeModelSlug(slug)).toBeNull();
    }
  });

  it("has no opinion about a missing slug", () => {
    expect(parseOpenCodeModelSlug(null)).toBeNull();
    expect(parseOpenCodeModelSlug(undefined)).toBeNull();
  });
});

describe("identifying a question", () => {
  const question = (header: string, text = "Which one?"): QuestionRequest["questions"][number] => ({
    header,
    question: text,
    options: [],
  });

  it("slugs the header so the id survives a round trip through a form field", () => {
    expect(openCodeQuestionId(0, question("Pick a Branch!"))).toBe("question-0-pick-a-branch-");
    expect(openCodeQuestionId(2, question("DB_HOST"))).toBe("question-2-db_host");
  });

  it("falls back to the index when the header slugs to nothing", () => {
    // The bare-index fallback fires only when the slug is genuinely empty,
    // which in practice means a whitespace-only header.
    expect(openCodeQuestionId(1, question("   "))).toBe("question-1");

    // Punctuation and CJK do NOT reach that fallback. `[^a-z0-9_-]+` collapses
    // each run to a single "-", so the slug is "-" — one character, non-empty
    // — and the id keeps a trailing separator. Worth knowing before relying on
    // the fallback: it is narrower than its name suggests.
    expect(openCodeQuestionId(0, question("???"))).toBe("question-0--");
    expect(openCodeQuestionId(3, question("続けますか"))).toBe("question-3--");
  });
});

describe("turning attachments into OpenCode file parts", () => {
  const attachment = (name: string, mimeType: string): ChatAttachment =>
    ({ id: `att-${name}`, name, mimeType, size: 12 }) as unknown as ChatAttachment;

  it("addresses each resolvable attachment as a file URL", () => {
    const parts = toOpenCodeFileParts({
      attachments: [attachment("shot.png", "image/png")],
      resolveAttachmentPath: () => "/tmp/ch3/attachments/my shot.png",
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "file", mime: "image/png", filename: "shot.png" });
    // A space in the path has to be percent-encoded or OpenCode reads the URL
    // as two arguments and reports the file as missing.
    expect(parts[0]!.url).toBe("file:///tmp/ch3/attachments/my%20shot.png");
  });

  it("skips an attachment whose file is gone instead of sending a null path", () => {
    expect(
      toOpenCodeFileParts({
        attachments: [attachment("a.png", "image/png"), attachment("b.png", "image/png")],
        resolveAttachmentPath: (candidate) => (candidate.name === "b.png" ? "/tmp/b.png" : null),
      }).map((part) => part.filename),
    ).toEqual(["b.png"]);
  });

  it("returns nothing when the turn carried no attachments", () => {
    expect(
      toOpenCodeFileParts({ attachments: undefined, resolveAttachmentPath: () => "/tmp/x" }),
    ).toEqual([]);
    expect(toOpenCodeFileParts({ attachments: [], resolveAttachmentPath: () => "/tmp/x" })).toEqual(
      [],
    );
  });
});

describe("mapping a runtime mode onto OpenCode permissions", () => {
  it("waves everything through in full access", () => {
    expect(buildOpenCodePermissionRules("full-access")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  it("asks for every capability in every other mode", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = buildOpenCodePermissionRules(mode);
      const asked = rules.filter((rule) => rule.action === "ask").map((rule) => rule.permission);
      expect(asked).toContain("bash");
      expect(asked).toContain("edit");
      expect(asked).toContain("external_directory");
      expect(asked).toContain("doom_loop");
      expect(rules.some((rule) => rule.action === "allow" && rule.permission === "*")).toBe(false);
    }
  });

  it("always allows `question`, which is how the agent asks in the first place", () => {
    // A gated `question` deadlocks the turn: OpenCode would have to ask
    // permission to ask, and the approval it needs never arrives.
    const rules = buildOpenCodePermissionRules("approval-required");
    expect(rules.find((rule) => rule.permission === "question")).toEqual({
      permission: "question",
      pattern: "*",
      action: "allow",
    });
  });
});

describe("replying to an OpenCode permission prompt", () => {
  it("distinguishes this once from for the whole session", () => {
    expect(toOpenCodePermissionReply("accept")).toBe("once");
    expect(toOpenCodePermissionReply("acceptForSession")).toBe("always");
  });

  it("treats every refusal, including a cancel, as a rejection", () => {
    // A cancelled prompt that fell through to "allow" would run the command
    // the user just backed out of.
    expect(toOpenCodePermissionReply("decline")).toBe("reject");
    expect(toOpenCodePermissionReply("cancel")).toBe("reject");
  });
});

describe("collecting question answers", () => {
  const request = (
    questions: ReadonlyArray<{ readonly header: string; readonly question: string }>,
  ): QuestionRequest =>
    ({
      id: "req-1",
      sessionID: "session-1",
      questions: questions.map((entry) => ({ ...entry, options: [] })),
    }) as unknown as QuestionRequest;

  it("answers positionally, in the order the request asked", () => {
    const answers = toOpenCodeQuestionAnswers(
      request([
        { header: "Branch", question: "Which branch?" },
        { header: "Confirm", question: "Proceed?" },
      ]),
      { "question-0-branch": "main", "question-1-confirm": "yes" },
    );
    // OpenCode matches answers to questions by index, so a reordered or short
    // array answers the wrong question.
    expect(answers).toEqual([["main"], ["yes"]]);
  });

  it("accepts the header or the question text as a key", () => {
    // Older clients keyed replies by the human-readable label; both still
    // resolve so a mid-turn client upgrade does not lose the answer.
    expect(
      toOpenCodeQuestionAnswers(request([{ header: "Branch", question: "Which branch?" }]), {
        Branch: "develop",
      }),
    ).toEqual([["develop"]]);
    expect(
      toOpenCodeQuestionAnswers(request([{ header: "Branch", question: "Which branch?" }]), {
        "Which branch?": "release",
      }),
    ).toEqual([["release"]]);
  });

  it("prefers the generated id over the looser fallbacks", () => {
    expect(
      toOpenCodeQuestionAnswers(request([{ header: "Branch", question: "Which branch?" }]), {
        "question-0-branch": "main",
        Branch: "wrong",
        "Which branch?": "also wrong",
      }),
    ).toEqual([["main"]]);
  });

  it("keeps a multi-select's strings and drops the rest", () => {
    expect(
      toOpenCodeQuestionAnswers(request([{ header: "Files", question: "Which files?" }]), {
        "question-0-files": ["a.ts", 7, null, "b.ts", { path: "c.ts" }],
      }),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  it("answers nothing rather than something empty when the reply is missing or blank", () => {
    // An empty array is OpenCode's "skipped"; a `[""]` is an answer of the
    // empty string, which it validates and rejects.
    for (const raw of [undefined, "", "   ", 42, true, { value: "x" }]) {
      expect(
        toOpenCodeQuestionAnswers(request([{ header: "Branch", question: "Which branch?" }]), {
          "question-0-branch": raw,
        }),
      ).toEqual([[]]);
    }
  });

  it("returns one entry per question even when nothing was answered", () => {
    expect(
      toOpenCodeQuestionAnswers(
        request([
          { header: "A", question: "a?" },
          { header: "B", question: "b?" },
          { header: "C", question: "c?" },
        ]),
        {},
      ),
    ).toEqual([[], [], []]);
    expect(toOpenCodeQuestionAnswers(request([]), { anything: "here" })).toEqual([]);
  });
});

/**
 * The runtime service itself, against a scripted spawner.
 *
 * Pinning a non-win32 platform makes `resolveSpawnCommand` a no-op, so the
 * `command`/`args` assertions below hold on any host.
 */
describe("the OpenCode runtime service", () => {
  const encoder = new TextEncoder();

  interface Spawn {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
  }

  interface ScriptedResult {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
  }

  const handle = (result: ScriptedResult) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(encoder.encode(result.stdout ?? "")),
      stderr: Stream.make(encoder.encode(result.stderr ?? "")),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  /**
   * `models --verbose` and `agent list` run in parallel and are retried once
   * after a second, so each is scripted as a queue of attempts.
   */
  const spawnerLayer = (
    script: (spawn: Spawn, attempt: number) => ScriptedResult,
    spawns: Array<Spawn>,
  ) =>
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        // `ChildProcess.make(command, args, options)` keeps the spawn options
        // — env included — under `options`, NOT on the command itself. Reading
        // `.env` here yields undefined for every spawn, which silently turns
        // any "the key is absent" assertion into a false pass.
        const childProcess = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly options?: { readonly env?: NodeJS.ProcessEnv };
        };
        const spawn: Spawn = {
          command: childProcess.command,
          args: childProcess.args,
          env: childProcess.options?.env,
        };
        const attempt = spawns.filter(
          (previous) => previous.args.join(" ") === spawn.args.join(" "),
        ).length;
        spawns.push(spawn);
        return Effect.succeed(handle(script(spawn, attempt)));
      }),
    );

  const runtimeLayer = (
    script: (spawn: Spawn, attempt: number) => ScriptedResult,
    spawns: Array<Spawn>,
  ) =>
    OpenCodeRuntimeLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          spawnerLayer(script, spawns),
          Layer.succeed(HostProcessPlatform, "linux"),
          NetService.layer,
        ),
      ),
    );

  const modelsStdout = [
    "anthropic/claude-sonnet-4-5",
    '{ "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5" }',
  ].join("\n");
  const agentsStdout = ["build (primary)", '{ "bash": "ask" }'].join("\n");

  it.effect("runs a command and reports its streams and exit code", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: "/opt/homebrew/bin/opencode",
        args: ["--version"],
      });
      expect(result).toEqual({ stdout: "1.0.44\n", stderr: "warn: beta\n", code: 0 });
    }).pipe(
      Effect.provide(
        runtimeLayer(() => ({ stdout: "1.0.44\n", stderr: "warn: beta\n", code: 0 }), []),
      ),
    ),
  );

  it.effect("passes a non-zero exit back as a result, not a failure", () =>
    Effect.gen(function* () {
      // `loadInventoryFromCli` decides what a non-zero code means; the command
      // runner must not pre-empt it by dying.
      const runtime = yield* OpenCodeRuntime;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: "opencode",
        args: ["models"],
        environment: { PATH: "/usr/bin" },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("database is locked");
    }).pipe(Effect.provide(runtimeLayer(() => ({ stderr: "database is locked", code: 1 }), []))),
  );

  it.effect("builds the inventory from both CLI calls in one pass", () =>
    Effect.gen(function* () {
      const spawns: Array<Spawn> = [];
      const inventory = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.loadInventoryFromCli({ binaryPath: "opencode" });
      }).pipe(
        Effect.provide(
          runtimeLayer(
            (spawn) =>
              spawn.args[0] === "models" ? { stdout: modelsStdout } : { stdout: agentsStdout },
            spawns,
          ),
        ),
      );

      expect(inventory.providerList.connected).toEqual(["anthropic"]);
      expect(inventory.providerList.all[0]).toMatchObject({
        id: "anthropic",
        name: "anthropic",
        source: "config",
      });
      expect(Object.keys(inventory.providerList.all[0]!.models)).toEqual(["claude-sonnet-4-5"]);
      expect(inventory.agents.map((agent) => agent.name)).toEqual(["build"]);
      // One attempt each, no retry: the happy path must not cost a second.
      expect(spawns.map((spawn) => spawn.args)).toEqual([
        ["models", "--verbose"],
        ["agent", "list"],
      ]);
    }),
  );

  it.effect("retries once, a second later, when the models command fails", () =>
    Effect.gen(function* () {
      // The real failure: OpenCode's SQLite store reports "database is locked"
      // when two of its processes start together, and the inventory came back
      // empty — which the UI renders as a provider with no models.
      const spawns: Array<Spawn> = [];
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.loadInventoryFromCli({ binaryPath: "opencode" });
        }).pipe(
          Effect.provide(
            runtimeLayer((spawn, attempt) => {
              if (spawn.args[0] === "agent") {
                return { stdout: agentsStdout };
              }
              return attempt === 0
                ? { stderr: "SqliteError: database is locked", code: 1 }
                : { stdout: modelsStdout };
            }, spawns),
          ),
        ),
      );

      yield* TestClock.adjust(Duration.millis(0));
      // Still inside the one-second pause: only the first pair has run.
      expect(spawns).toHaveLength(2);
      yield* TestClock.adjust(Duration.seconds(1));
      const inventory = yield* Fiber.join(fiber);

      expect(inventory.providerList.connected).toEqual(["anthropic"]);
      // Only the failed call is retried; the healthy `agent list` is not
      // spawned a second time.
      expect(spawns.map((spawn) => spawn.args.join(" "))).toEqual([
        "models --verbose",
        "agent list",
        "models --verbose",
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails with the exit code when the models command never recovers", () =>
    Effect.gen(function* () {
      const spawns: Array<Spawn> = [];
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.loadInventoryFromCli({ binaryPath: "opencode" });
        }).pipe(
          Effect.provide(
            runtimeLayer(
              (spawn) =>
                spawn.args[0] === "models"
                  ? { stderr: "SqliteError: database is locked", code: 17 }
                  : { stdout: agentsStdout },
              spawns,
            ),
          ),
          Effect.flip,
        ),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const failure = yield* Fiber.join(fiber);

      // A model list nobody could read must be a failure, not an empty
      // inventory: empty is indistinguishable from "this provider has no
      // models" and silently removes every model from the picker.
      expect(failure.operation).toBe("loadInventoryFromCli");
      expect(failure.detail).toBe("OpenCode models command exited with code 17.");
      expect(spawns.filter((spawn) => spawn.args[0] === "models")).toHaveLength(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still reports the models when only the agent list fails", () =>
    Effect.gen(function* () {
      const spawns: Array<Spawn> = [];
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.loadInventoryFromCli({
            binaryPath: "opencode",
            environment: { PATH: "/usr/bin" },
          });
        }).pipe(
          Effect.provide(
            runtimeLayer(
              (spawn) =>
                spawn.args[0] === "models" ? { stdout: modelsStdout } : { stderr: "boom", code: 1 },
              spawns,
            ),
          ),
        ),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const inventory = yield* Fiber.join(fiber);

      // Agent metadata only enriches capabilities. Failing the whole inventory
      // over it would take the models down with it.
      expect(inventory.providerList.connected).toEqual(["anthropic"]);
      expect(inventory.agents).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not spawn anything for a server URL it does not own", () =>
    Effect.gen(function* () {
      const spawns: Array<Spawn> = [];
      const connection = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.connectToOpenCodeServer({
          binaryPath: "opencode",
          serverUrl: "  http://127.0.0.1:4096  ",
        });
      }).pipe(Effect.scoped, Effect.provide(runtimeLayer(() => ({}), spawns)));

      // `external: true` is what stops the scope's finalizer from killing a
      // server the engineer started themselves, and `exitCode: null` says
      // there is no child of ours to wait on.
      expect(connection).toMatchObject({
        url: "http://127.0.0.1:4096",
        exitCode: null,
        external: true,
      });
      expect(spawns).toEqual([]);
    }),
  );

  it.live("treats a blank server URL as no URL and starts its own", () =>
    Effect.gen(function* () {
      // A settings field the engineer cleared leaves `"   "` behind. Read as a
      // URL it produces a client pointed at nothing.
      const spawns: Array<Spawn> = [];
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.connectToOpenCodeServer({
            binaryPath: "opencode",
            serverUrl: "   ",
            port: 4096,
            timeoutMs: 5_000,
          });
        }).pipe(
          Effect.scoped,
          Effect.provide(runtimeLayer(() => ({ stdout: "", code: 0 }), spawns)),
        ),
      );

      // The scripted child exits immediately without printing a ready line,
      // so startup fails — but it failed having actually tried to spawn.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(spawns.map((spawn) => spawn.args)).toEqual([
        ["serve", "--hostname=127.0.0.1", "--port=4096"],
      ]);
    }),
  );

  it.live("attaches the child's own output when the server dies at startup", () =>
    Effect.gen(function* () {
      const spawns: Array<Spawn> = [];
      const failure = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.startOpenCodeServerProcess({
          binaryPath: "opencode",
          port: 4096,
          hostname: "0.0.0.0",
          timeoutMs: 10_000,
        });
      }).pipe(
        Effect.scoped,
        Effect.flip,
        Effect.provide(
          runtimeLayer(() => ({ stderr: "error: port 4096 already in use", code: 1 }), spawns),
        ),
      );

      expect(failure.operation).toBe("startOpenCodeServerProcess");
      // A bare "failed to start" is the one failure that carries no evidence
      // at all; the child's stderr is the whole diagnosis.
      expect(failure.detail).toContain("exited before startup completed");
      expect(failure.detail).toContain("port 4096 already in use");
      expect(spawns[0]!.args).toEqual(["serve", "--hostname=0.0.0.0", "--port=4096"]);
    }),
  );

  it.live("reads the listening URL out of the ready line", () =>
    Effect.gen(function* () {
      // The real line OpenCode prints on startup.
      const spawns: Array<Spawn> = [];
      const server = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.startOpenCodeServerProcess({
          binaryPath: "opencode",
          port: 4096,
          timeoutMs: 10_000,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          runtimeLayer(
            () => ({ stdout: "opencode server listening on http://127.0.0.1:4096\n" }),
            spawns,
          ),
        ),
      );
      expect(server.url).toBe("http://127.0.0.1:4096");
    }),
  );
});
