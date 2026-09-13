import { describe, expect, it } from "vite-plus/test";

import { parseShellStdoutRecords, pickTaskShellPid } from "./BackgroundShellPidLookup.ts";

const TASK_OUTPUT =
  "/private/tmp/claude-501/-Users-conradws-Downloads-CH3/024aef11-b9df-4b0e-8c8a-135c692b6a69/tasks/bkmhsze3s.output";

// The verbatim shape of `lsof -F pRn -d 1 -a -c '/^(zsh|bash|sh|dash|fish)$/'`
// on the machine this was written on: a terminal's shell on its tty, then the
// zsh the CLI spawned for a backgrounded task with its stdout on the task's
// output file, then a subshell of that zsh which inherited the same stdout.
const OUTPUT = [
  "p15345",
  "R1869",
  "f1",
  "n/dev/ttys012",
  "p15611",
  "R1869",
  "f1",
  `n${TASK_OUTPUT}`,
  "p15613",
  "R15611",
  "f1",
  `n${TASK_OUTPUT}`,
  "",
].join("\n");

describe("parseShellStdoutRecords", () => {
  it("reads one record per process, with its parent and the file on fd 1", () => {
    expect(parseShellStdoutRecords(OUTPUT)).toEqual([
      { pid: 15345, ppid: 1869, name: "/dev/ttys012" },
      { pid: 15611, ppid: 1869, name: TASK_OUTPUT },
      { pid: 15613, ppid: 15611, name: TASK_OUTPUT },
    ]);
  });

  it("drops what it cannot read rather than inventing a process", () => {
    expect(parseShellStdoutRecords("")).toEqual([]);
    expect(parseShellStdoutRecords("n/dev/ttys000\n")).toEqual([]);
    expect(parseShellStdoutRecords("pabc\nf1\nn/dev/ttys000\n")).toEqual([]);
    // No parent field: still a process, parent unknown.
    expect(parseShellStdoutRecords("p42\nf1\nn/dev/ttys000\n")).toEqual([
      { pid: 42, ppid: 0, name: "/dev/ttys000" },
    ]);
  });
});

describe("pickTaskShellPid", () => {
  const records = parseShellStdoutRecords(OUTPUT);

  it("names the outermost shell on the task's output file, not its subshell", () => {
    // 15613 inherited the file from 15611. `kill 15613` would leave the task
    // running; the shell the CLI spawned is the handle worth showing.
    expect(pickTaskShellPid(records, "bkmhsze3s")).toBe(15611);
  });

  it("answers nothing for a task whose shell is not there", () => {
    expect(pickTaskShellPid(records, "btfofidmw")).toBeUndefined();
    expect(pickTaskShellPid([], "bkmhsze3s")).toBeUndefined();
  });

  it("refuses two unrelated shells on one task's file rather than pick one", () => {
    expect(
      pickTaskShellPid(
        [
          { pid: 100, ppid: 1, name: TASK_OUTPUT },
          { pid: 200, ppid: 1, name: TASK_OUTPUT },
        ],
        "bkmhsze3s",
      ),
    ).toBeUndefined();
  });

  it("matches the whole file name, not a task id that happens to be a suffix of another", () => {
    expect(
      pickTaskShellPid([{ pid: 7, ppid: 1, name: "/x/tasks/xbkmhsze3s.output" }], "bkmhsze3s"),
    ).toBeUndefined();
  });

  it("does not look up an id that is not shaped like the CLI's", () => {
    expect(pickTaskShellPid(records, "../bkmhsze3s")).toBeUndefined();
    expect(pickTaskShellPid(records, "")).toBeUndefined();
  });
});
