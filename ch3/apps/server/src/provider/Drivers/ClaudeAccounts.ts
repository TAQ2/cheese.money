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
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
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
  forgetClaudeAccountToken,
  type ClaudeAccountUsageFetch,
  fetchClaudeAccountUsage,
} from "./ClaudeAccountUsage.ts";

/**
 * The usage endpoint buckets requests by User-Agent; a wrong or absent version
 * lands in a 429 bucket. Only the shape matters, not the exact number.
 */
export const CLAUDE_USAGE_USER_AGENT_VERSION = "2.1.221";

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
    const configuredPath = input.configuredHomePath.trim();
    const defaultDir = yield* defaultClaudeConfigDirPath();

    // `~/.claude` is listed only when it is actually there, or when it is the
    // profile this instance is set to use.
    //
    // Offered unconditionally, it put a row reading "~/.claude — Not signed in"
    // in front of everyone who has never run Claude Code: a path where an
    // account should be, for a directory that does not exist, which cannot be
    // signed into until the CLI is installed. It read as a broken account
    // rather than as an absence.
    const found: string[] = [];
    const defaultExists = yield* fs.exists(defaultDir).pipe(Effect.orElseSucceed(() => false));
    const defaultIsConfigured =
      configuredPath.length === 0 || path.resolve(expandHomePath(configuredPath)) === defaultDir;
    if (defaultExists || (defaultIsConfigured && configuredPath.length > 0)) {
      found.push(defaultDir);
    }

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

    if (configuredPath.length > 0) {
      found.push(path.resolve(expandHomePath(configuredPath)));
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
  /**
   * Read now, ignoring the freshness window and this account's pause.
   * User-initiated only — see `fetchClaudeAccountUsage`.
   */
  readonly forceUsage?: boolean;
  /** Return cached usage only, no network read — see `fetchClaudeAccountUsage`. */
  readonly cachedUsageOnly?: boolean;
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
          ...(input.forceUsage === true ? { force: true } : {}),
          ...(input.cachedUsageOnly === true ? { cachedOnly: true } : {}),
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
        ...(input.cachedUsageOnly === true ? { cachedOnly: true } : {}),
        // The force has to come with it. This profile's own directory holds no
        // usable credential — that is why the read is borrowed at all — so the
        // attempt above spent the throttle without a request leaving the
        // machine. Dropping the flag here makes "Read now" a button that
        // reports success, changes nothing, and refuses to try again for a
        // minute.
        ...(input.forceUsage === true ? { force: true } : {}),
      }).pipe(Effect.orElseSucceed(() => ({}) as ClaudeAccountUsageFetch));
      if (borrowed.usage) {
        fetched = borrowed;
      }
    }
  }
  // When the directory was made, which is when this account was added: signing
  // in is what creates it. Best-effort — a folder nobody has signed into has
  // no directory, and not every filesystem reports a birth time — so the
  // ordering that reads this treats absence as "unknown" rather than as zero.
  const createdAt = yield* fs.stat(input.homePath).pipe(
    Effect.map((stats) => Option.getOrUndefined(stats.birthtime)?.toISOString()),
    Effect.orElseSucceed(() => undefined),
  );
  const displayPath = homeRelativeDisplayPath(input.homePath);
  return {
    homePath: input.homePath,
    displayPath,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...identity,
    ...(fetched.usage ? { usage: fetched.usage } : {}),
    ...(fetched.unauthorized ? { usageUnauthorized: true } : {}),
    ...(!fetched.usage && fetched.credentialMissing ? { usageCredentialMissing: true } : {}),
    ...(fetched.rateLimited ? { usageRateLimited: true } : {}),
    ...(fetched.retryAtMs === undefined
      ? {}
      : { usageRetryAt: DateTime.formatIso(DateTime.makeUnsafe(fetched.retryAtMs)) }),
    ...(fetched.stale ? { usageStale: true } : {}),
    ...(fetched.unrecognized ? { usageShapeUnrecognized: true } : {}),
    ...(fetched.forceRetryAtMs === undefined
      ? {}
      : { usageForceRetryAt: DateTime.formatIso(DateTime.makeUnsafe(fetched.forceRetryAtMs)) }),
    isCurrent: input.isCurrent,
    isDefaultHome,
  } satisfies ClaudeAccountProfile;
});

