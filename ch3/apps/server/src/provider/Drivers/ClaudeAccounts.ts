/**
 * Claude account profiles.
 *
 * An "account" is a `CLAUDE_CONFIG_DIR` — its own OAuth credentials,
 * settings, MCP servers and transcripts. Switching accounts points a provider
 * instance at a different directory instead of signing out: both accounts
 * stay authenticated, switching back is instant, and a failed sign-in can
 * never strand the user signed out of everything.
 *
 * Everything here is local: directory reads plus the CLI's own control
 * channel. No model request is ever made, so none of it consumes tokens.
 *
 * @module ClaudeAccounts
 */
import * as NodeOS from "node:os";

import { ClaudeAccountError } from "@ch3tools/contracts";
import type { ClaudeAccountProfile, ClaudeSettings } from "@ch3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import { defaultClaudeConfigDirPath, makeClaudeEnvironment } from "./ClaudeHome.ts";
import * as Schema from "effect/Schema";

import { buildClaudeCapabilitiesProbeQueryOptions } from "../Layers/ClaudeProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  claudeCredentialServices,
  clearClaudeUsageCacheForAccount,
  type ClaudeAccountUsageFetch,
  fetchClaudeAccountUsage,
} from "./ClaudeAccountUsage.ts";

/**
 * The usage endpoint buckets requests by User-Agent; a wrong or absent version
 * lands in a 429 bucket. Only the shape matters, not the exact number.
 */
const CLAUDE_USAGE_USER_AGENT_VERSION = "2.1.221";

const homeRelativeDisplayPath = (absolutePath: string): string => {
  const home = NodeOS.homedir();
  return absolutePath === home
    ? "~"
    : absolutePath.startsWith(`${home}/`)
      ? `~${absolutePath.slice(home.length)}`
      : absolutePath;
};

/**
 * A hidden directory in the home folder is a profile when it either follows
 * the `.claude-*` naming this feature suggests, or already holds a
 * `.claude.json` — the file the CLI writes INSIDE a custom `CLAUDE_CONFIG_DIR`
 * the moment an account signs into it.
 *
 * Both halves are needed. The name alone misses a folder the user named
 * themselves: `~/.claudio-aurelio-0` signed in, reported success, and then
 * never appeared in the list again — not after a reload, not after a restart —
 * because nothing ever looked at it. The config file alone misses a folder
 * that was just created and has not been signed into yet, which would make the
 * row vanish for the length of the sign-in it is reporting on.
 *
 * Deliberately NOT a content check on the config: a profile that is signed out
 * must still be listed, so it can be signed back in from the same row.
 */
const isClaudeProfileDirectory = Effect.fn("isClaudeProfileDirectory")(function* (input: {
  readonly entryName: string;
  readonly candidatePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!input.entryName.startsWith(".")) return false;
  // A `.lock` sidecar (`~/.claude-work.lock`) is an ephemeral lock a tool
  // holds beside the real directory, not an account. It matches the
  // `.claude-` name prefix below, so without this it is listed as a duplicate
  // of the account it locks — same email, same organization, same quota.
  if (input.entryName.endsWith(".lock")) return false;
  const isDirectory = yield* fs.stat(input.candidatePath).pipe(
    Effect.map((stats) => stats.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
  if (!isDirectory) return false;
  if (input.entryName.startsWith(".claude-")) return true;
  return yield* fs
    .exists(path.join(input.candidatePath, ".claude.json"))
    .pipe(Effect.orElseSucceed(() => false));
});

/**
 * Candidate profile directories: the default Claude home, any sibling profile
 * directory in the home folder, and whatever the instance is configured with.
 * Deduplicated, order-stable.
 */
export const discoverClaudeProfilePaths = Effect.fn("discoverClaudeProfilePaths")(
  function* (input: { readonly configuredHomePath: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = NodeOS.homedir();
    const found: string[] = [yield* defaultClaudeConfigDirPath()];

    const entries = yield* fs.readDirectory(home).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const candidate = path.join(home, entry);
      const isProfile = yield* isClaudeProfileDirectory({
        entryName: entry,
        candidatePath: candidate,
      });
      if (isProfile) {
        found.push(candidate);
      }
    }

    const configured = input.configuredHomePath.trim();
    if (configured.length > 0) {
      found.push(path.resolve(expandHomePath(configured)));
    }
    return [...new Set(found)];
  },
);

/**
 * Every field is nullable, not merely optional. The CLI writes JSON `null`
 * for a tier that does not apply — `userRateLimitTier` is null on a personal
 * account — and a schema that only allows `string | absent` fails the WHOLE
 * decode on it. The profile then reads as "Not signed in" for an account that
 * is signed in, which is indistinguishable from a real sign-out. Anything read
 * out of this file must tolerate null on every key.
 */
const NullableString = Schema.optional(Schema.NullOr(Schema.String));

const decodeClaudeConfig = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    Schema.Struct({
      oauthAccount: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            emailAddress: NullableString,
            organizationName: NullableString,
            organizationUuid: NullableString,
            organizationRateLimitTier: NullableString,
            userRateLimitTier: NullableString,
            billingType: NullableString,
          }),
        ),
      ),
    }),
  ),
);

