/**
 * Plan usage for a Claude account.
 *
 * Reads the same `/api/oauth/usage` endpoint the CLI's own `/usage` screen
 * uses, with the account's OAuth token. Local file read plus one HTTPS call:
 * no model request, so none of this consumes plan usage itself.
 *
 * @module ClaudeAccountUsage
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { ClaudeAccountUsage } from "@ch3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../../processRunner.ts";

/**
 * Claude Code keys each account's Keychain entry by its config directory:
 * `Claude Code-credentials-<first 8 hex of sha256(dir)>`. The unsuffixed
 * `Claude Code-credentials` is the legacy name for the default home, which is
 * why a hardcoded lookup kept returning the personal account no matter which
 * one was selected. Verified against this machine's Keychain: `~/.claude` →
 * `…-76e46a53`, `~/.claude-work` → `…-02d23a66`.
 *
 * The hashed entry is NOT guaranteed to hold the account credential: newer
 * CLI versions keep MCP tokens there but may store the account's own OAuth
 * under the legacy unsuffixed name even for a custom directory (observed
 * after a re-login). The caller handles that with an identity-gated fallback
 * through the default profile — see `probeClaudeProfile`.
 */
export const claudeCredentialServices = (configDir: string): ReadonlyArray<string> => {
  const hash = NodeCrypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  const hashed = `Claude Code-credentials-${hash}`;
  const isDefaultHome = configDir === `${NodeOS.homedir()}/.claude`;
  // The legacy name belongs to the default account, so it is only a fallback
  // there. Offering it for a custom directory would report the wrong account.
  return isDefaultHome ? [hashed, "Claude Code-credentials"] : [hashed];
};

/**
 * Which keychain *account* to ask for, in order.
 *
 * A service name is not unique. `claude mcp login` writes its own item under
 * the same `Claude Code-credentials-<hash>` service with the account
 * `unknown`, holding MCP tokens and no `claudeAiOauth` at all, and
 * `security find-generic-password -s <service> -w` answers with whichever item
 * it reaches first. On this machine that shadowed the real credential for two
 * profiles the moment an MCP server was signed in: both went on working, and
 * both went quiet about their usage, which reads as "signed out" on a row that
 * is signed in.
 *
 * The CLI files the account credential under the OS user, so that is asked for
 * first, and the unscoped lookup stays as the fallback for anything filed
 * differently.
 */
const credentialAccountsToTry = (): ReadonlyArray<string | undefined> => {
  const user = (() => {
    try {
      return NodeOS.userInfo().username.trim();
    } catch {
      return "";
    }
  })();
  return user.length > 0 ? [user, undefined] : [undefined];
};

const decodeCredentials = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ accessToken: Schema.optional(Schema.NullOr(Schema.String)) }),
        ),
      ),
    }),
  ),
);

const readAccessToken = (raw: string): string | undefined => {
  if (raw.trim().length === 0) return undefined;
  const parsed = decodeCredentials(raw.trim());
  if (parsed._tag !== "Success") return undefined;
  const token = parsed.value.claudeAiOauth?.accessToken?.trim();
  return token && token.length > 0 ? token : undefined;
};

/** The account's OAuth token: credentials file first, then the Keychain. */
export const readClaudeAccountToken = Effect.fn("readClaudeAccountToken")(function* (
  configDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const remembered = accountTokenCache.get(configDir);
  if (remembered !== undefined) return remembered;

  // The file first, always: when the CLI keeps the credential here there is no
  // keychain in the story at all, and this costs one read.
  const fromFile = yield* fs
    .readFileString(path.join(configDir, ".credentials.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  const fileToken = readAccessToken(fromFile);
  if (fileToken) {
    accountTokenCache.set(configDir, fileToken);
    return fileToken;
  }

  const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
  const absentUntil = absentTokenUntil.get(configDir);
  if (absentUntil !== undefined && nowMs < absentUntil) return undefined;

  for (const service of claudeCredentialServices(configDir)) {
    for (const account of credentialAccountsToTry()) {
      const output = yield* processRunner
        .run({
          command: "security",
          args: [
            "find-generic-password",
            "-s",
            service,
            ...(account === undefined ? [] : ["-a", account]),
            "-w",
          ],
          timeout: KEYCHAIN_TIMEOUT,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.orElseSucceed(() => ({ stdout: "" }) as { stdout: string }));
      const token = readAccessToken(output.stdout);
      if (token) {
        accountTokenCache.set(configDir, token);
        return token;
      }
    }
  }
  absentTokenUntil.set(configDir, nowMs + ABSENT_TOKEN_TTL_MS);
  return undefined;
});

/**
 * The endpoint reports `utilization` (0–100) per window. An earlier reading of
 * `used_percentage` — the field name the CLI puts on its statusline STDIN
 * payload — is absent here and yields null, which would look like 0% usage and
 * make an exhausted account appear empty.
 */
const decodeUsage = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    Schema.Struct({
      five_hour: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            utilization: Schema.optional(Schema.NullOr(Schema.Number)),
            resets_at: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      seven_day: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            utilization: Schema.optional(Schema.NullOr(Schema.Number)),
            resets_at: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      // Per-model caps, current shape: a `limits` array whose entries carry
      // the model identity under scope.model.display_name. Verified against
      // the live endpoint (the pre-CH3 statusline script matched
      // /fable/i on exactly this path).
      limits: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              percent: Schema.optional(Schema.NullOr(Schema.Number)),
              utilization: Schema.optional(Schema.NullOr(Schema.Number)),
              resets_at: Schema.optional(Schema.NullOr(Schema.String)),
              scope: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    model: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          display_name: Schema.optional(Schema.NullOr(Schema.String)),
                        }),
                      ),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      ),
      // Per-model weekly windows, older top-level shape. Which key appears
      // depends on the plan and API vintage (seven_day_opus was observed in
      // Aug 2026 fixtures). Absent keys mean the plan has no per-model cap.
      seven_day_fable: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            utilization: Schema.optional(Schema.NullOr(Schema.Number)),
            resets_at: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      seven_day_opus: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            utilization: Schema.optional(Schema.NullOr(Schema.Number)),
            resets_at: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
);

