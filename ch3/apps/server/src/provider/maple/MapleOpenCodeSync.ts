/**
 * Keeping OpenCode's config in step with the Maple catalogue.
 *
 * Maple's models reach CH3 through OpenCode, which only offers what its own
 * `opencode.json` names. That file is written once by hand and then goes stale:
 * when Maple ships a model, it stays invisible here until somebody remembers to
 * edit JSON. This closes that gap — the catalogue in
 * `@ch3tools/shared/mapleModels` is the source of truth and the config follows
 * it at boot.
 *
 * **This owns exactly one key: `provider.maple`.** Engineers keep MCP servers,
 * agents, keybindings and their own providers in the same file, and it has no
 * backup. Everything outside that key survives untouched, and three situations
 * refuse the write outright rather than risk it — see {@link writeMapleProviderBlock}.
 *
 * Deliberately NOT here: the API key and the proxy. The key travels per request
 * in the `Authorization` header OpenCode sends, sourced outside CH3, and the
 * config records only the literal `{env:MAPLE_API_KEY}`. The proxy is a separate
 * process; this records the address it is expected at, and defers to the
 * address already in the file over its own default, because the port belongs to
 * whoever started the proxy.
 *
 * @module provider/maple/MapleOpenCodeSync
 */
import * as NodeOS from "node:os";

import { MAPLE_PROXY_DEFAULT_BASE_URL } from "@ch3tools/shared/mapleModels";
import {
  mapleBaseUrlIn,
  mapleProviderIsCurrent,
  mergeMapleProvider,
} from "@ch3tools/shared/mapleOpenCodeConfig";
import { fromJsonStringPretty } from "@ch3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { expandHomePath } from "../../pathExpansion.ts";

/**
 * OpenCode's config, read and written whole.
 *
 * Strict JSON in both directions, deliberately. A JSONC config (comments,
 * trailing commas) fails to decode and is then refused rather than rewritten —
 * a lenient read would parse it and the write-back would silently delete the
 * engineer's comments.
 */
const OpenCodeConfigJson = fromJsonStringPretty(Schema.Unknown);
const decodeOpenCodeConfigJson = Schema.decodeEffect(OpenCodeConfigJson);
const encodeOpenCodeConfigJson = Schema.encodeUnknownEffect(OpenCodeConfigJson);

/**
 * An explicit address for the proxy, or `undefined` when nothing named one.
 *
 * `MAPLE_PROXY_BASE_URL` is read rather than configured because the process
 * that starts the proxy is the one that knows where it listens, and it is not
 * this one. Undefined is returned rather than the default so the caller can
 * fall back to the address the config already carries first — see
 * {@link writeMapleProviderBlock}.
 */
export function resolveMapleProxyBaseUrlOverride(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env["MAPLE_PROXY_BASE_URL"]?.trim();
  return explicit !== undefined && explicit.length > 0 ? explicit : undefined;
}

/**
 * The config file OpenCode reads, resolved exactly as OpenCode resolves it:
 * `OPENCODE_CONFIG` names a file outright, otherwise it is `opencode.json`
 * under the XDG config home. Writing to a path OpenCode does not read is a
 * silent no-op feature.
 */
export const resolveOpenCodeConfigPath = Effect.fn("resolveOpenCodeConfigPath")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const explicit = env["OPENCODE_CONFIG"]?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return path.resolve(expandHomePath(explicit));
  }
  const configHome = env["XDG_CONFIG_HOME"]?.trim();
  const base =
    configHome !== undefined && configHome.length > 0
      ? path.resolve(expandHomePath(configHome))
      : path.join(NodeOS.homedir(), ".config");
  return path.join(base, "opencode", "opencode.json");
});

