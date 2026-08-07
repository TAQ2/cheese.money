# CH3 fork — setup, build, and install on a new machine

This is a fork of CH3 carrying a large body of **uncommitted** work on the
branch `feat/claude-statusline` (the working tree IS the deliverable; nothing
is committed on top of upstream). The `.git` directory is included, so
`git status` / `git diff HEAD` show the full delta (~140 files).

What the fork adds, briefly: a Claude multi-account manager with automatic
failover and smart account rotation; native text-to-speech read-aloud
(no Python, no external engine) with English/Spanish voice routing; an
output-style selector with a redo-in-style action; sidebar
completion-float fixes; and a dedicated Accounts settings tab.

## Prerequisites

- **macOS on Apple Silicon** (the build target below is arm64; use
  `dist:desktop:dmg:x64` for Intel).
- **Node.js 24+** and **pnpm** (`corepack enable` is enough).
- **Claude Code CLI** installed and signed in (`claude`, then `/login`) —
  required for the Claude provider. Extra accounts live in `~/.claude-<name>`
  directories, created from the app's Accounts tab ("Add account…").
- **No Python needed.** Speech synthesis is native; it only needs network
  access to `speech.platform.bing.com` (proxy settings are honored, including
  the macOS system certificate store under TLS interception).

## Install dependencies

```bash
pnpm install
```

## Typecheck — the trap to know

`npx vp run -r typecheck` does NOT cover the apps. Check each one directly,
and never run two `tsgo` processes at once:

```bash
(cd apps/server  && npx tsgo --noEmit)
(cd apps/web     && npx tsgo --noEmit)
(cd apps/desktop && npx tsgo --noEmit)
(cd packages/contracts && npx tsgo --noEmit)
```

## Tests

```bash
npx vp test <path>            # e.g. npx vp test apps/server/src/speech
```

Known pre-existing failures unrelated to this fork's work — do not chase:
`apps/web/src/promptStashStore.test.ts` (8) and
`apps/server/src/server.test.ts` (14, auth/pairing).
`ClaudeAccountFailoverReactor.test.ts` reads the developer's real
`~/.claude*` state and calls the live usage endpoint — run it knowingly.

## Build the app

```bash
pnpm build
```

New TanStack Router route files need one `(cd apps/web && npx vp build)`
before they typecheck (the route tree is generated).

## Signing, then the dmg

Two options:

**A. Unsigned (simplest).** Just build; recipients clear quarantine on
install (step below covers it):

```bash
pnpm dist:desktop:dmg:arm64
```

**B. Local signing identity.** Create a self-signed code-signing certificate
in Keychain Access (Certificate Assistant → Create a Certificate → name:
`CH3 Local Signing`, type: Code Signing), then:

```bash
CH3CODE_DESKTOP_LOCAL_SIGN_IDENTITY="CH3 Local Signing" pnpm dist:desktop:dmg:arm64
```

Either way the result is NOT notarized: Gatekeeper on other machines will
refuse it ("damaged") until quarantine is cleared. If the env var is set but
the identity does not exist in the Keychain, the build fails hard — unset it
to fall back to unsigned.

The dmg lands in `release/CH3-Code-<version>-arm64.dmg`.

## Install / update on any machine

```bash
hdiutil attach -nobrowse ~/Downloads/CH3-Code-0.0.31-arm64.dmg && \
rm -rf "/Applications/CH3 (Alpha).app" && \
ditto "/Volumes/CH3 (Alpha) 0.0.31-arm64/CH3 (Alpha).app" "/Applications/CH3 (Alpha).app" && \
hdiutil detach "/Volumes/CH3 (Alpha) 0.0.31-arm64" && \
xattr -dr com.apple.quarantine "/Applications/CH3 (Alpha).app" && \
open -a "/Applications/CH3 (Alpha).app"
```

The `xattr` line is mandatory for a downloaded, non-notarized build. The
`rm -rf` makes the same chain work for updates. There is no auto-update
feed — every update is a new dmg installed the same way.

## Engineering notes that will save you a day

- **Adding an RPC method:** add ONE, typecheck immediately. This repo's
  Effect RPC union sits near a TypeScript inference ceiling; a second new
  method at once has produced 166 cascading, unrelated-looking errors.
- **Adding a field to a schema with many test fixtures:** prefer
  `Schema.optionalKey` over `withDecodingDefault` — the latter broke 94
  fixtures once.
- **Effect version:** effect v4 beta. The regex check is `Schema.isPattern`;
  `Date.now()`/`new Date()` are linted against — thread a clock through.
- **Speech constants:** the Microsoft service token scheme
  (`apps/server/src/speech/EdgeTtsClient.ts`) is pinned to values Microsoft
  rotates occasionally; if synthesis suddenly 403s everywhere, update
  `TRUSTED_CLIENT_TOKEN`/`CHROMIUM_FULL_VERSION` from the `edge-tts`
  project's current source.
- **Account rotation/failover logic:** pure and tested in
  `apps/server/src/provider/Drivers/claudeAccountRotation.ts` and
  `claudeAccountFailover.ts`; the loops live in
  `apps/server/src/provider/Layers/ClaudeAccountFailoverReactor.ts`.
  Rotation is ON by default (opt-out checkbox in Settings → Accounts).