export interface ClaudeAccountUsageFetch {
  readonly usage?: ClaudeAccountUsage;
  /** The endpoint rejected the stored token outright (401/403). */
  readonly unauthorized?: boolean;
  /** No stored credential was found to ask with at all. */
  readonly credentialMissing?: boolean;
  /**
   * The endpoint refused the read with 429. Distinct from silence because it
   * is SELF-INFLICTED and recoverable: the caller must stop asking (see
   * `retryAfterMs`) and fall back to the last reading rather than concluding
   * the account's usage is unknowable.
   */
  readonly rateLimited?: boolean;
  /** How long the endpoint asked to be left alone, from its `retry-after`. */
  readonly retryAfterMs?: number;
  /** The instant reads resume, epoch ms. Present whenever `rateLimited` is. */
  readonly retryAtMs?: number;
  /** The usage came from the cache because the live read did not land. */
  readonly stale?: boolean;
  /**
   * The endpoint answered 200 and the body no longer parses.
   *
   * Distinct from silence because it is not a hiccup and it will not clear on
   * its own: it means Anthropic moved the response shape and CH3 is reading
   * a field that is gone. Collapsed into "no usage", a shape change looks
   * exactly like flaky wifi and nobody goes and looks.
   */
  readonly unrecognized?: boolean;
  /**
   * A forced read was refused because one was already made for this account
   * inside the throttle window; this is the instant the next one is allowed.
   * The reading returned is whatever the cache holds.
   */
  readonly forceRetryAtMs?: number;
}

/**
 * `curl` prints the response body, then the status code alone on its own line,
 * then the response headers as JSON (the `-w` format below). The status line
 * is found by scanning BACK for the bare three-digit line rather than reading
 * the last line, because the header block that follows it is multi-line.
 *
 * A 401/403 is reported as `unauthorized`, a 429 as `rateLimited` carrying its
 * `retry-after`. Those two must not collapse into each other or into silence:
 * "this account cannot sign its requests", "stop asking for 41 minutes", and
 * "the network hiccuped" demand three different responses from the automatic
 * hand-over, and treating all of them as "usage unknown" is what left an
 * exhausted account seated with a healthy sibling beside it.
 */
export const parseClaudeUsageResponse = (raw: string): ClaudeAccountUsageFetch => {
  const trimmed = raw.trimEnd();
  const lines = trimmed.split("\n");
  let statusIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\d{3}$/.test((lines[index] ?? "").trim())) {
      statusIndex = index;
      break;
    }
  }
  if (statusIndex < 0) return {};
  const status = Number.parseInt((lines[statusIndex] ?? "").trim(), 10);
  const body = lines.slice(0, statusIndex).join("\n");
  if (status === 401 || status === 403) return { unauthorized: true };
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(lines.slice(statusIndex + 1).join("\n"));
    return { rateLimited: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if (status !== 200) return {};
  const usage = parseClaudeAccountUsage(body);
  // A 200 whose body will not parse is a SHAPE change, not a hiccup, and it
  // gets its own flag so the panel can say so instead of showing the blank a
  // dropped connection shows.
  return usage ? { usage } : { unrecognized: true };
};

/**
 * The `retry-after` from curl's `%{header_json}`, in milliseconds.
 *
 * Honouring the number the server actually sent matters here: the observed
 * penalty was 2484 seconds. Guessing a shorter backoff means re-asking eight
 * times inside one penalty, which is how the limit was earned in the first
 * place.
 */
const parseRetryAfterMs = (headerJson: string): number | undefined => {
  if (headerJson.trim().length === 0) return undefined;
  let headers: unknown;
  try {
    headers = JSON.parse(headerJson);
  } catch {
    return undefined;
  }
  if (typeof headers !== "object" || headers === null) return undefined;
  const value = (headers as Record<string, unknown>)["retry-after"];
  const first = Array.isArray(value) ? value[0] : value;
  const seconds = Number.parseInt(String(first ?? "").trim(), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

/** Total: any failure yields undefined rather than a misleading zero. */
export const parseClaudeAccountUsage = (raw: string): ClaudeAccountUsage | undefined => {
  const parsed = decodeUsage(raw);
  if (parsed._tag !== "Success") return undefined;
  const session = parsed.value.five_hour?.utilization;
  const week = parsed.value.seven_day?.utilization;
  // A window the endpoint did not report is unknown, not empty — reporting it
  // as 0 would make an exhausted account look like a safe failover target.
  if (typeof session !== "number" || typeof week !== "number") return undefined;
  const sessionResetsAt = parsed.value.five_hour?.resets_at ?? undefined;
  const weekResetsAt = parsed.value.seven_day?.resets_at ?? undefined;
  // The per-model weekly cap (Fable), under whichever shape the endpoint
  // reports it: the current `limits[]` array first, the older top-level
  // seven_day_* keys as fallback. Optional by nature — unlike session/week,
  // absence just means the plan has no per-model cap, so it never
  // invalidates the whole parse.
  // The endpoint can report MORE THAN ONE window for a model — a 5-hour cap
  // and a weekly one. Taking the first match let the band show a roomy window
  // while the one about to refuse the next turn was full: the meter read 56%
  // and the run died against a Fable limit in the same breath. The most
  // constraining window is the honest one to show.
  const fableLimits = (parsed.value.limits ?? []).filter((limit) =>
    /fable/i.test(limit?.scope?.model?.display_name ?? ""),
  );
  const fableLimit = fableLimits.reduce<(typeof fableLimits)[number] | undefined>(
    (worst, limit) => {
      const percent = limit?.percent ?? limit?.utilization;
      if (typeof percent !== "number") return worst;
      const worstPercent = worst?.percent ?? worst?.utilization;
      return typeof worstPercent === "number" && worstPercent >= percent ? worst : limit;
    },
    undefined,
  );
  const modelWindow = parsed.value.seven_day_fable ?? parsed.value.seven_day_opus;
  const modelWeek = fableLimit?.percent ?? fableLimit?.utilization ?? modelWindow?.utilization;
  const modelWeekResetsAt = fableLimit?.resets_at ?? modelWindow?.resets_at ?? undefined;
  return {
    sessionPercent: session,
    weekPercent: week,
    ...(sessionResetsAt ? { sessionResetsAt } : {}),
    ...(weekResetsAt ? { weekResetsAt } : {}),
    ...(typeof modelWeek === "number" ? { modelWeekPercent: modelWeek } : {}),
    ...(typeof modelWeek === "number" && modelWeekResetsAt ? { modelWeekResetsAt } : {}),
  };
};

/**
 * The CLI's own `rate_limit_event`, the second transport for the same numbers.
 *
 * Anthropic computes `utilization` server-side and sends it down this stream
 * during a normal turn, so it is the same quantity `/api/oauth/usage` returns
 * — not a local estimate — and it arrives free, on the account that is busy.
 * That is exactly the account whose poll is being refused: the 429 bucket is
 * per account, and the account running the agents is the one too hot to be
 * asked about.
 *
 * SCALE, established from 1787 real events on this machine rather than from
 * the SDK's undocumented type: this stream reports a FRACTION, 0–1, where the
 * HTTP endpoint reports 0–100. The maximum `utilization` across every event
 * ever logged here is 1.01, and the decisive pairing is `claudio.aurelio`,
 * whose `unifiedWindows` reset instants identify it uniquely: its last event
 * before the cached poll read `five_hour: 0.99, seven_day: 0.61`, and the poll
 * moments later recorded `sessionPercent: 100, weekPercent: 61`. Hence ×100.
 *
 * `rate_limit_info` is `{}` on 49 of those events. Zeroes are not a reading —
 * an empty payload is dropped.
 */
const ClaudeRateLimitWindow = Schema.Struct({
  utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Epoch SECONDS on this stream, unlike the endpoint's ISO string. */
  resetsAt: Schema.optional(Schema.NullOr(Schema.Number)),
});

const decodeRateLimitEvent = Schema.decodeUnknownExit(
  Schema.Struct({
    rate_limit_info: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          unifiedWindows: Schema.optional(
            Schema.NullOr(Schema.Record(Schema.String, ClaudeRateLimitWindow)),
          ),
        }),
      ),
    ),
  }),
);