/**
 * What the usage band may say about the account it is metering.
 *
 * The band probes ONE account directly rather than through
 * {@link listClaudeAccountProfiles} — one endpoint read a minute for the whole
 * app, instead of one per account — so the Mexico rule has to be asked here as
 * well. A hidden account keeps its meters: it is the account in use, it works,
 * and a band with no numbers on a working account is a worse lie than a band
 * with no name. What it loses is the name and the address, which is the whole
 * of "never appears".
 *
 * `accountEmailKnowable` is the caller's separate question — with two Claude
 * instances on two accounts, a blind answer would meter the wrong one.
 */
export function claudeUsageBandIdentity(input: {
  readonly profile:
    | {
        readonly email?: string | null;
        readonly organizationName?: string | null;
        readonly displayPath: string;
      }
    | undefined;
  readonly accountEmailKnowable: boolean;
}): { readonly accountLabel: string; readonly accountEmail: string } {
  const profile = input.profile;
  if (profile === undefined) {
    return { accountLabel: "", accountEmail: "" };
  }
  const organizationName = (profile.organizationName ?? "").trim();
  return {
    accountLabel: organizationName.length > 0 ? profile.organizationName! : (profile.email ?? ""),
    accountEmail: input.accountEmailKnowable ? (profile.email ?? "").trim() : "",
  };
}

/**
 * Every discovered profile with its sign-in state. Probes run concurrently —
 * one unauthenticated profile must not delay the rest.
 */
