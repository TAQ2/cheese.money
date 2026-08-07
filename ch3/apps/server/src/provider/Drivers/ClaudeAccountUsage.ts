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
}

/**
 * `curl` prints the response body, then the status code alone on a final line
 * (the `-w` format below). Splitting here keeps the two apart even when the
 * body is empty. A 401/403 is reported as `unauthorized` — the difference
 * between "this account cannot sign its requests" and "the network hiccuped"
 * is exactly what the automatic hand-over needs.
 */
export const parseClaudeUsageResponse = (raw: string): ClaudeAccountUsageFetch => {
  const trimmed = raw.trimEnd();
  const lastBreak = trimmed.lastIndexOf("\n");
  if (lastBreak < 0) return {};
  const status = Number.parseInt(trimmed.slice(lastBreak + 1).trim(), 10);
  const body = trimmed.slice(0, lastBreak);
  if (status === 401 || status === 403) return { unauthorized: true };
  if (status !== 200) return {};
  const usage = parseClaudeAccountUsage(body);
  return usage ? { usage } : {};
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
 * Usage for one account, with sign-in failures told apart from silence.
 *
 * `curl` rather than the HTTP client because this must never be able to hang a
 * background loop; the timeout is enforced by the process itself.
 */
export const fetchClaudeAccountUsage = Effect.fn("fetchClaudeAccountUsage")(function* (input: {
  readonly configDir: string;
  readonly cliVersion: string;
}): Effect.fn.Return<
  ClaudeAccountUsageFetch,
  never,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
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
        // Status code on its own final line, so a sign-in rejection is
        // distinguishable from an empty or garbled body.
        "-w",
        "\n%{http_code}",
      ],
      stdin: `Authorization: Bearer ${token}\n`,
      timeout: USAGE_TIMEOUT,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.orElseSucceed(() => ({ stdout: "" }) as { stdout: string }));

  return parseClaudeUsageResponse(output.stdout);
});
