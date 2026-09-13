import { ClaudeAccountError } from "@ch3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import { clearClaudeUsageCache, readClaudeAccountToken } from "./ClaudeAccountUsage.ts";
import {
  anotherProfileSharesClaudeIdentity,
  awaitClaudeAccountLogin,
  claudeSignInExpectedEmail,
  classifyClaudeSignInIdentity,
  claudeUsageBandIdentity,
  discoverClaudeProfilePaths,
  listClaudeAccountProfiles,
  readClaudeAccountIdentity,
  describeRejection,
  signOutClaudeAccount,
} from "./ClaudeAccounts.ts";

// Both payloads are the real shapes on this machine, trimmed to the keys that
// matter. The personal account writes JSON null for `userRateLimitTier`; the
// work account writes a string there and an unrecognized organization tier.
const personalConfig = JSON.stringify({
  userID: "b006173511afbc90",
  oauthAccount: {
    accountUuid: "2f7c3261-0604-4657-8a09-1725e337fc45",
    emailAddress: "conrad@example.com",
    organizationName: "conrad@example.com's Organization",
    organizationRateLimitTier: "default_claude_max_20x",
    userRateLimitTier: null,
    billingType: "stripe_subscription",
  },
});

const workConfig = JSON.stringify({
  oauthAccount: {
    emailAddress: "conrad@example.com",
    organizationName: "CH3",
    organizationRateLimitTier: "default_raven",
    userRateLimitTier: "default_claude_max_5x",
    billingType: "stripe_subscription",
  },
});

describe("Claude account identity", () => {
  it("reads a personal account whose user tier is null", () => {
    // The regression: declaring `userRateLimitTier` as string-or-absent made
    // this null fail the whole decode, so a signed-in account reported as
    // "Not signed in" — indistinguishable from a real sign-out.
    expect(readClaudeAccountIdentity(personalConfig)).toEqual({
      email: "conrad@example.com",
      organizationName: "conrad@example.com's Organization",
      subscriptionLabel: "Claude Max Subscription",
    });
  });

  it("falls back to the user tier when the organization tier is unrecognized", () => {
    // A work organization records the plan on the user tier and leaves the
    // organization tier as something meaningless (`default_raven`).
    expect(readClaudeAccountIdentity(workConfig)).toEqual({
      email: "conrad@example.com",
      organizationName: "CH3",
      subscriptionLabel: "Claude Max Subscription",
    });
  });

  it("distinguishes two organizations behind one login", () => {
    const personal = readClaudeAccountIdentity(personalConfig);
    const work = readClaudeAccountIdentity(workConfig);
    expect(personal.email).toBe(work.email);
    expect(personal.organizationName).not.toBe(work.organizationName);
  });

  it("reports no account rather than throwing on junk, empty, or signed-out configs", () => {
    expect(readClaudeAccountIdentity("")).toEqual({});
    expect(readClaudeAccountIdentity("not json at all")).toEqual({});
    expect(readClaudeAccountIdentity(JSON.stringify({}))).toEqual({});
    expect(readClaudeAccountIdentity(JSON.stringify({ oauthAccount: null }))).toEqual({});
  });

  it("survives every field being null", () => {
    const allNull = JSON.stringify({
      oauthAccount: {
        emailAddress: null,
        organizationName: null,
        organizationRateLimitTier: null,
        userRateLimitTier: null,
        billingType: null,
      },
    });
    expect(readClaudeAccountIdentity(allNull)).toEqual({});
  });
});

