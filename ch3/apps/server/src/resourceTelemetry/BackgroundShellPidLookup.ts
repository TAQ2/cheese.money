/**
 * Which OS process is the shell an agent just put in the background.
 *
 * The provider CLIs answer a backgrounded `Bash` with an id of their own
 * (`btfofidmw`), the handle *they* poll it by. `ps` has never heard of it and
 * `kill` cannot take it, and the person reading the row is usually asking the
 * OS-level question — what is this, how do I watch it, how do I stop it. The
 * stream never carries a pid, so CH3 finds one.
 *
 * It finds it by the one thing that ties a task id to a process exactly: the
 * CLI writes the shell's output to a file named after the id —
 * `/private/tmp/claude-<uid>/<project>/<session>/tasks/<taskId>.output` — and
 * the shell holds that file open as its stdout for as long as it runs. Ask
 * `lsof` which shells have fd 1 on such a file and the answer is the process,
 * not a guess about it. Measured here: ~60 ms restricted to shells, against
 * ~440 ms host-wide. Three earlier versions matched the Bash command text
 * against a periodic host-wide process sample, and lost most rows to a
 * preamble the CLI prefixes to every command, to sample staleness, and to the
 * command arriving on a later event than the task.
 *
 * **A wrong pid is worse than no pid.** Children of the shell inherit its
 * stdout (a subshell in a pipeline, `sleep 45` under `zsh -c "sleep 45"`), so
 * several processes can match; the one reported is the outermost — the one
 * whose parent is not itself a match — because that is the one `kill` should
 * take. Two outermost matches is an ambiguity this refuses rather than
 * resolves.
 *
 * @module resourceTelemetry/BackgroundShellPidLookup
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProcessRunner } from "../processRunner.ts";

export class BackgroundShellPidLookup extends Context.Service<
  BackgroundShellPidLookup,
  {
    /**
     * The pid of the shell running the CLI task `taskId`, or undefined when no
     * single process can be said to be it. Never fails: a pid is an extra, and
     * a row that cannot name one is still a row.
     */
    readonly resolve: (taskId: string) => Effect.Effect<number | undefined>;
  }
>()("ch3/resourceTelemetry/BackgroundShellPidLookup") {}

/** One process `lsof` reported: its pid, its parent, and what its fd 1 is. */
export interface ShellStdoutRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
}

/**
 * `lsof -F pRn` output: one field per line, the first character naming it —
 * `p` pid, `R` parent pid, `n` the file's name — plus `f` for the descriptor,
 * always 1 here and skipped. A `p` line opens a process; the fields that
 * follow belong to it until the next `p`.
 */
export function parseShellStdoutRecords(output: string): ReadonlyArray<ShellStdoutRecord> {
  const records: Array<ShellStdoutRecord> = [];
  let pid: number | undefined;
  let ppid = 0;
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p": {
        const parsed = Number.parseInt(value, 10);
        pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
        ppid = 0;
        break;
      }
      case "R": {
        const parsed = Number.parseInt(value, 10);
        ppid = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
        break;
      }
      case "n":
        if (pid !== undefined) records.push({ pid, ppid, name: value });
        break;
      default:
        break;
    }
  }
  return records;
}

/** The CLIs' task ids are short alphanumerics; anything else is not looked up. */
const TASK_ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * The outermost process whose stdout is `taskId`'s output file, or undefined
 * when there is none — or more than one, which is not a question this can
 * answer with a single number.
 */
export function pickTaskShellPid(
  records: ReadonlyArray<ShellStdoutRecord>,
  taskId: string,
): number | undefined {
  if (!TASK_ID_SHAPE.test(taskId)) return undefined;
  const suffix = `/tasks/${taskId}.output`;
  const matches = records.filter((record) => record.name.endsWith(suffix));
  if (matches.length === 0) return undefined;
  const matched = new Set(matches.map((record) => record.pid));
  let outermost: number | undefined;
  for (const record of matches) {
    if (matched.has(record.ppid)) continue;
    if (outermost !== undefined) return undefined;
    outermost = record.pid;
  }
  return outermost;
}

/** The shells the CLIs run a background command in; `lsof -c` takes a regex between slashes. */
const SHELL_COMMAND_NAMES = "/^(zsh|bash|sh|dash|fish)$/";
/** Well above the ~60 ms measured; past this the process table is the problem, not the task. */
const LSOF_TIMEOUT = Duration.seconds(3);
/** A thousand shells is ~100 KB of this; a machine with more is not one this runs on. */
const LSOF_MAX_OUTPUT_BYTES = 1024 * 1024;

export const layer = Layer.effect(
  BackgroundShellPidLookup,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    return {
      resolve: (taskId: string) =>
        processRunner
          .run({
            command: "lsof",
            // -w: no warnings on stderr. -n/-P: no host or port name lookups,
            // which is where lsof spends its time. -d 1 -a -c: only fd 1, and
            // only of shells — the whole difference between 60 ms and 440 ms.
            args: ["-w", "-n", "-P", "-F", "pRn", "-d", "1", "-a", "-c", SHELL_COMMAND_NAMES],
            timeout: LSOF_TIMEOUT,
            maxOutputBytes: LSOF_MAX_OUTPUT_BYTES,
            outputMode: "truncate",
            timeoutBehavior: "error",
          })
          .pipe(
            // lsof exits 1 when nothing matched and still prints what did, so
            // the parse decides, not the code. Any failure — no lsof on this
            // platform, a timeout — is "unknown", which is what it is.
            Effect.map((output) =>
              pickTaskShellPid(parseShellStdoutRecords(output.stdout), taskId),
            ),
            Effect.orElseSucceed((): number | undefined => undefined),
          ),
    };
  }),
);

/** For an environment that cannot ask its process table: every task answers "unknown". */
export const layerUnavailable = Layer.succeed(BackgroundShellPidLookup, {
  resolve: () => Effect.succeed(undefined),
});