export const listClaudeAccountProfiles = Effect.fn("listClaudeAccountProfiles")(function* (input: {
  readonly configuredHomePath: string;
  readonly includeUsage?: boolean;
  /** Return cached usage only, no network read — the panel's first paint. */
  readonly cachedUsageOnly?: boolean;
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
  const profiles = yield* Effect.forEach(
    candidates,
    (homePath) =>
      probeClaudeProfile({
        homePath,
        isCurrent: homePath === currentPath,
        ...(input.includeUsage === true ? { includeUsage: true } : {}),
        ...(input.cachedUsageOnly === true ? { cachedUsageOnly: true } : {}),
      }),
    { concurrency: "unbounded" },
  );
  // Repairs accounts signed in BEFORE the sign-in flow started stamping the
  // onboarding flag: without it a terminal running `claude` against them opens
  // the first-run setup instead of the session. A no-op once stamped, and it
  // writes nothing for a slot with no config file at all.
  //
  // The rename is atomic against a TORN read, not against a lost update: a CLI
  // write landing between our read and our rename is discarded. That window is
  // one write per profile ever — the flag check above makes every later call a
  // pure read — which is why this sits here rather than behind migration state.
  const home = NodeOS.homedir();
  const defaultDir = yield* defaultClaudeConfigDirPath();
  yield* Effect.forEach(
    candidates,
    (homePath) =>
      markClaudeProfileOnboarded(
        claudeProfileConfigPath({ homePath, home, defaultDir, join: (a, b) => path.join(a, b) }),
      ),
    { concurrency: "unbounded", discard: true },
  );

  return profiles;
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
const removeOauthAccountFromConfig = (configPath: string) =>
  editClaudeConfigFile(configPath, (config) => {
    if (!("oauthAccount" in config)) return false;
    delete config.oauthAccount;
    return true;
  });

/**
 * Reads a CLI config file, hands it to `mutate`, and writes it back only when
 * `mutate` reports a change.
 *
 * One protocol for every edit CH3 makes to these files. There were two
 * copies of it and they had already drifted — the second computed the config
 * path by hand and got the default profile wrong, where the CLI keeps the
 * config BESIDE the directory. One copy, one temp-file name to recognise after
 * a crash, one place to be right.
 */
const editClaudeConfigFile = Effect.fn("editClaudeConfigFile")(function* (
  configPath: string,
  mutate: (config: Record<string, unknown>) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) return;
  // Plain JSON, deliberately: a Schema struct decode would DROP every key it
  // does not name, but this must preserve all of the CLI's other state and
  // change exactly what `mutate` touches. Unparseable JSON is left untouched
  // rather than risking corruption of the user's config.
  let parsed: unknown;
  try {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const config = parsed as Record<string, unknown>;
  if (!mutate(config)) return;
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
  const tempPath = path.join(path.dirname(configPath), `${path.basename(configPath)}.ch3-tmp`);
  const wrote = yield* fs.writeFileString(tempPath, `${serialized}\n`).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!wrote) return;
  const renamed = yield* fs.rename(tempPath, configPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!renamed) {
    // Rename failed: drop the temp file rather than leave a stray sibling,
    // and leave the original config untouched.
    yield* fs.remove(tempPath).pipe(Effect.orElseSucceed(() => {}));
  }
});

/**
 * Marks a profile's config as past the CLI's first-run setup.
 *
 * Signing in through CH3 writes the account into a fresh config directory
 * but never runs the CLI's interactive onboarding, so `hasCompletedOnboarding`
 * is absent. Nothing in the app notices — it drives the CLI programmatically.
 * A TERMINAL does: `claude` against that directory sees an un-onboarded config
 * and walks the new-user path — theme picker, then a sign-in prompt — while
 * the working credential sits right there unused. Orchestration runs launched
 * from a terminal died on that prompt.
 *
 * Only ever ADDS the flag. A config that already carries it, or that will not
 * parse, is left exactly as it was.
 */
const markClaudeProfileOnboarded = (configPath: string) =>
  editClaudeConfigFile(configPath, (config) => {
    if (config.hasCompletedOnboarding === true) return false;
    config.hasCompletedOnboarding = true;
    return true;
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
  function* (input: {
    readonly excludeHomePath: string;
    readonly identity: ClaudeAccountIdentity;
  }) {
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
  // On the safe side of an unreadable sibling OR an unreadable identity of
  // our own: default to SPARING the shared credential, never deleting one
  // another directory might still borrow. An empty identity cannot prove
  // "nobody else shares this", so treat it the same as the probe failing.
  const sharedByAnother =
    (identity.email ?? "").length === 0
      ? true
      : yield* anotherProfileSharesClaudeIdentity({
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

  yield* fs.remove(path.join(homePath, ".credentials.json")).pipe(Effect.orElseSucceed(() => {}));

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
  /** The login mkdir'd a fresh folder — remove it again if sign-in fails. */
  readonly createdDirectory: boolean;
  /** Who this folder is for, decided when the attempt started. See below. */
  readonly expectedEmail?: string;
  /**
   * Who this folder already held when the attempt started, if anyone.
   *
   * The folder's own account and nothing else. It separates a
   * re-authentication from a first sign-in, which is what the duplicate guard
   * turns on.
   */
  readonly previousEmail?: string;
}

/**
 * Which address a sign-in into this folder was STARTED for.
 *
 * Resolved once, when the attempt begins, because the source is about to be
 * overwritten by the sign-in itself: the address already in the folder, which
 * makes this a re-authentication. `~/.claude-3` is that person's directory
 * because that person is signed into it, and a different person coming back
 * from the flow is unambiguously wrong.
 *
 * An empty folder — someone adding a brand-new account — yields undefined, and
 * no check is made. There is genuinely no expectation to hold that sign-in to.
 */
export const claudeSignInExpectedEmail = (input: {
  readonly currentEmail?: string | undefined;
  readonly displayPath: string;
}): string | undefined => {
  const current = (input.currentEmail ?? "").trim();
  return current.length > 0 ? current : undefined;
};

/** What a completed sign-in turned out to be, against what it was started for. */
export type ClaudeSignInIdentityVerdict =
  | { readonly _tag: "Match" }
  | { readonly _tag: "Unverifiable"; readonly reason: "no-expectation" | "no-identity" }
  | { readonly _tag: "Mismatch"; readonly expected: string; readonly actual: string };

/**
 * Compared case-insensitively: the CLI writes back whatever casing the identity
 * provider hands it, and `Claudio.Cuatro@example.com` returning for
 * `claudio.cuatro@example.com` is the same person, not a wrong-account write.
 *
 * "Unverifiable" is deliberately distinct from "Match". An unreadable config is
 * not evidence that the right person signed in, and treating it as such is how
 * a guard quietly stops guarding.
 */
export const classifyClaudeSignInIdentity = (input: {
  readonly expectedEmail?: string | undefined;
  readonly actualEmail?: string | undefined;
}): ClaudeSignInIdentityVerdict => {
  const expected = (input.expectedEmail ?? "").trim();
  const actual = (input.actualEmail ?? "").trim();
  if (expected.length === 0) return { _tag: "Unverifiable", reason: "no-expectation" };
  if (actual.length === 0) return { _tag: "Unverifiable", reason: "no-identity" };
  if (expected.toLowerCase() === actual.toLowerCase()) return { _tag: "Match" };
  return { _tag: "Mismatch", expected, actual };
};

/**
 * The account signed into a profile directory right now. Total: a directory
 * that does not exist, or a config that will not parse, reads as nobody.
 */
const readClaudeProfileIdentity = Effect.fn("readClaudeProfileIdentity")(function* (
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultDir = yield* defaultClaudeConfigDirPath();
  return readClaudeAccountIdentity(
    yield* fs
      .readFileString(
        claudeProfileConfigPath({
          homePath,
          home: NodeOS.homedir(),
          defaultDir,
          join: (a, b) => path.join(a, b),
        }),
      )
      .pipe(Effect.orElseSucceed(() => "")),
  );
});

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
  // Remember whether this attempt created it: an abandoned sign-in must not
  // leave a dead "Not signed in" folder behind in the accounts list.
  const directoryExisted = yield* fs.exists(homePath).pipe(Effect.orElseSucceed(() => true));
  yield* fs.makeDirectory(homePath, { recursive: true }).pipe(Effect.orElseSucceed(() => {}));
  // Read BEFORE the CLI writes over it: after the sign-in there is no way left
  // to tell who this folder belonged to a moment ago.
  const currentEmail = (yield* readClaudeProfileIdentity(homePath)).email;
  const expectedEmail = claudeSignInExpectedEmail({
    ...(currentEmail ? { currentEmail } : {}),
    displayPath: homeRelativeDisplayPath(homePath),
  });
  const settings = { ...input.settings, homePath };
  const baseEnvironment = yield* makeClaudeEnvironment(settings);
  // The CLI's automatic OAuth flow opens the system browser ITSELF — a stray
  // external tab that competes with the in-app sign-in window CH3 renders.
  // BROWSER is the CLI's opener override; `true` is a no-op executable, so
  // the only sign-in surface left is the one the app controls.
  const environment = { ...baseEnvironment, BROWSER: "true" };
  const executablePath = yield* resolveClaudeSdkExecutablePath(settings.binaryPath, environment);
  yield* ensureClaudeExecutableRuns({ executablePath, environment });
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
  const response = yield* Effect.tryPromise({
    try: () => controls.claudeAuthenticate!(true),
    catch: (cause) =>
      new ClaudeAccountError({
        reason: "failed",
        detail: `The Claude sign-in could not start: ${describeRejection(cause)}`,
        cause,
      }),
  }).pipe(Effect.tapError(() => Effect.sync(() => abort.abort())));
  const url = readLoginUrl(response);
  return {
    pending: {
      homePath,
      controls,
      abort,
      createdDirectory: !directoryExisted,
      ...(expectedEmail ? { expectedEmail } : {}),
      ...(currentEmail ? { previousEmail: currentEmail } : {}),
    } satisfies PendingClaudeLogin,
    ...(url ? { url } : {}),
  };
});

/** Long enough for a cold CLI on a slow disk, short enough not to look hung. */
const CLAUDE_EXECUTABLE_PROBE_TIMEOUT = Duration.seconds(20);

/**
 * A sign-in the person walked away from — closed the browser tab, hit a
 * company SSO wall, declined the authorization — would otherwise wait
 * forever, holding the CLI subprocess open and the account popover disabled.
 * Five minutes is enough to read an SSO page and find a phone for a code.
 */
export const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Removes the directory an abandoned sign-in created — and nothing else.
 *
 * Two guards, both load-bearing. Only a folder THIS login created is a
 * candidate: an existing profile directory is never touched. And only while it
 * still holds no account: an abandoned login lives on here for the full
 * timeout, and in that time the user can start a second sign-in into the same
 * folder and complete it. Deleting on the first attempt's clock would then
 * destroy a live account, credentials and all, minutes after the user watched
 * it succeed — so the account is re-read at the moment of deletion, not
 * trusted from when the attempt began.
 */
const discardAbandonedLoginDirectory = (pending: PendingClaudeLogin) =>
  pending.createdDirectory
    ? Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const raw = yield* fs
          .readFileString(path.join(pending.homePath, ".claude.json"))
          .pipe(Effect.orElseSucceed(() => ""));
        if ((readClaudeAccountIdentity(raw).email ?? "").length > 0) return;
        yield* fs.remove(pending.homePath, { recursive: true, force: true }).pipe(Effect.ignore);
      }).pipe(Effect.ignore)
    : Effect.void;

/**
 * Abandons a sign-in on purpose: stops the CLI session now rather than leaving
 * it to expire on its own, and clears up after it under the same rules an
 * expiry would follow.
 */
export const cancelClaudeAccountLogin = Effect.fn("cancelClaudeAccountLogin")(function* (
  pending: PendingClaudeLogin,
) {
  pending.abort.abort();
  yield* discardAbandonedLoginDirectory(pending);
});

/**
 * What a rejected SDK promise actually said.
 *
 * `Effect.tryPromise` without a `catch` fails with `UnknownException`, whose
 * message is the literal string "An error occurred in Effect.tryPromise". That
 * string reached the account panel and was the only thing a person saw when
 * sign-in failed — it names no cause, no file and no action. CH3's CFO sat
 * in front of it and could not use CH3 at all.
 */
export function describeRejection(cause: unknown): string {
  if (cause instanceof Error) {
    const parts = [cause.message.trim()];
    // Node puts the useful half of a spawn failure on these.
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && !cause.message.includes(code)) parts.push(`(${code})`);
    const joined = parts.filter(Boolean).join(" ");
    // An Error with a blank message stringifies to "Error:", which says even
    // less than admitting there was no reason.
    return joined.length > 0 ? joined : "no reason given";
  }
  const text = String(cause).trim();
  return text.length > 0 && text !== "[object Object]" ? text : "no reason given";
}

/**
 * Refuse to start a sign-in the machine cannot finish.
 *
 * The sign-in spawns the Claude Code CLI through the Agent SDK. On a machine
 * without it — which is most machines belonging to people who do not work in a
 * terminal — the spawn rejects deep inside the SDK and the panel showed a
 * sentence about Effect. CH3 installs the CLI on first launch, but that
 * install is deliberately silent and not fatal, so when it cannot run (no
 * package manager, no network, a locked global prefix) nothing else ever said
 * so. This is the place that says so, before anything else is attempted.
 */
const ensureClaudeExecutableRuns = Effect.fn("ensureClaudeExecutableRuns")(function* (input: {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const probe = yield* processRunner
    .run({
      command: input.executablePath,
      args: ["--version"],
      env: input.environment,
      timeout: CLAUDE_EXECUTABLE_PROBE_TIMEOUT,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);

  if (probe._tag === "Some" && probe.value.code === 0 && !probe.value.timedOut) return;

  const detail =
    probe._tag === "None"
      ? `CH3 could not run the Claude Code CLI (\`${input.executablePath}\`). It is normally installed for you on first launch; if that did not happen, install it with \`npm install -g @anthropic-ai/claude-code\` and try again.`
      : `The Claude Code CLI (\`${input.executablePath}\`) did not answer \`--version\`${
          probe.value.stderr.trim().length > 0
            ? `: ${probe.value.stderr.trim().slice(0, 200)}`
            : "."
        } Install or repair it with \`npm install -g @anthropic-ai/claude-code\`.`;

  return yield* Effect.fail(new ClaudeAccountError({ reason: "cli-missing", detail }));
});

/** Waits for the browser half of the flow to finish, then releases the session. */
export const awaitClaudeAccountLogin = Effect.fn("awaitClaudeAccountLogin")(function* (
  pending: PendingClaudeLogin,
) {
  const discardCreatedDirectory = discardAbandonedLoginDirectory(pending);
  if (!pending.controls.claudeOAuthWaitForCompletion) {
    return yield* Effect.fail(
      new ClaudeAccountError({
        reason: "unsupported",
        detail: "This Claude runtime cannot report when sign-in completes.",
      }),
    );
  }
  const settled = yield* Effect.tryPromise({
    try: () => pending.controls.claudeOAuthWaitForCompletion!(),
    catch: (cause) =>
      new ClaudeAccountError({
        reason: "failed",
        detail: `The sign-in did not complete: ${describeRejection(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.timeoutOption(CLAUDE_LOGIN_TIMEOUT_MS),
    Effect.ensuring(Effect.sync(() => pending.abort.abort())),
  );
  if (settled._tag === "None") {
    yield* discardCreatedDirectory;
    return yield* Effect.fail(
      new ClaudeAccountError({
        reason: "failed",
        detail: "The sign-in was not completed in time. Start it again when you are ready.",
      }),
    );
  }
  // Who actually came back. Checked BEFORE the directory is stamped as
  // onboarded, so a wrong-account write is undone rather than tidied up.
  //
  // Isolating the sign-in window's cookie jar is what should make this
  // impossible (see apps/desktop/src/window/claudeSignInWindow.ts). This is the
  // backstop, and it exists because the failure mode it guards was SILENT: the
  // wrong credential landed in the folder, the panel said "Signed in as …",
  // and nobody found out until they read the accounts list days later. A
  // sign-in that goes wrong now says so and leaves nothing behind.
  const signedInIdentity = yield* readClaudeProfileIdentity(pending.homePath);
  const signedInEmail = signedInIdentity.email;
  const verdict = classifyClaudeSignInIdentity({
    ...(pending.expectedEmail ? { expectedEmail: pending.expectedEmail } : {}),
    ...(signedInEmail ? { actualEmail: signedInEmail } : {}),
  });
  if (verdict._tag === "Unverifiable" && verdict.reason === "no-identity") {
    // Knew who to expect and could not read who arrived. Not a failure — the
    // CLI may simply not have flushed the config yet, and the profile probe
    // that follows will show the account as signed out, which is visible. But
    // a guard that could not run must leave a trace, or the next person to
    // read this code cannot tell "never fired" from "always passed".
    yield* Effect.logWarning("could not verify which Claude account signed in", {
      homePath: pending.homePath,
      expectedEmail: pending.expectedEmail,
    });
  }
  if (verdict._tag === "Mismatch") {
    yield* Effect.logError("Claude sign-in completed as the wrong account", {
      homePath: pending.homePath,
      expectedEmail: verdict.expected,
      signedInEmail: verdict.actual,
    });
    // Best-effort, and ignored on purpose: failing to clean up must not turn
    // into a DIFFERENT error that hides which account signed in. The
    // ClaudeAccountError below is the one the user needs to read.
    yield* signOutClaudeAccount({ homePath: pending.homePath }).pipe(Effect.ignore);
    // Only removes a folder THIS attempt created, and only once no account is
    // left in it — which the sign-out above has just arranged.
    yield* discardCreatedDirectory;
    return yield* Effect.fail(
      new ClaudeAccountError({
        reason: "failed",
        detail:
          `Signed in as ${verdict.actual}, but this folder is ${verdict.expected}'s. ` +
          `The credential was removed rather than left in the wrong account's folder. ` +
          `Start the sign-in again and authenticate as ${verdict.expected}, or add ` +
          `${verdict.actual} in a folder of its own.`,
      }),
    );
  }

  // A folder that held nobody must not become a SECOND home for an account
  // that already lives in another folder.
  //
  // That is what filled the accounts list with the same address three times:
  // every "Add account" opened a sign-in window carrying the previous account's
  // cookies, came back as that same person, and wrote them into one more fresh
  // folder. Isolating the cookie jar removes the cause; this removes the
  // outcome, including when the user genuinely authenticates as an account they
  // already hold.
  //
  // Only for a folder with no prior identity of its own. Re-authenticating a
  // folder that already IS a duplicate has to keep working, or the folders this
  // bug has already created could never be signed back in and repaired.
  if ((pending.previousEmail ?? "").length === 0 && (signedInEmail ?? "").length > 0) {
    const heldElsewhere = yield* anotherProfileSharesClaudeIdentity({
      excludeHomePath: pending.homePath,
      identity: signedInIdentity,
    });
    if (heldElsewhere) {
      yield* Effect.logError("Claude sign-in landed an account that already has a folder", {
        homePath: pending.homePath,
        signedInEmail,
      });
      // Same order and the same reasoning as the wrong-account branch above.
      // The shared legacy Keychain entry survives this: `signOutClaudeAccount`
      // deletes it only when no other profile is signed into the identity, and
      // the folder that already holds this account still is.
      yield* signOutClaudeAccount({ homePath: pending.homePath }).pipe(Effect.ignore);
      yield* discardCreatedDirectory;
      return yield* Effect.fail(
        new ClaudeAccountError({
          reason: "failed",
          detail:
            `${signedInEmail} is already signed in to another folder, so this one was ` +
            `left empty rather than added as a second copy of the same account. ` +
            `Use the account you already have, or sign in as a different one.`,
        }),
      );
    }
  }

  // The CLI has just written this directory's config. Stamp it as onboarded so
  // a terminal running `claude` against this account gets a working session
  // instead of the first-run theme-and-sign-in flow.
  const path = yield* Path.Path;
  const defaultDir = yield* defaultClaudeConfigDirPath();
  yield* markClaudeProfileOnboarded(
    claudeProfileConfigPath({
      homePath: pending.homePath,
      home: NodeOS.homedir(),
      defaultDir,
      join: (a, b) => path.join(a, b),
    }),
  );

  // The usage reader remembers "no credential in this directory" for five
  // minutes so an account-less machine is not spawning `security` every poll.
  // A sign-in is the one event that makes that memory wrong, and it is our
  // own event — so forget it here rather than leaving the row reading "sign
  // in again to see usage" for up to five minutes after the person just did,
  // which reads as the sign-in having failed and sends them to do it twice.
  forgetClaudeAccountToken(pending.homePath);
});