it.layer(NodeServices.layer)("Claude profile discovery", (it) => {
  // NodeOS.homedir() honours $HOME on POSIX, so the whole exercise runs in a
  // temp directory and never reads the real home folder.
  const withFakeHome = <A, E, R>(body: (fakeHome: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fakeHome = yield* fs.makeTempDirectoryScoped();
      const realHome = process.env.HOME;
      process.env.HOME = fakeHome;
      return yield* body(fakeHome).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (realHome === undefined) delete process.env.HOME;
            else process.env.HOME = realHome;
          }),
        ),
      );
    }).pipe(Effect.scoped);

  it.effect("finds an account folder the user named themselves", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The regression: discovery matched on a `.claude-` name prefix, so a
        // folder named after the account signed in fine, reported success, and
        // then never appeared in the list again — a restart no help, because
        // the sign-in was real and only the lookup was blind to it.
        const named = path.join(fakeHome, ".claudio-aurelio-0");
        yield* fs.makeDirectory(named, { recursive: true });
        yield* fs.writeFileString(path.join(named, ".claude.json"), "{}");
        // The naming convention still counts on its own: a folder created for
        // a sign-in that has not completed yet holds no config.
        const conventional = path.join(fakeHome, ".claude-work");
        yield* fs.makeDirectory(conventional, { recursive: true });

        // The default home exists here, so it belongs in the list.
        yield* fs.makeDirectory(path.join(fakeHome, ".claude"), { recursive: true });

        const found = yield* discoverClaudeProfilePaths({ configuredHomePath: "" });

        expect(found).toContain(named);
        expect(found).toContain(conventional);
        expect(found).toContain(path.join(fakeHome, ".claude"));
      }),
    ),
  );

  it.effect("ignores home folders that are not config directories", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // A visible project folder is not a profile even when it carries a
        // config file, and a hidden folder without one is just a dotfile dir.
        yield* fs.makeDirectory(path.join(fakeHome, "Desktop"), { recursive: true });
        yield* fs.writeFileString(path.join(fakeHome, "Desktop", ".claude.json"), "{}");
        yield* fs.makeDirectory(path.join(fakeHome, ".ssh"), { recursive: true });
        // The default home keeps its config BESIDE itself, so this file must
        // not be mistaken for a profile marker on some other directory.
        yield* fs.writeFileString(path.join(fakeHome, ".claude.json"), "{}");

        const found = yield* discoverClaudeProfilePaths({ configuredHomePath: "" });

        expect(found).not.toContain(path.join(fakeHome, "Desktop"));
        expect(found).not.toContain(path.join(fakeHome, ".ssh"));
        // `~/.claude` does not exist in this home, so it is NOT offered: a row
        // for a directory that is not there reads as a broken account to
        // someone who has never installed Claude Code, which is exactly who
        // sees it.
        expect(found).not.toContain(path.join(fakeHome, ".claude"));
        expect(found).toEqual([]);
      }),
    ),
  );

  it.effect("keeps the default home when the instance is pointed at it", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        // Chosen deliberately rather than defaulted: the row is where a
        // sign-in would land, so hiding it would leave the person with a
        // selection they cannot see.
        const found = yield* discoverClaudeProfilePaths({
          configuredHomePath: path.join(fakeHome, ".claude"),
        });

        expect(found).toContain(path.join(fakeHome, ".claude"));
      }),
    ),
  );

  it.effect("excludes a `.lock` sidecar so it is not listed as a duplicate account", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The real account directory, and the ephemeral lock a tool holds
        // beside it. The lock matches the `.claude-` prefix, so without the
        // `.lock` exclusion it was enumerated as a second account with the
        // same identity and quota.
        const account = path.join(fakeHome, ".claude-work");
        yield* fs.makeDirectory(account, { recursive: true });
        yield* fs.writeFileString(path.join(account, ".claude.json"), "{}");
        const lock = path.join(fakeHome, ".claude-work.lock");
        yield* fs.makeDirectory(lock, { recursive: true });
        yield* fs.writeFileString(path.join(lock, ".claude.json"), "{}");

        const found = yield* discoverClaudeProfilePaths({ configuredHomePath: "" });

        expect(found).toContain(account);
        expect(found).not.toContain(lock);
      }),
    ),
  );

  // `probeClaudeProfile` can reach the usage endpoint through ProcessRunner,
  // so the requirement is in its type even with `includeUsage` off. Nothing
  // here asks for usage, so this stub is never called; it exists to satisfy
  // the layer rather than to stand in for a keychain or a network read.
  const unusedProcessRunner = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: () => Effect.die("ProcessRunner must not be reached by an identity-only listing"),
    }),
  );

  const ceroConfig = JSON.stringify({
    oauthAccount: { emailAddress: "claudio.cero@example.com", organizationName: "CH3" },
  });
  const unoConfig = JSON.stringify({
    oauthAccount: { emailAddress: "claudio.uno@example.com", organizationName: "CH3" },
  });
  const emails = (profiles: ReadonlyArray<{ readonly displayPath: string }>) =>
    profiles.map((profile) => profile.displayPath);

  // The M2 decision: sign-out spares the shared legacy Keychain credential
  // only when another directory is signed into the SAME account + org.
  it.effect("sees a sibling directory signed into the same account and organization", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Default home and a second directory, both signed into the same
        // account/org — the borrow topology where the legacy credential is
        // shared.
        yield* fs.writeFileString(path.join(fakeHome, ".claude.json"), personalConfig);
        const sibling = path.join(fakeHome, ".claude-personal-2");
        yield* fs.makeDirectory(sibling, { recursive: true });
        yield* fs.writeFileString(path.join(sibling, ".claude.json"), personalConfig);
        // A work org on the same EMAIL must not count — different organization.
        const work = path.join(fakeHome, ".claude-work");
        yield* fs.makeDirectory(work, { recursive: true });
        yield* fs.writeFileString(path.join(work, ".claude.json"), workConfig);

        const shared = yield* anotherProfileSharesClaudeIdentity({
          excludeHomePath: path.join(fakeHome, ".claude"),
          identity: readClaudeAccountIdentity(personalConfig),
        });

        expect(shared).toBe(true);
      }),
    ),
  );

  it.effect("does not treat a different organization on the same email as a sibling", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Only the default holds the personal identity, and it is excluded; the
        // work directory shares the email but not the org, so nothing borrows
        // the personal account's credential — sign-out may delete it.
        yield* fs.writeFileString(path.join(fakeHome, ".claude.json"), personalConfig);
        const work = path.join(fakeHome, ".claude-work");
        yield* fs.makeDirectory(work, { recursive: true });
        yield* fs.writeFileString(path.join(work, ".claude.json"), workConfig);

        const shared = yield* anotherProfileSharesClaudeIdentity({
          excludeHomePath: path.join(fakeHome, ".claude"),
          identity: readClaudeAccountIdentity(personalConfig),
        });

        expect(shared).toBe(false);
      }),
    ),
  );
});

