import { describe, it, assert } from "@effect/vitest";

import {
  extractReportedProblem,
  resolveProviderUpdateOutcome,
  type ProviderUpdateProbe,
} from "./providerUpdateOutcome.ts";

const cleanExit = { stdout: "", stderr: "", exitCode: 0, timedOut: false } as const;

const probe = (overrides: Partial<ProviderUpdateProbe> = {}): ProviderUpdateProbe => ({
  verified: true,
  versionBefore: "1.18.23",
  versionAfter: "1.18.23",
  installedBefore: true,
  installedAfter: true,
  advisoryStatus: "behind_latest",
  ...overrides,
});

describe("extractReportedProblem", () => {
  it("keeps the line that carries the cause, not just the first one", () => {
    // opencode leads with a line that says nothing ("Unexpected error") and
    // follows it with the one that says everything.
    const problem = extractReportedProblem({
      stdout: "● Using method: curl",
      stderr:
        "Error: Unexpected error\nStatusCode: non 2xx status code (403 GET https://api.github.com/repos/anomalyco/opencode/releases/latest)",
    });

    assert.include(problem ?? "", "Unexpected error");
    assert.include(problem ?? "", "403 GET https://api.github.com");
  });

  it("strips ANSI colouring so the message is readable in a toast", () => {
    const escape = String.fromCharCode(27);
    const problem = extractReportedProblem({
      stdout: "",
      stderr: `${escape}[31mError: ENOTFOUND registry.npmjs.org${escape}[0m`,
    });

    assert.strictEqual(problem, "Error: ENOTFOUND registry.npmjs.org");
  });

  it("says nothing when the command said nothing worth repeating", () => {
    assert.strictEqual(
      extractReportedProblem({ stdout: "changed 0 packages in 412ms", stderr: "" }),
      null,
    );
  });
});

describe("resolveProviderUpdateOutcome", () => {
  it("treats a moved version as the only proof of success", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: { ...cleanExit, stdout: "upgraded" },
      probe: probe({ versionAfter: "1.18.24", advisoryStatus: "current" }),
      manualCommand: "opencode upgrade",
    });

    assert.deepStrictEqual(outcome, {
      status: "succeeded",
      message: "Updated from 1.18.23 to 1.18.24.",
    });
  });

  it("counts a first install as a success even when no version can be read", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: cleanExit,
      probe: probe({
        installedBefore: false,
        versionBefore: null,
        versionAfter: null,
        advisoryStatus: "unknown",
      }),
      manualCommand: null,
    });

    assert.strictEqual(outcome.status, "succeeded");
  });

  it("fails a clean exit that left an outdated provider where it was", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: {
        ...cleanExit,
        stderr:
          "StatusCode: non 2xx status code (403 GET https://api.github.com/repos/anomalyco/opencode/releases/latest)",
      },
      probe: probe(),
      manualCommand: "opencode upgrade",
    });

    assert.strictEqual(outcome.status, "failed");
    assert.include(outcome.message, "still on 1.18.23");
    assert.include(outcome.message, "403 GET");
    assert.include(outcome.message, "hourly quota");
    // Telling someone to re-run the command that just spent the quota would
    // only spend the next request too.
    assert.notInclude(outcome.message, "by hand");
  });

  it("quotes the mechanism's own command when the failure is not a known class", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: { ...cleanExit, stderr: "the vendor said no" },
      probe: probe(),
      manualCommand: "brew upgrade anomalyco/tap/opencode",
    });

    assert.strictEqual(outcome.status, "failed");
    assert.include(outcome.message, "brew upgrade anomalyco/tap/opencode");
  });

  it("leaves an already-current provider alone", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: { ...cleanExit, stdout: "changed 0 packages" },
      probe: probe({ advisoryStatus: "current" }),
      manualCommand: "npm install -g opencode-ai@latest",
    });

    assert.deepStrictEqual(outcome, {
      status: "unchanged",
      message: "This provider is already up to date.",
    });
  });

  it("does not guess when the version could not be read back", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: cleanExit,
      probe: probe({ versionAfter: null, versionBefore: null, advisoryStatus: "unknown" }),
      manualCommand: null,
    });

    assert.strictEqual(outcome.status, "unchanged");
    assert.include(outcome.message, "could not verify");
  });

  it("still fails a non-zero exit, and carries what the command said", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: {
        stdout: "",
        stderr: "npm ERR! code EACCES\nnpm ERR! permission denied, mkdir '/usr/local/lib'",
        exitCode: 1,
        timedOut: false,
      },
      probe: null,
      manualCommand: "npm install -g opencode-ai@latest",
    });

    assert.strictEqual(outcome.status, "failed");
    assert.include(outcome.message, "exited with code 1");
    assert.include(outcome.message, "EACCES");
    assert.include(outcome.message, "not allowed to write");
  });

  it("reports a timeout as a timeout", () => {
    const outcome = resolveProviderUpdateOutcome({
      command: { stdout: "", stderr: "", exitCode: null, timedOut: true },
      probe: null,
      manualCommand: "npm install -g opencode-ai@latest",
    });

    assert.deepStrictEqual(outcome, { status: "failed", message: "Update timed out." });
  });
});
