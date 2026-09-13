// Resumes one real Codex thread through `codex app-server` with the schemas this package
// ships, and prints the sub-agent activity kinds it decoded. Run it after cherry-picking a
// protocol compatibility fix, against the thread that failed to resume:
//
//   CODEX_THREAD_ID=<codex thread id> CODEX_CWD=<thread cwd> \
//     node test/examples/codex-thread-resume-probe.ts
//
// The Codex thread id is the `resume_cursor_json.threadId` of the CH3 thread in
// `provider_session_runtime`. Reads only; it never starts a turn.
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as CodexClient from "../../src/client.ts";

const threadId = process.env.CODEX_THREAD_ID;
const cwd = process.env.CODEX_CWD ?? process.cwd();
if (!threadId) {
  throw new Error("CODEX_THREAD_ID is required");
}

const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.env.CODEX_BIN ?? "codex", ["app-server"], { cwd, shell: false }),
  );
  const codexLayer = CodexClient.layerChildProcess(handle, {});

  yield* Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    yield* client.request("initialize", {
      clientInfo: {
        name: "codex-thread-resume-probe",
        title: "Codex thread resume probe",
        version: "0.0.0",
      },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null },
    });
    yield* client.notify("initialized", undefined);

    const resumed = yield* client.request("thread/resume", { threadId, cwd });
    const subAgentActivityKinds: Record<string, number> = {};
    let items = 0;
    for (const turn of resumed.thread.turns) {
      for (const item of turn.items) {
        items += 1;
        if (item.type === "subAgentActivity") {
          subAgentActivityKinds[item.kind] = (subAgentActivityKinds[item.kind] ?? 0) + 1;
        }
      }
    }
    yield* Console.log("thread/resume OK", {
      threadId: resumed.thread.id,
      turns: resumed.thread.turns.length,
      items,
      subAgentActivityKinds,
      model: resumed.model,
    });
  }).pipe(Effect.provide(codexLayer));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