describe("who a Claude sign-in was started for", () => {
  it("holds a re-authentication to the account already in the folder", () => {
    // The strongest signal there is: this directory is Claudio Tres's because
    // Claudio Tres is signed into it. The roster is not consulted, so a folder
    // someone deliberately signed an off-roster account into keeps ITS person
    // rather than being dragged back to the roster's.
    expect(
      claudeSignInExpectedEmail({
        currentEmail: "someone.else@example.com",
        displayPath: "~/.claude-3",
      }),
    ).toBe("someone.else@example.com");
  });

  it("expects nobody in particular in a folder the user named themselves", () => {
    // "Add account" into a path of one's own. There is no expectation to hold
    // that sign-in to, and inventing one would reject a legitimate account.
    expect(claudeSignInExpectedEmail({ displayPath: "~/.claude-mine" })).toBeUndefined();
  });
});

describe("verdict on a completed Claude sign-in", () => {
  it("accepts the account it was started for, whatever the casing", () => {
    expect(
      classifyClaudeSignInIdentity({
        expectedEmail: "claudio.cuatro@example.com",
        actualEmail: "Claudio.Cuatro@example.com",
      }),
    ).toEqual({ _tag: "Match" });
  });

  it("names both addresses when the wrong person comes back", () => {
    // Exactly the incident: the sign-in was started for ~/.claude-2's account
    // and completed as ~/.claude-3's, because the OAuth window still held the
    // previous sign-in's cookie.
    expect(
      classifyClaudeSignInIdentity({
        expectedEmail: "claudio.dos@example.com",
        actualEmail: "claudio.cuatro@example.com",
      }),
    ).toEqual({
      _tag: "Mismatch",
      expected: "claudio.dos@example.com",
      actual: "claudio.cuatro@example.com",
    });
  });

  it("refuses to call an unreadable result a match", () => {
    // A config that will not parse is not evidence the right person signed in.
    // Reporting it as a match is how a guard quietly stops guarding.
    expect(classifyClaudeSignInIdentity({ expectedEmail: "a@b.com" })).toEqual({
      _tag: "Unverifiable",
      reason: "no-identity",
    });
    expect(classifyClaudeSignInIdentity({ actualEmail: "a@b.com" })).toEqual({
      _tag: "Unverifiable",
      reason: "no-expectation",
    });
  });
});

/**
 * A process runner that answers every `security` invocation without going near
 * the real Keychain, and records what was attempted. The guard's remediation
 * deletes credentials, so a test that used the real runner would be deleting
 * the developer's.
 */
const recordingProcessRunner = () => {
  const attempted: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const layer = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) => {
        attempted.push({ command: input.command, args: [...(input.args ?? [])] });
        return Effect.succeed<ProcessRunner.ProcessRunOutput>({
          stdout: "",
          stderr: "",
          code: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    }),
  );
  return { attempted, layer };
};