const FRACTION_TO_PERCENT = 100;

const windowReading = (
  window: typeof ClaudeRateLimitWindow.Type | undefined,
): { readonly percent: number; readonly resetsAt?: string } | undefined => {
  const utilization = window?.utilization;
  if (typeof utilization !== "number") return undefined;
  const resetsAtSeconds = window?.resetsAt;
  return {
    percent: utilization * FRACTION_TO_PERCENT,
    ...(typeof resetsAtSeconds === "number" && resetsAtSeconds > 0
      ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAtSeconds * 1000)) }
      : {}),
  };
};

/**
 * The windows a `rate_limit_event` carries, or undefined when it carries none.
 *
 * `seven_day_overage_included` is deliberately ignored: overage is a separate
 * allowance with no field on the record, and folding it into the weekly figure
 * would overstate what the plan window has left.
 */
export const parseClaudeRateLimitEvent = (
  message: unknown,
  atMs: number,
): UsageReading | undefined => {
  const parsed = decodeRateLimitEvent(message);
  if (parsed._tag !== "Success") return undefined;
  const windows = parsed.value.rate_limit_info?.unifiedWindows;
  if (!windows) return undefined;
  const session = windowReading(windows["five_hour"]);
  const week = windowReading(windows["seven_day"]);
  // Both or neither: a record needs a session AND a week figure, and inventing
  // the missing one as zero is how an exhausted account reads as empty.
  if (session === undefined || week === undefined) return undefined;
  // Named in the SDK's own rate-limit-type union. Never yet observed on this
  // stream, so the poll stays the only source of the Fable figure in practice.
  const modelWeek =
    windowReading(windows["seven_day_opus"]) ?? windowReading(windows["seven_day_sonnet"]);
  return { atMs, session, week, ...(modelWeek === undefined ? {} : { modelWeek }) };
};

/**
 * Fold a `rate_limit_event` into the account's cached reading.
 *
 * Keyed by the SAME account identity the poll writes under, because the two
 * transports describe one quota. Writing a busy account's numbers into
 * another account's slot would make the panel lie about which account has
 * capacity left, which is worse than the stale label this replaces — so the
 * caller resolves the identity and refuses to call rather than guessing, and
 * an empty key is rejected here as a second line of defence.
 */
export const recordClaudeRateLimitEvent = Effect.fn("recordClaudeRateLimitEvent")(
  function* (input: { readonly accountKey: string; readonly message: unknown }) {
    if (input.accountKey.trim().length === 0) return false;
    const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const reading = parseClaudeRateLimitEvent(input.message, nowMs);
    if (reading === undefined) return false;
    yield* endpointGate.withPermits(1)(loadPersistedUsageCache());
    usageCache.set(input.accountKey, mergeReading(usageCache.get(input.accountKey), reading));
    yield* persistUsageCache();
    return true;
  },
);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT = Duration.millis(USAGE_TIMEOUT_MS);
/** The Keychain lookup is local; anything slower than this is a stuck prompt. */
const KEYCHAIN_TIMEOUT = Duration.seconds(3);

/**
 * How long a reading answers for its account without asking again.
 *
 * Three independent callers want this number — the failover loop every 60s,
 * the rotation loop every 120s, and the settings panel on every render — and
 * each used to spend its own HTTPS call per account. Measured on this machine:
 * twelve calls in fifty-five seconds while the panel was open, which earned a
 * 429 carrying `retry-after: 2484`. Usage moves on the order of minutes, so
 * one minute of sharing costs no accuracy and removes the storm.
 */
export const USAGE_FRESH_MS = 60_000;

