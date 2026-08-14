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

import type { ClaudeAccountUsage } from "@ch3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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

  const fromFile = yield* fs
    .readFileString(path.join(configDir, ".credentials.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  const fileToken = readAccessToken(fromFile);
  if (fileToken) return fileToken;

  for (const service of claudeCredentialServices(configDir)) {
    const output = yield* processRunner
      .run({
        command: "security",
        args: ["find-generic-password", "-s", service, "-w"],
        timeout: KEYCHAIN_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.orElseSucceed(() => ({ stdout: "" }) as { stdout: string }));
    const token = readAccessToken(output.stdout);
    if (token) return token;
  }
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
  /** The usage came from the cache because the live read did not land. */
  readonly stale?: boolean;
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
  return usage ? { usage } : {};
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
  return {
    sessionPercent: session,
    weekPercent: week,
    ...(sessionResetsAt ? { sessionResetsAt } : {}),
    ...(weekResetsAt ? { weekResetsAt } : {}),
  };
};

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
 * How long a reading still beats nothing once the live read fails.
 *
 * The bug this exists for: a 429 turned every account's usage into "unknown",
 * every decision path treats unknown as "stay put", and so an account at 100%
 * of its 5-hour window kept the seat while a sibling sat at 12%. A reading
 * minutes old is imperfect evidence; no evidence at all is a guaranteed stall.
 * Beyond this the cached number is dropped, because acting on a quarter-hour-old
 * reading is the mistake in the other direction.
 */
export const USAGE_STALE_MS = 15 * 60_000;

/** Backoff when a 429 arrives without a `retry-after` to obey. */
export const USAGE_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

interface CachedUsage {
  readonly usage: ClaudeAccountUsage;
  readonly atMs: number;
}

/**
 * Last good reading per ACCOUNT, and the instant each account may be asked
 * again. Keyed by identity rather than by config directory so two directories
 * signed into the same account and organization — which share one quota, and
 * therefore one rate-limit bucket — cost one call between them instead of two.
 */
const usageCache = new Map<string, CachedUsage>();
const usageRetryAfter = new Map<string, number>();

/** Drops every cached reading. Used by tests, and by a sign-in that changes who an account is. */
export const clearClaudeUsageCache = (): void => {
  usageCache.clear();
  usageRetryAfter.clear();
};

/**
 * Drops one account's cached reading and its 429 back-off. Scoped on purpose:
 * clearing the whole cache on a single account's sign-out would wipe every
 * OTHER account's `retry-after` too, so the next poll would ask an account
 * mid-penalty and re-earn the 429 this cache exists to avoid.
 */
export const clearClaudeUsageCacheForAccount = (accountKey: string): void => {
  usageCache.delete(accountKey);
  usageRetryAfter.delete(accountKey);
};

const cachedWithin = (key: string, nowMs: number, windowMs: number): CachedUsage | undefined => {
  const cached = usageCache.get(key);
  return cached && nowMs - cached.atMs < windowMs ? cached : undefined;
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
}): Effect.fn.Return<
  ClaudeAccountUsageFetch,
  never,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const key = (input.accountKey ?? "").trim().length > 0 ? input.accountKey! : input.configDir;
  const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  const fresh = cachedWithin(key, nowMs, USAGE_FRESH_MS);
  if (fresh) return { usage: fresh.usage };

  // A reading that stands in for a failed call, or undefined when there is
  // none recent enough to trust. Never returned for a REJECTED token: an
  // unauthorized account is dead, and covering that with a stale number is
  // how a dead profile keeps the seat.
  const stale = cachedWithin(key, nowMs, USAGE_STALE_MS);
  const fallback: ClaudeAccountUsageFetch = stale ? { usage: stale.usage, stale: true } : {};

  const retryAfter = usageRetryAfter.get(key) ?? 0;
  if (nowMs < retryAfter) return { ...fallback, rateLimited: true };

  const token = yield* readClaudeAccountToken(input.configDir);
  if (!token) return { credentialMissing: true };

  const output = yield* processRunner
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
        `User-Agent: claude-code/${input.cliVersion}`,
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

  const fetched = parseClaudeUsageResponse(output.stdout);
  if (fetched.usage) {
    usageCache.set(key, { usage: fetched.usage, atMs: nowMs });
    usageRetryAfter.delete(key);
    return fetched;
  }
  if (fetched.rateLimited === true) {
    usageRetryAfter.set(key, nowMs + (fetched.retryAfterMs ?? USAGE_RATE_LIMIT_BACKOFF_MS));
    return { ...fallback, ...fetched };
  }
  if (fetched.unauthorized === true) return fetched;
  return { ...fallback, ...fetched };
});