const signedInAs = (email: string) =>
  JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: "CH3" } });

const isClaudeAccountError = Schema.is(ClaudeAccountError);

const withFakeHome = <A, E, R>(body: (fakeHome: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fakeHome = yield* fs.makeTempDirectoryScoped();
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    return yield* body(fakeHome).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (realHome === undefined) delete process.env.HOME;
          else process.env.HOME = realHome;
        }),
      ),
    );
  }).pipe(Effect.scoped);

/** A sign-in that has already succeeded, against a folder holding `landed`. */
const settledLoginInto = (input: {
  readonly homePath: string;
  readonly landed: string;
  readonly expectedEmail?: string;
  readonly previousEmail?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(input.homePath, { recursive: true });
    yield* fs.writeFileString(path.join(input.homePath, ".claude.json"), signedInAs(input.landed));
    return {
      homePath: input.homePath,
      controls: { claudeOAuthWaitForCompletion: () => Promise.resolve({}) },
      abort: new AbortController(),
      // False on purpose: the folder pre-existed, so the assertions can read
      // it back rather than watching the cleanup delete the evidence.
      createdDirectory: false,
      ...(input.expectedEmail ? { expectedEmail: input.expectedEmail } : {}),
      ...(input.previousEmail ? { previousEmail: input.previousEmail } : {}),
    };
  });