/**
 * How old a reading may be and still DECIDE anything.
 *
 * The bug this exists for: a 429 turned every account's usage into "unknown",
 * every decision path treats unknown as "stay put", and so an account at 100%
 * of its 5-hour window kept the seat while a sibling sat at 12%. A reading
 * minutes old is imperfect evidence; no evidence at all is a guaranteed stall.
 * Past this horizon a hand-over must not act on the number, because acting on
 * a quarter-hour-old reading is the mistake in the other direction — see
 * `isDecisionGradeUsage`, which is where that rule now lives.
 *
 * DISPLAYING an older reading is a different question with a different answer:
 * every reading carries `readAt`, so a panel can show the last known numbers
 * and say how old they are. A dated number is honest; a blank is not.
 */
export const USAGE_STALE_MS = 15 * 60_000;

/** How old a returned reading is, or undefined when it carries no `readAt`. */
export const usageReadAgeMs = (
  usage: Pick<ClaudeAccountUsage, "readAt"> | undefined,
  nowMs: number,
): number | undefined => {
  if (!usage?.readAt) return undefined;
  const readAtMs = Date.parse(usage.readAt);
  return Number.isNaN(readAtMs) ? undefined : Math.max(0, nowMs - readAtMs);
};

/**
 * Whether a reading is recent enough to move an account off its seat.
 *
 * A reading with no `readAt` predates the stamp and is treated as current, the
 * behaviour every caller had before the stamp existed.
 */
export const isDecisionGradeUsage = (
  usage: Pick<ClaudeAccountUsage, "readAt"> | undefined,
  nowMs: number,
): boolean => {
  if (!usage) return false;
  const age = usageReadAgeMs(usage, nowMs);
  return age === undefined || age < USAGE_STALE_MS;
};

/** Backoff when a 429 arrives without a `retry-after` to obey. */
export const USAGE_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

/**
 * The beat between two endpoint reads, whoever they are for.
 *
 * The 429 that first blinded this panel was earned by a burst: opening it
 * probed every profile at once, six reads left inside a few milliseconds and
 * five came back refused. Reads now leave one gate one after the other.
 *
 * What the pause is NOT is machine-wide. Proven on 2026-09-02 with one paced
 * read per account from the same shell: `claudio.uno` answered 429 with
 * `retry-after: 246` while `claudio.dos`, `fabio.uno` and `claudio.aurelio`
 * answered 200 inside the same ten seconds. The bucket is per ACCOUNT — and
 * the shared accounts are read by every machine signed in as them, so one of
 * them can be hot all day through no fault of this one. A single pause for
 * everyone therefore turned one hot account into six blank rows: the first
 * 429 in roster order stopped every read behind it, the panel showed
 * "not read yet" on rows the endpoint would have answered, and the next open
 * did it again. The pause is per account key (`usagePausedUntilByKey`).
 */
export const USAGE_READ_SPACING_MS = 1_500;

/**
 * A reading, with an instant PER WINDOW rather than one for the record.
 *
 * Two transports fill this and they carry different subsets. A poll refreshes
 * all three windows at once; the CLI's `rate_limit_event` refreshes the
 * session and week windows only — it has never once carried a per-model
 * window (1787 events on this machine: `unifiedWindows` holds `five_hour`,
 * `seven_day` and `seven_day_overage_included`, nothing else). One `atMs` for
 * the record would therefore either backdate the two windows an event just
 * refreshed, or pass off a nine-hour-old Fable figure as current.
 */
interface CachedUsage {
  readonly usage: ClaudeAccountUsage;
  readonly sessionAtMs: number;
  readonly weekAtMs: number;
  /** Absent exactly when `usage.modelWeekPercent` is. */
  readonly modelWeekAtMs: number | undefined;
}

/**
 * A newly-read subset of the windows, and when it was read.
 *
 * `modelWeek` absent means "this transport does not carry it", never "the
 * plan has no per-model cap" — so a merge leaves the existing figure and its
 * own age alone rather than deleting a number the panel is showing.
 */
interface UsageReading {
  readonly atMs: number;
  readonly session: { readonly percent: number; readonly resetsAt?: string };
  readonly week: { readonly percent: number; readonly resetsAt?: string };
  readonly modelWeek?: { readonly percent: number; readonly resetsAt?: string };
}

/**
 * Newest wins, per window.
 *
 * Out-of-order arrivals are real: the event stream and the poll are separate
 * fibers, and a poll that queued behind five others lands seconds after it
 * asked. A window is only overwritten by a reading taken later than the one
 * already there.
 */
const mergeReading = (existing: CachedUsage | undefined, reading: UsageReading): CachedUsage => {
  const takeSession = existing === undefined || reading.atMs >= existing.sessionAtMs;
  const takeWeek = existing === undefined || reading.atMs >= existing.weekAtMs;
  const takeModelWeek =
    reading.modelWeek !== undefined &&
    (existing?.modelWeekAtMs === undefined || reading.atMs >= existing.modelWeekAtMs);
  const session = takeSession ? reading.session : undefined;
  const week = takeWeek ? reading.week : undefined;
  const modelWeekPercent = takeModelWeek
    ? reading.modelWeek!.percent
    : existing?.usage.modelWeekPercent;
  const modelWeekResetsAt = takeModelWeek
    ? reading.modelWeek!.resetsAt
    : existing?.usage.modelWeekResetsAt;
  const sessionResetsAt = session ? session.resetsAt : existing?.usage.sessionResetsAt;
  const weekResetsAt = week ? week.resetsAt : existing?.usage.weekResetsAt;
  return {
    usage: {
      sessionPercent: session ? session.percent : existing!.usage.sessionPercent,
      weekPercent: week ? week.percent : existing!.usage.weekPercent,
      ...(sessionResetsAt ? { sessionResetsAt } : {}),
      ...(weekResetsAt ? { weekResetsAt } : {}),
      ...(typeof modelWeekPercent === "number" ? { modelWeekPercent } : {}),
      ...(typeof modelWeekPercent === "number" && modelWeekResetsAt ? { modelWeekResetsAt } : {}),
    },
    sessionAtMs: takeSession ? reading.atMs : existing!.sessionAtMs,
    weekAtMs: takeWeek ? reading.atMs : existing!.weekAtMs,
    modelWeekAtMs: takeModelWeek ? reading.atMs : existing?.modelWeekAtMs,
  };
};