/** What a profile's CLI config says about the account signed into it. */
export interface ClaudeAccountIdentity {
  readonly email?: string;
  readonly organizationName?: string;
  readonly subscriptionLabel?: string;
}

/**
 * Reads the account out of a raw `.claude.json`. Total: an unreadable or
 * unrecognized file yields an empty identity rather than throwing.
 */
export const readClaudeAccountIdentity = (raw: string): ClaudeAccountIdentity => {
  if (raw.length === 0) return {};
  const parsed = decodeClaudeConfig(raw);
  if (parsed._tag !== "Success") return {};
  const account = parsed.value.oauthAccount;
  if (!account) return {};
  const email = account.emailAddress?.trim();
  const organizationName = account.organizationName?.trim();
  const subscriptionLabel = subscriptionLabelForAccount({
    ...(account.organizationRateLimitTier
      ? { organizationRateLimitTier: account.organizationRateLimitTier }
      : {}),
    ...(account.userRateLimitTier ? { userRateLimitTier: account.userRateLimitTier } : {}),
  });
  return {
    ...(email ? { email } : {}),
    ...(organizationName ? { organizationName } : {}),
    ...(subscriptionLabel ? { subscriptionLabel } : {}),
  };
};

/**
 * Which QUOTA a profile draws on, as a cache key for its usage reading.
 *
 * Account plus organization, the same pairing the rotation rules treat as one
 * quota: two directories signed into that pair share a 5-hour window, a weekly
 * window, and — the reason this exists — one rate-limit bucket. Reading them
 * separately spends two calls to learn one number and doubles the pressure on
 * the endpoint that refuses at 429.
 */
export const claudeAccountKey = (identity: {
  readonly email?: string | undefined;
  readonly organizationName?: string | undefined;
}): string => `${identity.email ?? ""}|${identity.organizationName ?? ""}`;

/** "default_claude_max_20x" -> "Claude Max Subscription". */
const subscriptionLabelFromTier = (tier: string | undefined): string | undefined => {
  const normalized = tier?.toLowerCase() ?? "";
  if (normalized.includes("max")) return "Claude Max Subscription";
  if (normalized.includes("team")) return "Claude Team Subscription";
  if (normalized.includes("pro")) return "Claude Pro Subscription";
  if (normalized.includes("enterprise")) return "Claude Enterprise Subscription";
  return undefined;
};

/**
 * The subscription behind a profile. A work organization records the plan on
 * the USER tier and leaves the organization tier as something unrecognizable
 * (`default_raven` on this machine), so reading only the organization tier
 * leaves the row blank for an account that plainly has a plan.
 */
const subscriptionLabelForAccount = (account: {
  readonly organizationRateLimitTier?: string | undefined;
  readonly userRateLimitTier?: string | undefined;
}): string | undefined =>
  subscriptionLabelFromTier(account.userRateLimitTier) ??
  subscriptionLabelFromTier(account.organizationRateLimitTier);

/**
 * Reads who a profile is signed in as, straight from the CLI's own config
 * file — `<profile>/.claude.json` for a custom `CLAUDE_CONFIG_DIR`, or
 * `~/.claude.json` for the default home. A file read costs nothing; spawning
 * the SDK probe per profile pegged the CPU and still reported nothing when
 * it timed out.
 */