it.layer(NodeServices.layer)("a completed Claude sign-in that is the wrong account", (it) => {
  it.effect("fails loudly, naming both addresses, instead of reporting success", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { attempted, layer } = recordingProcessRunner();
        // The incident, reproduced: the sign-in was started for ~/.claude-2's
        // account and the OAuth window completed it as ~/.claude-3's.
        const pending = yield* settledLoginInto({
          homePath: path.join(fakeHome, ".claude-2"),
          landed: "claudio.cuatro@example.com",
          expectedEmail: "claudio.dos@example.com",
        });

        const raised = yield* Effect.flip(awaitClaudeAccountLogin(pending)).pipe(
          Effect.provide(layer),
        );
        const error = isClaudeAccountError(raised) ? raised : undefined;

        expect(error?.reason).toBe("failed");
        // Both addresses, because "the sign-in failed" leaves the user with no
        // idea that a DIFFERENT account is the one they are actually holding.
        expect(error?.detail).toContain("claudio.cuatro@example.com");
        expect(error?.detail).toContain("claudio.dos@example.com");
        // The Keychain credential is the thing that authorizes turns, so
        // leaving it behind would leave the wrong account usable.
        expect(
          attempted.some(
            (call) => call.command === "security" && call.args.includes("delete-generic-password"),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("leaves no wrong-account credential in the folder", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { layer } = recordingProcessRunner();
        const homePath = path.join(fakeHome, ".claude-2");
        const pending = yield* settledLoginInto({
          homePath,
          landed: "claudio.cuatro@example.com",
          expectedEmail: "claudio.dos@example.com",
        });

        yield* Effect.ignore(awaitClaudeAccountLogin(pending)).pipe(Effect.provide(layer));

        // Principle 4, made checkable: the directory must not be readable as
        // the wrong person's account afterwards.
        const after = readClaudeAccountIdentity(
          yield* fs.readFileString(path.join(homePath, ".claude.json")),
        );
        expect(after.email).toBeUndefined();
      }),
    ),
  );

  it.effect("lets the account it was started for through untouched", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attempted, layer } = recordingProcessRunner();
        const homePath = path.join(fakeHome, ".claude-2");
        const pending = yield* settledLoginInto({
          homePath,
          landed: "claudio.dos@example.com",
          expectedEmail: "claudio.dos@example.com",
        });

        yield* awaitClaudeAccountLogin(pending).pipe(Effect.provide(layer));

        const after = readClaudeAccountIdentity(
          yield* fs.readFileString(path.join(homePath, ".claude.json")),
        );
        expect(after.email).toBe("claudio.dos@example.com");
        // Nothing was cleaned up, and the folder still gets its onboarding
        // stamp — a guard that broke the happy path would be worse than none.
        expect(attempted).toEqual([]);
        expect(yield* fs.readFileString(path.join(homePath, ".claude.json"))).toMatch(
          /"hasCompletedOnboarding":\s*true/,
        );
      }),
    ),
  );

  it.effect("does not judge a sign-in it had no expectation for", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attempted, layer } = recordingProcessRunner();
        // "Add account" into a folder of the user's own naming: no roster
        // entry, nothing previously signed in, so no address to hold it to.
        const homePath = path.join(fakeHome, ".claude-mine");
        const pending = yield* settledLoginInto({
          homePath,
          landed: "someone@example.com",
        });

        yield* awaitClaudeAccountLogin(pending).pipe(Effect.provide(layer));

        const after = readClaudeAccountIdentity(
          yield* fs.readFileString(path.join(homePath, ".claude.json")),
        );
        expect(after.email).toBe("someone@example.com");
        expect(attempted).toEqual([]);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("a completed Claude sign-in that duplicates an account", (it) => {
  const planted = (input: { readonly homePath: string; readonly email: string }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(input.homePath, { recursive: true });
      yield* fs.writeFileString(path.join(input.homePath, ".claude.json"), signedInAs(input.email));
    });

  it.effect("refuses to write the same account into a second folder", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attempted, layer } = recordingProcessRunner();
        yield* planted({
          homePath: path.join(fakeHome, ".claude-3"),
          email: "claudio.cuatro@example.com",
        });
        // "Add account": a folder of its own, nobody in it when the attempt
        // started, and the sign-in comes back as the account ~/.claude-3 is
        // already holding. This is the row that appeared three times.
        const homePath = path.join(fakeHome, ".claude-4");
        const pending = yield* settledLoginInto({ homePath, landed: "claudio.cuatro@example.com" });

        const raised = yield* Effect.flip(awaitClaudeAccountLogin(pending)).pipe(
          Effect.provide(layer),
        );
        const error = isClaudeAccountError(raised) ? raised : undefined;

        expect(error?.reason).toBe("failed");
        expect(error?.detail).toContain("claudio.cuatro@example.com");
        // Nothing left behind that the accounts list could read as a second
        // copy of the account.
        const after = readClaudeAccountIdentity(
          yield* fs.readFileString(path.join(homePath, ".claude.json")),
        );
        expect(after.email).toBeUndefined();
        expect(
          attempted.some(
            (call) => call.command === "security" && call.args.includes("delete-generic-password"),
          ),
        ).toBe(true);
        // The folder that already had the account is untouched — the guard
        // removes the copy, never the original.
        const original = readClaudeAccountIdentity(
          yield* fs.readFileString(path.join(fakeHome, ".claude-3", ".claude.json")),
        );
        expect(original.email).toBe("claudio.cuatro@example.com");
      }),
    ),
  );

  it.effect("lets a folder re-authenticate the account it already held", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attempted, layer } = recordingProcessRunner();
        // The state this bug has already left on machines: two folders, one
        // account. Signing either back in has to keep working, or the
        // duplicates it made could never be repaired.
        yield* planted({
          homePath: path.join(fakeHome, ".claude-3"),
          email: "claudio.cuatro@example.com",
        });
        const homePath = path.join(fakeHome, ".claude-2");
        const pending = yield* settledLoginInto({
          homePath,
          landed: "claudio.cuatro@example.com",
          expectedEmail: "claudio.cuatro@example.com",
          previousEmail: "claudio.cuatro@example.com",
        });

        yield* awaitClaudeAccountLogin(pending).pipe(Effect.provide(layer));

        const after = readClaudeAccountIdentity(
          yield* fs.readFileString(path.join(homePath, ".claude.json")),
        );
        expect(after.email).toBe("claudio.cuatro@example.com");
        expect(attempted).toEqual([]);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("signing out a directory whose own identity is unreadable", (it) => {
  it.effect(
    "spares the shared legacy Keychain entry rather than treating unknown as unshared",
    () =>
      withFakeHome((fakeHome) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attempted, layer } = recordingProcessRunner();
          // The default home's config carries no `oauthAccount` — the shape
          // that made `anotherProfileSharesClaudeIdentity` answer `false` for
          // an unrelated reason: it never learned who is signed in here, not
          // because nobody else shares the account.
          yield* fs.writeFileString(path.join(fakeHome, ".claude.json"), "{}");

          yield* signOutClaudeAccount({ homePath: path.join(fakeHome, ".claude") }).pipe(
            Effect.provide(layer),
          );

          // The legacy unsuffixed entry is the shared credential every custom
          // config dir borrows. Deleting it on an unreadable identity would
          // sign every one of those directories out along with this one.
          expect(
            attempted.some(
              (call) =>
                call.command === "security" &&
                call.args.includes("delete-generic-password") &&
                call.args.includes("Claude Code-credentials"),
            ),
          ).toBe(false);
        }),
      ),
  );
});