/** A whole-record reading, as a poll of the endpoint produces one. */
const readingFromUsage = (usage: ClaudeAccountUsage, atMs: number): UsageReading => ({
  atMs,
  session: {
    percent: usage.sessionPercent,
    ...(usage.sessionResetsAt ? { resetsAt: usage.sessionResetsAt } : {}),
  },
  week: {
    percent: usage.weekPercent,
    ...(usage.weekResetsAt ? { resetsAt: usage.weekResetsAt } : {}),
  },
  ...(typeof usage.modelWeekPercent === "number"
    ? {
        modelWeek: {
          percent: usage.modelWeekPercent,
          ...(usage.modelWeekResetsAt ? { resetsAt: usage.modelWeekResetsAt } : {}),
        },
      }
    : {}),
});

/**
 * Last good reading per ACCOUNT. Keyed by identity rather than by config
 * directory so two directories signed into the same account and organization
 * — which share one quota, and therefore one rate-limit bucket — cost one call
 * between them instead of two.
 */
const usageCache = new Map<string, CachedUsage>();

/**
 * The instant the endpoint may be asked again, for EVERY account.
 *
 * One pause rather than one per account, because the penalty is not per
 * account: the burst above earned it for five accounts at once, and a per-key
 * back-off let the sixth read go straight out into the same penalty and earn
 * it again. Whatever bucket the endpoint keys on, the honest response to a
 * `retry-after` is to stop asking, full stop.
 */
/**
 * When each account's reads resume, by account key, from the endpoint's own
 * `retry-after`. Per account because the endpoint's bucket is per account —
 * see `USAGE_READ_SPACING_MS`. An absent key is an account that may be read.
 */
const usagePausedUntilByKey = new Map<string, number>();

/**
 * At most one FORCED read per account per minute.
 *
 * The button exists because there was no way to make a nine-hour-old number
 * try again. It must not become a way to earn a deeper penalty: one press
 * inside a pause is a fair ask, twenty is the burst that created the pause.
 */
export const USAGE_FORCE_THROTTLE_MS = 60_000;
const forcedReadAtMs = new Map<string, number>();

const pausedUntilFor = (key: string): number => usagePausedUntilByKey.get(key) ?? 0;

/** The one gate every endpoint read passes through, so they can be spaced. */
const endpointGate = Semaphore.makeUnsafe(1);
/** When the last read went out, for spacing the next; null before the first. */
let lastEndpointReadAtMs: number | null = null;

/**
 * The account token, remembered for as long as it works.
 *
 * Reading it costs a `/usr/bin/security` spawn against the login keychain, and
 * macOS gates that per calling application — so on a machine whose Claude
 * credential lives only in the keychain, and whose CH3 is a local build
 * (every one ad-hoc signed with a different signature, so no grant survives a
 * rebuild), a poll every sixty seconds is a keychain password prompt every
 * sixty seconds. Cancelling buys a minute. The checkbox that turns this on says
 * macOS "may ask for permission the first time", and that sentence was only
 * true because nothing here remembered the answer.
 *
 * There is no expiry, on purpose. A token that has been rotated does not go
 * quietly stale — it comes back 401, which is a fact we are already told and
 * which {@link forgetClaudeAccountToken} acts on. A timer would re-prompt on a
 * schedule for no information.
 */
const accountTokenCache = new Map<string, string>();

/**
 * How long a "there is no credential here" answer is trusted.
 *
 * Unlike a token, absence has no event that announces it changed — somebody
 * signs in and there simply is one. Short enough that a sign-in is noticed
 * within a poll or two, long enough that a machine with no Claude account at
 * all is not spawning `security` every minute to be told nothing again.
 */
const ABSENT_TOKEN_TTL_MS = 5 * 60_000;
const absentTokenUntil = new Map<string, number>();

/**
 * Forget one directory's token, so the next read asks the keychain again.
 *
 * Called when the endpoint rejects it: a 401 is exactly the event that makes a
 * remembered token wrong, and the only one worth paying a prompt to correct.
 */
export const forgetClaudeAccountToken = (configDir: string): void => {
  accountTokenCache.delete(configDir);
  absentTokenUntil.delete(configDir);
};

/**
 * Drops every cached reading and the pause. Used by tests, and by a sign-in
 * that changes who an account is. The file on disk, if one is configured, is
 * read again on the next fetch — which is what makes this a stand-in for a
 * restart in tests.
 */
export const clearClaudeUsageCache = (): void => {
  usageCache.clear();
  usagePausedUntilByKey.clear();
  forcedReadAtMs.clear();
  lastEndpointReadAtMs = null;
  accountTokenCache.clear();
  absentTokenUntil.clear();
  persistedLoaded = false;
};

/**
 * Drops one account's cached reading. Scoped on purpose: a sign-out changes
 * what that one account is, and nothing about whether the endpoint is
 * accepting reads, so the pause stays.
 */
export const clearClaudeUsageCacheForAccount = (accountKey: string): void => {
  usageCache.delete(accountKey);
};

/**
 * Where the readings and the pause live between server runs, or null for
 * none. Configured once at boot from the server's state directory.
 *
 * Without this every restart — and CH3 restarts its server on every update
 * — forgot both: the panel came up blank, read every account at once, and
 * earned the penalty it had just served. With it, the same numbers are on
 * screen a second after the restart, dated, and a pause the endpoint asked
 * for is still honoured.
 */
let persistPath: string | null = null;
let persistedLoaded = false;

export const configureClaudeUsageCachePath = (path: string | null): void => {
  persistPath = path;
  persistedLoaded = false;
};

/**
 * The file on disk, both vintages.
 *
 * v1 carried one `atMs` per record, from when a poll was the only transport.
 * Every engineer has one, holding real readings, and discarding it would put
 * the panel back to blank-and-storm on the first launch after an update — the
 * exact failure the file exists to prevent. So v1 is migrated rather than
 * dropped: its single instant becomes the instant of all three of its
 * windows, which is precisely what it meant.
 */
