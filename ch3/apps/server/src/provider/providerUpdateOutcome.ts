/**
 * Deciding whether a provider update actually landed.
 *
 * Every provider updater is a third-party CLI, and some of them report failure
 * and exit 0 anyway. `opencode upgrade` does exactly that when GitHub's
 * anonymous API quota is spent: it prints
 *
 *     Error: Unexpected error
 *     StatusCode: non 2xx status code (403 GET https://api.github.com/repos/...)
 *
 * and returns 0. A runner that trusts the exit code then tells the person the
 * update worked while the binary on disk never moved — which is how "OpenCode
 * keeps offering an update I can never install" happens, silently, on every
 * shared corporate IP that has spent its 60 anonymous requests for the hour.
 *
 * So this module encodes the rule {@link ClaudeCliInstaller} already states:
 * **truth comes from running the binary, never from an installer's return
 * value.** The runner re-probes the provider after the command and hands the
 * before/after versions here. The exit code only ever adds detail.
 *
 * It is deliberately mechanism-agnostic. npm, pnpm, bun, vite-plus, Homebrew
 * and the native updaters all fail in ways their exit codes do not describe —
 * npm will happily install into a global prefix the resolved binary does not
 * come from, `brew upgrade` exits 0 on a formula it left alone — and one
 * question catches all of them: did the version move? What *is* per-mechanism
 * is the advice, which quotes that mechanism's own command.
 *
 * @module providerUpdateOutcome
 */
import type {
  ServerProviderUpdateStatus,
  ServerProviderVersionAdvisoryStatus,
} from "@ch3tools/contracts";