describe("what a failed sign-in tells the person in front of it", () => {
  it("reports the cause of a rejected promise rather than Effect's placeholder", () => {
    // The string this replaces — "An error occurred in Effect.tryPromise" — was
    // the entire message CH3's CFO got, every time, for weeks.
    const spawnFailure = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    expect(describeRejection(spawnFailure)).toBe("spawn claude ENOENT");

    // A code the message does NOT already carry is worth appending.
    const opaque = Object.assign(new Error("write failed"), { code: "EPIPE" });
    expect(describeRejection(opaque)).toBe("write failed (EPIPE)");
  });

  it("does not repeat a code the message already carries", () => {
    const failure = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    expect(describeRejection(failure)).toBe("connect ECONNREFUSED 127.0.0.1:443");
  });

  it("says something for a rejection that is not an Error", () => {
    expect(describeRejection("the CLI exited")).toBe("the CLI exited");
    expect(describeRejection({})).toBe("no reason given");
    expect(describeRejection(new Error("   "))).toBe("no reason given");
  });
});

it.layer(NodeServices.layer)("a completed Claude sign-in and the credential cache", (it) => {
  it.effect("forgets that the folder had no credential, so the next read asks the keychain", () =>
    withFakeHome((fakeHome) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        clearClaudeUsageCache();
        const { attempted, layer } = recordingProcessRunner();
        const homePath = path.join(fakeHome, ".claude-2");
        const pending = yield* settledLoginInto({
          homePath,
          landed: "claudio.dos@example.com",
          expectedEmail: "claudio.dos@example.com",
        });
        const keychainSpawns = () =>
          attempted.filter((entry) => entry.command === "security").length;

        // Before the sign-in the keychain holds nothing, and that absence is
        // remembered: a second read spawns nothing.
        yield* readClaudeAccountToken(homePath).pipe(Effect.provide(layer));
        const remembered = keychainSpawns();
        expect(remembered).toBeGreaterThan(0);
        yield* readClaudeAccountToken(homePath).pipe(Effect.provide(layer));
        expect(keychainSpawns()).toBe(remembered);

        // The sign-in completes. 0da068b2: without this the row read "sign in
        // again to see usage" for up to five minutes after a successful
        // sign-in, which reads as the sign-in having failed.
        yield* awaitClaudeAccountLogin(pending).pipe(Effect.provide(layer));

        yield* readClaudeAccountToken(homePath).pipe(Effect.provide(layer));
        expect(keychainSpawns()).toBe(remembered * 2);
      }),
    ),
  );
});

describe("what the usage band may say about the account it meters", () => {
  const cero = {
    email: "claudio.cero@example.com",
    organizationName: "CH3",
    displayPath: "~/.claude-0",
  };
  const uno = {
    email: "claudio.uno@example.com",
    organizationName: "CH3",
    displayPath: "~/.claude-1",
  };

  it("names the account it meters", () => {
    expect(
      claudeUsageBandIdentity({
        profile: cero,
        accountEmailKnowable: true,
      }),
    ).toEqual({ accountLabel: "CH3", accountEmail: "claudio.cero@example.com" });
  });

  it("names an account whose organization is known", () => {
    expect(
      claudeUsageBandIdentity({
        profile: uno,
        accountEmailKnowable: true,
      }),
    ).toEqual({ accountLabel: "CH3", accountEmail: "claudio.uno@example.com" });
  });

  it("withholds the address when the caller cannot tell which instance it means", () => {
    expect(
      claudeUsageBandIdentity({
        profile: uno,
        accountEmailKnowable: false,
      }),
    ).toEqual({ accountLabel: "CH3", accountEmail: "" });
  });

  it("falls back to the address when there is no organization name", () => {
    expect(
      claudeUsageBandIdentity({
        profile: { ...uno, organizationName: null },
        accountEmailKnowable: true,
      }),
    ).toEqual({ accountLabel: "claudio.uno@example.com", accountEmail: "claudio.uno@example.com" });
  });

  it("says nothing at all when the probe returned nothing", () => {
    expect(
      claudeUsageBandIdentity({
        profile: undefined,
        accountEmailKnowable: true,
      }),
    ).toEqual({ accountLabel: "", accountEmail: "" });
  });
});