const PersistedReadingV2 = Schema.Struct({
  sessionAtMs: Schema.Number,
  weekAtMs: Schema.Number,
  modelWeekAtMs: Schema.optionalKey(Schema.Number),
  usage: ClaudeAccountUsage,
});

const PersistedUsageCache = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      version: Schema.Literal(2),
      pausedUntilByKey: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
      readings: Schema.Record(Schema.String, PersistedReadingV2),
    }),
    Schema.Struct({
      version: Schema.Literal(1),
      // The one pause for every account that earlier builds wrote. Read for
      // shape only and never obeyed: it was one hot account's penalty applied to
      // all of them, which is the bug the per-account map replaces.
      pausedUntilMs: Schema.optionalKey(Schema.Number),
      pausedUntilByKey: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
      readings: Schema.Record(
        Schema.String,
        Schema.Struct({ atMs: Schema.Number, usage: ClaudeAccountUsage }),
      ),
    }),
  ]),
);
const decodePersistedUsageCache = Schema.decodeUnknownExit(PersistedUsageCache);
const encodePersistedUsageCache = Schema.encodeUnknownExit(PersistedUsageCache);

/** Reads the file once per process; a reading already in memory wins over the file's. */
const loadPersistedUsageCache = Effect.fn("loadPersistedUsageCache")(function* () {
  if (persistedLoaded || persistPath === null) return;
  persistedLoaded = true;
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(persistPath).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return;
  const parsed = decodePersistedUsageCache(raw);
  if (parsed._tag !== "Success") {
    // Loud, because the next write replaces this file from an empty map: every
    // other account's reading goes, and so does `pausedUntilByKey` — which is
    // the backoff itself, so the machine would resume polling accounts the
    // endpoint had told it to leave alone. Silence here reads as a fresh
    // install and is how a rate-limit storm starts.
    yield* Effect.logError("claude.usage-cache.unreadable", {
      path: persistPath,
      bytes: raw.length,
    });
    return;
  }
  for (const [key, entry] of Object.entries(parsed.value.readings)) {
    if (usageCache.has(key)) continue;
    const { readAt: _stamp, modelWeekReadAt: _modelStamp, ...usage } = entry.usage;
    // A v1 record's one instant is the instant of every window it holds.
    const migrated =
      "atMs" in entry
        ? {
            sessionAtMs: entry.atMs,
            weekAtMs: entry.atMs,
            modelWeekAtMs:
              typeof usage.modelWeekPercent === "number" ? entry.atMs : (undefined as undefined),
          }
        : {
            sessionAtMs: entry.sessionAtMs,
            weekAtMs: entry.weekAtMs,
            modelWeekAtMs: entry.modelWeekAtMs,
          };
    usageCache.set(key, { usage, ...migrated });
  }
  for (const [key, untilMs] of Object.entries(parsed.value.pausedUntilByKey ?? {})) {
    usagePausedUntilByKey.set(key, Math.max(pausedUntilFor(key), untilMs));
  }
});

/**
 * Serialises the writers. Two of them now reach this file: the poll, spaced by
 * `endpointGate`, and a busy session's `rate_limit_event`, which arrives about
 * once a minute on its own fiber and is spaced by nothing. Overlapping them on
 * a truncate-and-write is what tears the JSON.
 */
const persistGate = Semaphore.makeUnsafe(1);

/** Best-effort write-through; a failed write costs nothing but the next restart's memory. */
const persistUsageCache = Effect.fn("persistUsageCache")(function* () {
  if (persistPath === null) return;
  const fs = yield* FileSystem.FileSystem;
  const encoded = encodePersistedUsageCache({
    version: 2,
    pausedUntilByKey: Object.fromEntries(usagePausedUntilByKey),
    readings: Object.fromEntries(
      [...usageCache].map(([key, entry]) => [
        key,
        {
          sessionAtMs: entry.sessionAtMs,
          weekAtMs: entry.weekAtMs,
          ...(entry.modelWeekAtMs === undefined ? {} : { modelWeekAtMs: entry.modelWeekAtMs }),
          usage: entry.usage,
        },
      ]),
    ),
  });
  if (encoded._tag !== "Success") return;
  // Atomic replace, for the same reason `.claude.json` gets one: a reader must
  // see the old file or the new one, never a half-written one. A torn file
  // does not just lose readings — it fails to decode on the next boot, and the
  // loader treats that as no file at all.
  const temporaryPath = `${persistPath}.tmp`;
  yield* persistGate
    .withPermits(1)(
      fs
        .writeFileString(temporaryPath, `${encoded.value}\n`)
        .pipe(Effect.andThen(fs.rename(temporaryPath, persistPath))),
    )
    .pipe(
      Effect.catch(() => fs.remove(temporaryPath).pipe(Effect.ignore)),
      Effect.ignore,
    );
});

/** What the pause looks like to a caller: the last numbers, and when reads resume. */
const paused = (fallback: ClaudeAccountUsageFetch, key: string): ClaudeAccountUsageFetch => ({
  ...fallback,
  rateLimited: true,
  retryAtMs: pausedUntilFor(key),
});

/**
 * Fresh enough that reading the endpoint would learn nothing.
 *
 * The session and week windows must both be inside `windowMs` — the stream
 * refreshes them, so on a busy account this is what suppresses the poll that
 * keeps earning the 429.
 *
 * The per-model window is held to `USAGE_STALE_MS` instead, and it has to be
 * checked separately or it is never refreshed at all: no `rate_limit_event`
 * has ever carried a per-model figure, so an account with a turn running
 * emits an event a minute, holds the pair permanently fresh, and freezes the
 * per-model number at whatever the last poll saw. That number is the one that
 * actually stops a Fable turn, so letting the poll through on its own clock —
 * four requests an hour, not sixty — is the point of the suppression, not a
 * hole in it. A reading that has never carried the window at all is not
 * waiting on it.
 */