/** What the update subprocess did, as observed by the runner. */
export interface ProviderUpdateCommandReport {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/**
 * What running the provider itself says, before and after the command.
 *
 * `versionBefore` comes from the snapshot the person was looking at when they
 * pressed the button; `versionAfter` from a forced re-probe that runs the
 * binary again. Both are the driver's own `--version` answer.
 */
export interface ProviderUpdateProbe {
  /** False when the refresh produced no snapshot for this instance at all. */
  readonly verified: boolean;
  readonly versionBefore: string | null;
  readonly versionAfter: string | null;
  readonly installedBefore: boolean;
  readonly installedAfter: boolean;
  /** The advisory derived from the re-probed snapshot, not the stale one. */
  readonly advisoryStatus: ServerProviderVersionAdvisoryStatus;
}

export interface ProviderUpdateOutcome {
  readonly status: Extract<ServerProviderUpdateStatus, "succeeded" | "failed" | "unchanged">;
  readonly message: string;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * Lines worth quoting back to a person.
 *
 * Wide on purpose: an updater's own wording is more useful than anything this
 * file could invent, and the full output is kept alongside it either way.
 */
const PROBLEM_LINE =
  /(error|fail(ed|ure|s)?|denied|forbidden|refused|unauthor|not found|status ?code|rate.?limit|\b[45]\d\d\b|EACCES|EPERM|ENOENT|ENOTFOUND|ETIMEDOUT|ECONNREFUSED)/i;

/** Enough lines to carry the cause, few enough to fit in a toast. */
const MAX_PROBLEM_LINES = 3;
const MAX_PROBLEM_LENGTH = 240;

/**
 * The updater's own words about what went wrong, or null when it said nothing
 * recognisable.
 *
 * opencode's 403 is the shape this exists for: the informative line ("403 GET
 * https://api.github.com/...") arrives *after* a useless one ("Error:
 * Unexpected error"), so taking only the first match would throw the answer
 * away. Several lines are kept, in order, and the full output stays in
 * `updateState.output`.
 */
export function extractReportedProblem(output: {
  readonly stdout: string;
  readonly stderr: string;
}): string | null {
  const problems: Array<string> = [];
  for (const rawLine of [...output.stderr.split("\n"), ...output.stdout.split("\n")]) {
    const line = rawLine.replaceAll(ANSI_ESCAPE, "").trim();
    if (line.length === 0 || !PROBLEM_LINE.test(line) || problems.includes(line)) {
      continue;
    }
    problems.push(line);
    if (problems.length === MAX_PROBLEM_LINES) {
      break;
    }
  }
  if (problems.length === 0) {
    return null;
  }
  const joined = problems.join(" ");
  return joined.length <= MAX_PROBLEM_LENGTH
    ? joined
    : `${joined.slice(0, MAX_PROBLEM_LENGTH - 1).trimEnd()}…`;
}

/**
 * What the person can do about it.
 *
 * A rate-limited third-party updater is foreseeable, so it gets a real answer
 * rather than "update failed": the quota is per network address and refills on
 * its own, and telling someone to run the same command by hand would only spend
 * the next request against the same empty bucket.
 */
function remedyFor(problem: string | null, manualCommand: string | null): string | null {
  if (problem !== null) {
    if (/\b(403|429)\b|rate.?limit/i.test(problem) && /github/i.test(problem)) {
      return "GitHub rate-limits anonymous API requests per network address, and this one has spent its hourly quota. Wait for the quota to refill and try again.";
    }
    if (/EACCES|EPERM|permission denied/i.test(problem)) {
      return "The update command was not allowed to write where this provider is installed.";
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(problem)) {
      return "This machine could not reach the update server. Check the network and try again.";
    }
  }
  return manualCommand === null ? null : `Update it by hand with \`${manualCommand}\`.`;
}

function sentence(value: string): string {
  return /[.!?…]$/.test(value) ? value : `${value}.`;
}

function joinSentences(...parts: ReadonlyArray<string | null>): string {
  return parts
    .filter((part): part is string => part !== null && part.length > 0)
    .map(sentence)
    .join(" ");
}

/**
 * Judge one update attempt.
 *
 * `probe` is null when the command failed outright and the runner did not
 * bother re-probing — the exit code is already the answer in that case.
 */
export function resolveProviderUpdateOutcome(input: {
  readonly command: ProviderUpdateCommandReport;
  readonly probe: ProviderUpdateProbe | null;
  /** The mechanism's own command, quoted back when there is something to do. */
  readonly manualCommand: string | null;
}): ProviderUpdateOutcome {
  const problem = extractReportedProblem(input.command);
  const remedy = remedyFor(problem, input.manualCommand);
  const reported = problem === null ? null : `It reported: ${problem}`;

  if (input.command.timedOut) {
    return { status: "failed", message: "Update timed out." };
  }
  if (input.command.exitCode !== null && input.command.exitCode !== 0) {
    return {
      status: "failed",
      message: joinSentences(
        `Update command exited with code ${input.command.exitCode}`,
        reported,
        remedy,
      ),
    };
  }

  const probe = input.probe;
  if (probe === null || !probe.verified) {
    return {
      status: "unchanged",
      message: "Update command completed, but CH3 could not verify the provider version.",
    };
  }

  const newlyInstalled = probe.installedAfter && !probe.installedBefore;
  const versionMoved = probe.versionAfter !== null && probe.versionAfter !== probe.versionBefore;
  if (versionMoved || newlyInstalled) {
    return {
      status: "succeeded",
      message:
        probe.versionBefore !== null && probe.versionAfter !== null
          ? `Updated from ${probe.versionBefore} to ${probe.versionAfter}.`
          : "Provider updated.",
    };
  }

  // Nothing moved. Whether that is fine depends on whether anything was owed,
  // and the re-probed advisory is the only thing that knows.
  if (probe.versionAfter === null) {
    return {
      status: "unchanged",
      message: "Update command completed, but CH3 could not verify the provider version.",
    };
  }
  if (probe.advisoryStatus === "current") {
    return { status: "unchanged", message: "This provider is already up to date." };
  }
  if (probe.advisoryStatus === "behind_latest" || problem !== null) {
    return {
      status: "failed",
      message: joinSentences(
        `The update command finished without an error, but this provider is still on ${probe.versionAfter}`,
        reported,
        remedy,
      ),
    };
  }
  return {
    status: "unchanged",
    message: `Update command completed, but this provider is still on ${probe.versionAfter}.`,
  };
}