/**
 * Put the `maple` provider block into OpenCode's config, leaving every other
 * key exactly as it was.
 *
 * Returns `null` on success and a sentence explaining the refusal otherwise.
 * Three refusals are deliberate:
 *
 * - **A config that cannot be read is never overwritten.** Only "the file is
 *   not there" counts as "no config". Anything else — a permission bit, an I/O
 *   error, a directory where a file should be — means a config exists that CH3
 *   cannot see, and the write below is an atomic rename, which needs the
 *   *directory's* permission rather than the file's and would therefore
 *   succeed in replacing something unread.
 * - **An unparseable config is never overwritten.** The file holds an
 *   engineer's MCP servers, agents and keybindings and has no backup.
 * - **A config that already carries this exact block is not rewritten**, so a
 *   boot does not churn the file's mtime for editors and watchers to notice.
 */
export const writeMapleProviderBlock = Effect.fn("writeMapleProviderBlock")(function* (input: {
  readonly configPath: string;
  readonly baseUrlOverride?: string | undefined;
}): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;

  const read = yield* Effect.result(fs.readFileString(input.configPath));
  if (Result.isFailure(read) && read.failure.reason._tag !== "NotFound") {
    yield* Effect.logError("Refused to rewrite an OpenCode config CH3 could not read", {
      configPath: input.configPath,
      reason: read.failure.reason._tag,
    });
    return `${input.configPath} exists but CH3 could not read it (${read.failure.reason._tag}), so it left the file alone rather than replacing it.`;
  }
  const raw = Result.isSuccess(read) ? read.success : null;

  let existing: Record<string, unknown> = {};
  if (raw !== null && raw.trim().length > 0) {
    const parsed = yield* decodeOpenCodeConfigJson(raw).pipe(
      Effect.tapError(() =>
        Effect.logError("Refused to rewrite an unreadable OpenCode config", {
          configPath: input.configPath,
        }),
      ),
      Effect.option,
    );
    if (Option.isNone(parsed)) {
      return `${input.configPath} is not strict JSON, so CH3 left it alone rather than rewriting it.`;
    }
    const value = parsed.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return `${input.configPath} does not hold a JSON object, so CH3 left it alone.`;
    }
    existing = value as Record<string, unknown>;
  }

  // Address precedence: an explicit override, then whatever the config already
  // says, then the loopback default. The middle step is the important one — the
  // default is this build's guess at a port, while the value in the file was
  // put there by whoever actually started the proxy. Overwriting it with the
  // guess repoints OpenCode at whatever else holds that port, which is silent:
  // a wrong server answering 200 is indistinguishable from the right one until
  // a turn hangs.
  const baseUrl = input.baseUrlOverride ?? mapleBaseUrlIn(existing) ?? MAPLE_PROXY_DEFAULT_BASE_URL;

  if (mapleProviderIsCurrent(existing, baseUrl)) {
    return null;
  }

  const contents = yield* encodeOpenCodeConfigJson(mergeMapleProvider({ existing, baseUrl })).pipe(
    Effect.orDie,
  );

  return yield* writeFileStringAtomically({ filePath: input.configPath, contents }).pipe(
    Effect.as<string | null>(null),
    Effect.tapError((cause) =>
      Effect.logError("Failed to write the Maple provider into OpenCode's config", {
        configPath: input.configPath,
        detail: String(cause),
      }),
    ),
    Effect.orElseSucceed(
      () => `CH3 could not write ${input.configPath}. Check the file's permissions.`,
    ),
  );
});

/**
 * Bring OpenCode's config up to date with the catalogue, once, at boot.
 *
 * Never fatal and never loud on the happy path: a refusal is logged as a
 * warning and the server carries on, because a stale Maple block costs the user
 * two models in a picker and a failed boot costs them everything.
 */
export const syncMapleProviderIntoOpenCode = Effect.fn("syncMapleProviderIntoOpenCode")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const configPath = yield* resolveOpenCodeConfigPath(env);
  const refusal = yield* writeMapleProviderBlock({
    configPath,
    baseUrlOverride: resolveMapleProxyBaseUrlOverride(env),
  });
  if (refusal !== null) {
    yield* Effect.logWarning("Left OpenCode's Maple provider block unchanged", {
      configPath,
      refusal,
    });
  }
});