const cachedWithin = (key: string, nowMs: number, windowMs: number): CachedUsage | undefined => {
  const cached = usageCache.get(key);
  if (!cached) return undefined;
  if (nowMs - cached.sessionAtMs >= windowMs || nowMs - cached.weekAtMs >= windowMs) {
    return undefined;
  }
  const modelWeekAtMs = cached.modelWeekAtMs;
  if (modelWeekAtMs !== undefined && nowMs - modelWeekAtMs >= USAGE_STALE_MS) return undefined;
  return cached;
};

/**
 * The reading as the caller sees it, stamped with when it was taken.
 *
 * `readAt` is the OLDER of the session and week instants — the two windows
 * every reading carries and the only two anything decides on
 * (`claudeAccountFailover` reads `sessionPercent` and `weekPercent`, never the
 * per-model one). Taking the older of the pair is what stops the stamp
 * claiming freshness a window does not have.
 *
 * The per-model window gets its OWN stamp instead of being folded into that
 * minimum, and this is deliberate: no `rate_limit_event` has ever carried a
 * per-model figure, so folding it in would hold `readAt` at the age of the
 * last successful poll forever — which reads as "8h ago" on numbers taken
 * forty seconds ago, and, worse, puts every event-sourced reading past
 * `USAGE_STALE_MS` so the hand-over refuses to act on it. That is the stall
 * this whole path exists to end.
 */
const stamped = (cached: CachedUsage): ClaudeAccountUsage => {
  const readAtMs = Math.min(cached.sessionAtMs, cached.weekAtMs);
  return {
    ...cached.usage,
    readAt: DateTime.formatIso(DateTime.makeUnsafe(readAtMs)),
    ...(cached.modelWeekAtMs === undefined || cached.modelWeekAtMs === readAtMs
      ? {}
      : { modelWeekReadAt: DateTime.formatIso(DateTime.makeUnsafe(cached.modelWeekAtMs)) }),
  };
};

/**
 * Usage for one account, with sign-in failures, rate limiting and silence all
 * told apart, and the last good reading standing in for a read that did not
 * land.
 *
 * `curl` rather than the HTTP client because this must never be able to hang a
 * background loop; the timeout is enforced by the process itself.
 */