export const probeClaudeProfile = Effect.fn("probeClaudeProfile")(function* (input: {
  readonly homePath: string;
  readonly isCurrent: boolean;
  /** Costs one HTTPS call per account, so callers opt in. */
  readonly includeUsage?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const isDefaultHome = input.homePath === (yield* defaultClaudeConfigDirPath());
  // The default profile keeps its config beside the home directory; a custom
  // CLAUDE_CONFIG_DIR keeps it inside. The switching path must honour the same
  // distinction, which is what `isDefaultHome` carries to the client.
  const configPath = isDefaultHome
    ? path.join(home, ".claude.json")
    : path.join(input.homePath, ".claude.json");
  const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  // The same login can hold several organizations — a personal one and a work
  // one — with different plans and separate limits. The email alone then reads
  // identically on every row, so the organization is what tells them apart.
  const identity = readClaudeAccountIdentity(raw);
  // A signed-out profile has no token, so asking would only cost a subprocess
  // to learn nothing.
  let fetched =
    input.includeUsage === true && (identity.email ?? "").length > 0
      ? yield* fetchClaudeAccountUsage({
          configDir: input.homePath,
          cliVersion: CLAUDE_USAGE_USER_AGENT_VERSION,
          accountKey: claudeAccountKey(identity),
        }).pipe(Effect.orElseSucceed(() => ({}) as ClaudeAccountUsageFetch))
      : ({} as ClaudeAccountUsageFetch);
  // The CLI keeps ONE credential per signed-in ACCOUNT, not one per config
  // directory: a re-login through the default profile leaves a custom
  // directory's own Keychain entry holding no account credential, while the
  // CLI keeps serving that directory from the default profile's entry
  // (observed on this machine — the work profile ran fine with its hashed
  // entry carrying only MCP tokens). When both profiles are signed in as the
  // SAME account and organization, reading usage through the default
  // directory reads the same account, so the fallback cannot report the
  // wrong one; profiles signed in as someone else keep the strict
  // per-directory refusal.
  //
  // Gated on the credential being MISSING, not on usage merely being absent:
  // a network failure must not trigger a second call to the same endpoint,
  // and only the borrowed USAGE is adopted — a rejection or silence from the
  // default directory's token says nothing about THIS profile beyond what is
  // already known (its own credential is gone), so those outcomes must not
  // overwrite that fact or, worse, mark this profile unauthorized on the
  // strength of someone else's token.
  if (
    input.includeUsage === true &&
    fetched.credentialMissing === true &&
    !fetched.usage &&
    fetched.unauthorized !== true &&
    !isDefaultHome &&
    (identity.email ?? "").length > 0
  ) {
    const defaultRaw = yield* fs
      .readFileString(path.join(home, ".claude.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    const defaultIdentity = readClaudeAccountIdentity(defaultRaw);
    if (
      defaultIdentity.email === identity.email &&
      defaultIdentity.organizationName === identity.organizationName
    ) {
      const borrowed = yield* fetchClaudeAccountUsage({
        configDir: yield* defaultClaudeConfigDirPath(),
        cliVersion: CLAUDE_USAGE_USER_AGENT_VERSION,
        // Same account and organization by the check above, so the borrowed
        // read belongs in the same cache slot — asking twice for one quota is
        // what the rate limiter punishes.
        accountKey: claudeAccountKey(defaultIdentity),
      }).pipe(Effect.orElseSucceed(() => ({}) as ClaudeAccountUsageFetch));
      if (borrowed.usage) {
        fetched = borrowed;
      }
    }
  }
  return {
    homePath: input.homePath,
    displayPath: homeRelativeDisplayPath(input.homePath),
    ...identity,
    ...(fetched.usage ? { usage: fetched.usage } : {}),
    ...(fetched.unauthorized ? { usageUnauthorized: true } : {}),
    ...(!fetched.usage && fetched.credentialMissing ? { usageCredentialMissing: true } : {}),
    ...(fetched.rateLimited ? { usageRateLimited: true } : {}),
    ...(fetched.stale ? { usageStale: true } : {}),
    isCurrent: input.isCurrent,
    isDefaultHome,
  } satisfies ClaudeAccountProfile;
});

/**
 * Every discovered profile with its sign-in state. Probes run concurrently —
 * one unauthenticated profile must not delay the rest.
 */
export const listClaudeAccountProfiles = Effect.fn("listClaudeAccountProfiles")(function* (input: {
  readonly configuredHomePath: string;
  readonly includeUsage?: boolean;
}) {
  const path = yield* Path.Path;
  const configured = input.configuredHomePath.trim();
  // An empty setting means "the CLI's defaults", which is the default config
  // directory — the same profile an explicit path to it would name.
  const currentPath =
    configured.length > 0
      ? path.resolve(expandHomePath(configured))
      : yield* defaultClaudeConfigDirPath();
  const candidates = yield* discoverClaudeProfilePaths({ configuredHomePath: configured });
  return yield* Effect.forEach(
    candidates,
    (homePath) =>
      probeClaudeProfile({
        homePath,
        isCurrent: homePath === currentPath,
        ...(input.includeUsage === true ? { includeUsage: true } : {}),
      }),
    { concurrency: "unbounded" },
  );
});

/** How long the Keychain delete may take before it is a stuck prompt, not a lookup. */
const KEYCHAIN_DELETE_TIMEOUT = Duration.seconds(3);

/**
 * Removes only the `oauthAccount` object from a CLI config file, preserving
 * every other key byte-for-byte in value (projects, history, MCP config, …).
 *
 * A whole-file rewrite would risk dropping state the CLI keeps in the same
 * file — `~/.claude.json` in particular holds far more than the account — so
 * this parses, deletes the single key, and re-serializes. A file that will not
 * parse is left untouched: corrupting the user's CLI config is worse than a
 * row that still shows an email.
 */
const removeOauthAccountFromConfig = Effect.fn("removeOauthAccountFromConfig")(function* (
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return;
  // Plain JSON, deliberately: a Schema struct decode would DROP every key it
  // does not name, but this must preserve all of the CLI's other state and
  // remove exactly one key. Unparseable JSON is left untouched rather than
  // risking corruption of the user's config.
  let parsed: unknown;
  try {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const config = parsed as Record<string, unknown>;
  if (!("oauthAccount" in config)) return;
  delete config.oauthAccount;
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const serialized = JSON.stringify(config, null, 2);
  // Atomic replace: `~/.claude.json` (the default home's config) is the large
  // file the CLI writes to constantly, so a bare truncate-and-write could be
  // torn by a crash or clobbered by a concurrent CLI write. Write a sibling
  // and rename it into place — atomic on the same filesystem — so a reader
  // (the CLI, or our own next probe) sees either the old file or the new one,
  // never a half-written one.
  const path = yield* Path.Path;
  // The config basename already starts with a dot (`.claude.json`), so the
  // temp sibling stays hidden without another leading dot.
  const tempPath = path.join(
    path.dirname(configPath),
    `${path.basename(configPath)}.ch3-signout-tmp`,
  );
  const wrote = yield* fs
    .writeFileString(tempPath, `${serialized}\n`)
    .pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  if (!wrote) return;
  const renamed = yield* fs
    .rename(tempPath, configPath)
    .pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  if (!renamed) {
    // Rename failed: drop the temp file rather than leave a stray sibling,
    // and leave the original config untouched.
    yield* fs.remove(tempPath).pipe(Effect.orElseSucceed(() => {}));
  }
});

/** The account config path for a profile home: beside the default, inside a custom dir. */
const claudeProfileConfigPath = (input: {
  readonly homePath: string;
  readonly home: string;
  readonly defaultDir: string;
  readonly join: (a: string, b: string) => string;
}): string =>
  input.homePath === input.defaultDir
    ? input.join(input.home, ".claude.json")
    : input.join(input.homePath, ".claude.json");

/** Two identities are the same account when email AND organization match, and there is an email. */
const claudeIdentitiesMatch = (a: ClaudeAccountIdentity, b: ClaudeAccountIdentity): boolean =>
  (a.email ?? "").length > 0 &&
  (a.email ?? "") === (b.email ?? "") &&
  (a.organizationName ?? "") === (b.organizationName ?? "");

/**
 * Whether a signed-in profile OTHER than `excludeHomePath` is signed into the
 * same account and organization.
 *
 * The CLI keeps ONE credential per account, so a custom directory signed into
 * the same account as the default home BORROWS the default's legacy Keychain
 * entry. Sign-out uses this to decide whether that shared entry is still
 * needed. File reads only — no network, no subprocess.
 */
export const anotherProfileSharesClaudeIdentity = Effect.fn("anotherProfileSharesClaudeIdentity")(
  function* (input: { readonly excludeHomePath: string; readonly identity: ClaudeAccountIdentity }) {
    if ((input.identity.email ?? "").length === 0) return false;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = NodeOS.homedir();
    const defaultDir = yield* defaultClaudeConfigDirPath();
    const candidates = yield* discoverClaudeProfilePaths({ configuredHomePath: "" });
    for (const candidate of candidates) {
      if (candidate === input.excludeHomePath) continue;
      const configPath = claudeProfileConfigPath({
        homePath: candidate,
        home,
        defaultDir,
        join: (a, b) => path.join(a, b),
      });
      const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
      if (claudeIdentitiesMatch(readClaudeAccountIdentity(raw), input.identity)) return true;
    }
    return false;
  },
);

/**
 * Signs an account out: the reverse of `startClaudeAccountLogin`, scoped to
 * ONE config directory so every other account stays signed in.
 *
 * Clears the three places the CLI keeps a session — the Keychain credential,
 * the on-disk `.credentials.json`, and the `oauthAccount` in the config — then
 * drops ONLY this account's usage cache. Every step is best-effort: a missing
 * artifact is success, because the goal state is "no session here".
 *
 * The one cross-account subtlety: the legacy unsuffixed Keychain entry is the
 * account's SHARED credential, borrowed by any other directory signed into the
 * same account. It is deleted only when nothing else shares this identity, so
 * signing out the default home cannot silently sign a sibling out too.
 *
 * Returns the re-probed profile, now reading as signed out.
 */
export const signOutClaudeAccount = Effect.fn("signOutClaudeAccount")(function* (input: {
  readonly homePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const home = NodeOS.homedir();
  const homePath = path.resolve(expandHomePath(input.homePath.trim()));
  const defaultDir = yield* defaultClaudeConfigDirPath();
  const isDefaultHome = homePath === defaultDir;
  const configPath = claudeProfileConfigPath({
    homePath,
    home,
    defaultDir,
    join: (a, b) => path.join(a, b),
  });

  // Identity of the directory being signed out, read BEFORE it is stripped: it
  // keys the cache eviction and decides whether the shared legacy credential
  // is still borrowed by a sibling.
  const identity = readClaudeAccountIdentity(
    yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => "")),
  );
  // On the safe side of an unreadable sibling: default to SPARING the shared
  // credential, never deleting one another directory might still borrow.
  const sharedByAnother = yield* anotherProfileSharesClaudeIdentity({
    excludeHomePath: homePath,
    identity,
  }).pipe(Effect.orElseSucceed(() => true));

  // Keychain first: the credential is what actually authorizes turns, so a
  // sign-out that left it behind would not be one. The legacy shared entry is
  // spared when a sibling still borrows it.
  for (const service of claudeCredentialServices(homePath)) {
    if (service === "Claude Code-credentials" && sharedByAnother) continue;
    yield* processRunner
      .run({
        command: "security",
        args: ["delete-generic-password", "-s", service],
        timeout: KEYCHAIN_DELETE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.orElseSucceed(() => ({ stdout: "" }) as { stdout: string }));
  }

  yield* fs
    .remove(path.join(homePath, ".credentials.json"))
    .pipe(Effect.orElseSucceed(() => {}));

  yield* removeOauthAccountFromConfig(configPath);

  // Evict ONLY this account's reading and 429 back-off — clearing the whole
  // cache would re-arm every other account's rate-limit penalty. The cache is
  // keyed by `claudeAccountKey`, the same key probeClaudeProfile fetched under.
  clearClaudeUsageCacheForAccount(claudeAccountKey(identity));

  // Total by construction: a re-probe that could not read the just-cleared
  // directory still describes a signed-out account, so it falls back to the
  // bare identity-less profile rather than failing the sign-out that already
  // succeeded.
  return yield* probeClaudeProfile({ homePath, isCurrent: false, includeUsage: false }).pipe(
    Effect.orElseSucceed(
      () =>
        ({
          homePath,
          displayPath: homeRelativeDisplayPath(homePath),
          isCurrent: false,
          isDefaultHome,
        }) satisfies ClaudeAccountProfile,
    ),
  );
});

/**
 * The sign-in controls live on the runtime Query class but are absent from
 * the SDK's published `Query` type, so they are feature-detected rather than
 * assumed — same treatment as the MCP auth controls.
 */
interface ClaudeLoginControls {
  readonly claudeAuthenticate?: (loginWithClaudeAi: boolean) => Promise<unknown>;
  readonly claudeOAuthWaitForCompletion?: () => Promise<unknown>;
  readonly close?: () => void;
}

/** A sign-in in flight: the CLI session holding the OAuth state. */
export interface PendingClaudeLogin {
  readonly homePath: string;
  readonly controls: ClaudeLoginControls;
  readonly abort: AbortController;
}

/**
 * The authenticate control answers with BOTH forms (verified against the
 * runtime, which returns exactly these keys):
 *
 *   automaticUrl — redirects to a localhost callback the CLI is listening on,
 *                  so the sign-in completes on its own and
 *                  `claudeOAuthWaitForCompletion()` resolves.
 *   manualUrl    — shows a code for the user to paste back.
 *
 * Prefer the automatic one; the manual one is the fallback. Looking for a
 * plain "url" key (as an earlier cut did) finds nothing, opens no browser,
 * and leaves the wait hanging forever.
 */
const readLoginUrl = (response: unknown): string | undefined => {
  if (typeof response === "string") {
    return response.startsWith("http") ? response : undefined;
  }
  if (response === null || typeof response !== "object") return undefined;
  for (const key of ["automaticUrl", "manualUrl", "url", "authUrl", "authorizationUrl"]) {
    const value = (response as Record<string, unknown>)[key];
    if (typeof value === "string" && value.startsWith("http")) return value;
  }
  return undefined;
};

/**
 * Starts the OAuth sign-in for one profile and hands back the URL to open.
 * The CLI session stays alive so the completion can be awaited; the caller
 * owns it and must finish or cancel it.
 */
export const startClaudeAccountLogin = Effect.fn("startClaudeAccountLogin")(function* (input: {
  readonly homePath: string;
  readonly settings: ClaudeSettings;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The folder arrives as the user typed it, so a leading `~` is a literal
  // character here — creating it unexpanded makes a directory named `~`
  // relative to the server's cwd instead of one in the home directory.
  const homePath = path.resolve(expandHomePath(input.homePath.trim()));
  // A brand-new profile is just an empty directory; the CLI populates it.
  yield* fs.makeDirectory(homePath, { recursive: true }).pipe(Effect.orElseSucceed(() => {}));
  const settings = { ...input.settings, homePath };
  const environment = yield* makeClaudeEnvironment(settings);
  const executablePath = yield* resolveClaudeSdkExecutablePath(settings.binaryPath, environment);
  const abort = new AbortController();
  const controls = yield* Effect.try(
    () =>
      claudeQuery({
        // Never yields: this session exists only to carry control requests,
        // so no prompt can reach the model.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await new Promise<void>((resolve) => {
            if (abort.signal.aborted) {
              resolve();
              return;
            }
            abort.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment,
          // Sign-in touches no repository; the probe options require the key.
          cwd: undefined,
        }),
      }) as unknown as ClaudeLoginControls,
  );
  if (!controls.claudeAuthenticate) {
    abort.abort();
    return yield* Effect.fail(
      new ClaudeAccountError({
        reason: "unsupported",
        detail: "This Claude runtime does not expose account sign-in.",
      }),
    );
  }
  const response = yield* Effect.tryPromise(() => controls.claudeAuthenticate!(true)).pipe(
    Effect.tapError(() => Effect.sync(() => abort.abort())),
  );
  const url = readLoginUrl(response);
  return {
    pending: { homePath, controls, abort } satisfies PendingClaudeLogin,
    ...(url ? { url } : {}),
  };
});

/**
 * A sign-in the person walked away from — closed the browser tab, hit a
 * company SSO wall, declined the authorization — would otherwise wait
 * forever, holding the CLI subprocess open and the account popover disabled.
 * Five minutes is enough to read an SSO page and find a phone for a code.
 */
export const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Waits for the browser half of the flow to finish, then releases the session. */
export const awaitClaudeAccountLogin = Effect.fn("awaitClaudeAccountLogin")(function* (
  pending: PendingClaudeLogin,
) {
  if (!pending.controls.claudeOAuthWaitForCompletion) {
    return yield* Effect.fail(
      new ClaudeAccountError({
        reason: "unsupported",
        detail: "This Claude runtime cannot report when sign-in completes.",
      }),
    );
  }
  const settled = yield* Effect.tryPromise(() =>
    pending.controls.claudeOAuthWaitForCompletion!(),
  ).pipe(
    Effect.timeoutOption(CLAUDE_LOGIN_TIMEOUT_MS),
    Effect.ensuring(Effect.sync(() => pending.abort.abort())),
  );
  if (settled._tag === "None") {
    return yield* Effect.fail(
      new ClaudeAccountError({
        reason: "failed",
        detail: "The sign-in was not completed in time. Start it again when you are ready.",
      }),
    );
  }
});
