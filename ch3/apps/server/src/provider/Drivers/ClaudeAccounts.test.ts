import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  anotherProfileSharesClaudeIdentity,
  discoverClaudeProfilePaths,
  readClaudeAccountIdentity,
} from "./ClaudeAccounts.ts";

// Both payloads are the real shapes on this machine, trimmed to the keys that
// matter. The personal account writes JSON null for `userRateLimitTier`; the
// work account writes a string there and an unrecognized organization tier.
const personalConfig = JSON.stringify({
  userID: "b006173511afbc90",
  oauthAccount: {
    accountUuid: "2f7c3261-0604-4657-8a09-1725e337fc45",
    emailAddress: "conrad@baubap.com",
    organizationName: "conrad@baubap.com's Organization",
    organizationRateLimitTier: "default_claude_max_20x",
    userRateLimitTier: null,
    billingType: "stripe_subscription",
  },
});

const workConfig = JSON.stringify({
  oauthAccount: {
    emailAddress: "conrad@baubap.com",
    organizationName: "Baubap",
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
      email: "conrad@baubap.com",
      organizationName: "conrad@baubap.com's Organization",
      subscriptionLabel: "Claude Max Subscription",
    });
  });

  it("falls back to the user tier when the organization tier is unrecognized", () => {
    // A work organization records the plan on the user tier and leaves the
    // organization tier as something meaningless (`default_raven`).
    expect(readClaudeAccountIdentity(workConfig)).toEqual({
      email: "conrad@baubap.com",
      organizationName: "Baubap",
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
        expect(found).toEqual([path.join(fakeHome, ".claude")]);
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