export const fetchClaudeAccountUsage = Effect.fn("fetchClaudeAccountUsage")(function* (input: {
  readonly configDir: string;
  readonly cliVersion: string;
  /**
   * Identity of the account behind the directory (`email|organization`), so
   * the cache and the backoff follow the QUOTA rather than the directory.
   * Falls back to the directory when the profile's identity is unknown.
   */
  readonly accountKey?: string;
  /**
   * Read now: ignore the freshness window and the account's own pause.
   *
   * USER-INITIATED ONLY. Automatic retries inside a penalty are what earned
   * the nine-hour blackout this exists to break, so nothing on a timer may
   * pass this. Throttled to one forced read per account per
   * {@link USAGE_FORCE_THROTTLE_MS}; a refused force degrades to an ordinary
   * read and reports `forceRetryAtMs` rather than failing.
   */
  readonly force?: boolean;
  /**
   * Return only what is already cached — the fresh reading if within the
   * window, else the last one at any age marked stale, else nothing — and
   * never touch the network or the keychain. This is the panel's first paint:
   * numbers appear from the persisted cache the instant the page opens, and a
   * second call without this flag refreshes them in the background. Without
   * it, a stale cache made every row's usage blank for the ten-to-fifteen
   * seconds the serialized live reads took to drain.
   */
  readonly cachedOnly?: boolean;
}): Effect.fn.Return<
  ClaudeAccountUsageFetch,
  never,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const key = (input.accountKey ?? "").trim().length > 0 ? input.accountKey! : input.configDir;
  // Under the gate, so six probes arriving together all wait for the one
  // file read instead of five of them racing past an unset pause.
  yield* endpointGate.withPermits(1)(loadPersistedUsageCache());
  const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  // A forced read that is inside its own throttle window is not a read; it
  // falls through as an ordinary one and says when the next force is allowed,
  // so mashing the button cannot deepen the very penalty it is fighting.
  const lastForcedAtMs = forcedReadAtMs.get(key);
  // An account never forced before is forceable immediately — the throttle
  // spaces repeats, it is not a cooldown you serve before the first press.
  const forceAllowedAtMs =
    lastForcedAtMs === undefined ? 0 : lastForcedAtMs + USAGE_FORCE_THROTTLE_MS;
  const forcing = input.force === true && nowMs >= forceAllowedAtMs;
  const forceThrottled =
    input.force === true && !forcing ? { forceRetryAtMs: forceAllowedAtMs } : {};
  if (forcing) {
    // The pause is the thing standing between the person and a number. They
    // asked; clearing it here is the whole point of the button.
    //
    // The throttle is NOT stamped here. Every path below can still return
    // without a request leaving the machine — a missing credential most of
    // all, which is the ordinary state of a profile that borrows the default
    // directory's token and reads under its key. Spending the force on one of
    // those makes "Read now" report success, change nothing, and then refuse
    // for a minute. It is stamped where the request actually goes out.
    usagePausedUntilByKey.delete(key);
  }

  const fresh = forcing ? undefined : cachedWithin(key, nowMs, USAGE_FRESH_MS);
  // The poll an event has already covered. `atMs` moves when a `rate_limit_event`
  // lands, so an account whose turns are streaming readings stops being asked
  // at all — self-correcting, because an account with no events has nothing
  // to move it and is read exactly as before.
  if (fresh) return { ...forceThrottled, usage: stamped(fresh) };

  // The reading that stands in for a failed call: whatever was last read for
  // this account, at whatever age, stamped with when it was taken. No age cap
  // here — a dated number is something a panel can show and a decision can
  // reject (`isDecisionGradeUsage`), while a blank is a number nobody can
  // reason about at all. Never returned for a REJECTED token: an unauthorized
  // account is dead, and covering that with a stale number is how a dead
  // profile keeps the seat.
  const lastRead = usageCache.get(key);
  const fallback: ClaudeAccountUsageFetch = lastRead
    ? { usage: stamped(lastRead), stale: true }
    : {};

  // Cached-only: hand back whatever is on hand and stop before any request.
  // A forced read is a live read by definition, so the flag is ignored there.
  if (input.cachedOnly === true && !forcing) {
    return { ...forceThrottled, ...fallback };
  }

  if (!forcing && nowMs < pausedUntilFor(key))
    return paused({ ...fallback, ...forceThrottled }, key);

  // A forced read also forgets what this directory's credential looked like
  // last time. "No credential here" is remembered for five minutes so an
  // account-less machine does not spawn `security` every poll; a person who
  // just signed in and pressed "Read now" is the one case where that memory
  // is exactly wrong, and they should not have to wait it out.
  if (forcing) forgetClaudeAccountToken(input.configDir);
  let token = yield* readClaudeAccountToken(input.configDir);
  if (!token) return { ...forceThrottled, credentialMissing: true };

  // Through the gate: one read at a time, spaced. Re-checked inside it,
  // because while this caller waited another may have read this very account
  // — the panel asks for six at once — or earned it a pause.
  const readThrough = (bearer: string) =>
    endpointGate.withPermits(1)(
      Effect.gen(function* () {
        const insideMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
        const meanwhile = forcing ? undefined : cachedWithin(key, insideMs, USAGE_FRESH_MS);
        if (meanwhile) return { kind: "cached" as const, entry: meanwhile };
        if (!forcing && insideMs < pausedUntilFor(key)) return { kind: "paused" as const };
        const waitMs =
          lastEndpointReadAtMs === null
            ? 0
            : lastEndpointReadAtMs + USAGE_READ_SPACING_MS - insideMs;
        if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
        const output = yield* runUsageRead(processRunner, bearer, input.cliVersion);
        // The clock AFTER the read: a caller that queued behind five others
        // read seconds later than it asked, and its stamp and any pause it
        // earns must say so, or the pause ends early and the number ages early.
        const readAtMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
        lastEndpointReadAtMs = readAtMs;
        // Here, not at the top: this is the one line both the request and the
        // throttle agree happened. A force that never reached this point cost
        // the account nothing, so it must not cost the person their next press.
        if (forcing) forcedReadAtMs.set(key, readAtMs);
        return { kind: "read" as const, stdout: output.stdout, readAtMs };
      }),
    );
  // Twice at most: once with the token as remembered, once more with the
  // token the keychain holds now, when the first was rejected and they differ.
  for (let attempt = 0; ; attempt += 1) {
    const gated = yield* readThrough(token);
    if (gated.kind === "cached") return { ...forceThrottled, usage: stamped(gated.entry) };
    if (gated.kind === "paused") return paused({ ...fallback, ...forceThrottled }, key);

    const fetched = parseClaudeUsageResponse(gated.stdout);
    if (fetched.usage) {
      // Through the merge, not over the top of it: a poll refreshes all three
      // windows, but only where its reading is the newer one for that window.
      const entry = mergeReading(
        usageCache.get(key),
        readingFromUsage(fetched.usage, gated.readAtMs),
      );
      usageCache.set(key, entry);
      yield* persistUsageCache();
      return { ...forceThrottled, ...fetched, usage: stamped(entry) };
    }
    if (fetched.rateLimited === true) {
      usagePausedUntilByKey.set(
        key,
        Math.max(
          pausedUntilFor(key),
          gated.readAtMs + (fetched.retryAfterMs ?? USAGE_RATE_LIMIT_BACKOFF_MS),
        ),
      );
      yield* persistUsageCache();
      return {
        ...paused({ ...fallback, ...forceThrottled }, key),
        ...fetched,
        retryAtMs: pausedUntilFor(key),
      };
    }
    if (fetched.unauthorized === true) {
      // The one event that makes a remembered token wrong. The CLI rotates the
      // token whenever it runs — a keep-warm riddle, any turn — and the memory
      // here has no expiry, so every poll after a rotation opened with a 401.
      // Reporting that 401 and leaving the re-read to the NEXT poll is what put
      // "session expired — sign in again" on every row of the panel for a
      // minute, and what the automatic hand-over read as an account that could
      // no longer authenticate. So the keychain is asked again now, and when it
      // holds a different token the read is made again with it, inside this
      // call. Only a token the keychain still stands behind is a rejection.
      forgetClaudeAccountToken(input.configDir);
      if (attempt === 0) {
        const rotated = yield* readClaudeAccountToken(input.configDir);
        if (rotated !== undefined && rotated !== token) {
          token = rotated;
          continue;
        }
      }
      return { ...forceThrottled, ...fetched };
    }
    return { ...fallback, ...forceThrottled, ...fetched };
  }
});

/**
 * One read of the endpoint. `curl` rather than the HTTP client because this
 * must never be able to hang a background loop; the timeout is enforced by
 * the process itself.
 */
const runUsageRead = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
  token: string,
  cliVersion: string,
) =>
  processRunner
    .run({
      command: "curl",
      args: [
        "-s",
        "--max-time",
        String(USAGE_TIMEOUT_MS / 1000),
        USAGE_URL,
        // `@-` reads this header from stdin. A bearer token passed as an
        // argument sits in the process argument list, where any other local
        // user can read it with `ps` for the lifetime of the call — and this
        // runs every poll. Verified that curl accepts the header this way.
        "-H",
        "@-",
        "-H",
        "anthropic-beta: oauth-2025-04-20",
        // A wrong or absent User-Agent lands in a 429 bucket.
        "-H",
        `User-Agent: claude-code/${cliVersion}`,
        // Status code on its own line, then the headers as JSON — the status
        // separates a sign-in rejection from a garbled body, and the headers
        // carry the `retry-after` that says how long a 429 lasts.
        "-w",
        "\n%{http_code}\n%{header_json}",
      ],
      stdin: `Authorization: Bearer ${token}\n`,
      timeout: USAGE_TIMEOUT,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.orElseSucceed(() => ({ stdout: "" }) as { stdout: string }));
