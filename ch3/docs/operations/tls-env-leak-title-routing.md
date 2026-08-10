# TLS environment leak & title instance routing

**Status:** Fixed (2026-08-08)  
**Root cause:** Two bugs masquerading as one account exhaustion problem.

## The symptoms

1. **Title regeneration failed** with "The text generation model returned nothing usable" (any account, any model)
2. **Chat turns worked fine** — asymmetric behavior pointed to provider spawning
3. **Fallback heuristics failed** — rotation and failover couldn't fix it

## Root cause 1: NODE_OPTIONS leak into spawned providers

**File:** `apps/desktop/src/backend/DesktopBackendConfiguration.ts:410`

CH3's Node backend injects `NODE_OPTIONS=--use-system-ca` to handle corporate TLS interception on its own connections. This env var inherited into every spawned provider CLI (e.g., `claude` binary for text generation).

**Why it broke text generation only:** The Claude SDK (used in main chat) explicitly strips `NODE_OPTIONS` before spawning. CH3's _direct_ spawns (ProviderCommandReactor) did not, carrying the flag into a Bun binary that errors on it: `SSL certificate verification failed`.

**Verified by:**

- Reproduced directly: `claude -p <profile>` succeeds without the flag, fails with it
- Chat agents spawned by Claude SDK worked (flag stripped)
- Text generation spawned by ProviderCommandReactor failed (flag leaked)

**Fixed in:** `apps/server/src/provider/ProviderInstanceEnvironment.ts`

Single funnel for all driver spawns; strips `NODE_OPTIONS=--use-system-ca` only, preserves user's own env vars, explicit per-instance values still win.

## Root cause 2: Titles routed to hardcoded default instance

**File:** `apps/server/src/textGeneration/ClaudeTextGeneration.ts`

`claudeTitleModelSelection()` called `defaultInstanceIdForDriver("claudeAgent")` unconditionally. Each instance owns its account via `homePath`, so titles always used the default slot's account, never the thread's.

**Why it mattered:** The default slot (`.claude` / max_20x tier) was signed out (`Not logged in · Please run /login`). Title generation couldn't authenticate, even though the thread's account had headroom.

**Fixed by:** Route titles through the thread's own instance. Non-Claude threads still use the default, but Claude threads use their own account — idempotent when you have a single instance (today), correct when you add a second.

## Changes

### ProviderInstanceEnvironment.ts

- Added `NEVER_EXPORT_NODE_OPTIONS` list (contains `--use-system-ca`)
- Strips listed flags from child env before driver spawn
- Tests: regression pins for env-stripping behavior

### ClaudeTextGeneration.ts

- `TextGenerationRequest` now carries `instanceId` (optional)
- `claudeTitleModelSelection()` checks `request.instanceId` → thread's instance
- Fallback to `defaultInstanceIdForDriver()` only for non-Claude threads

### TextGenerationUtils.ts

- Thread title generation now receives the thread's instance as context
- First-turn path resolves instance before generating (async)

## Verification

- All 81 + 44 tests green
- Direct CLI test: `claude -p` succeeds with fix, fails without
- Live: title regeneration works, routes through the right account
- No asymmetry: chat and text gen both now succeed

## One-time account fix

If `.claude` (your default slot) is signed out:

1. Re-login: `~/.claude/bw-azure.json` → run `/login` in that profile
2. Or switch via CH3's UI: **Settings → Providers → Claude → Switch account** → select `.claude-work` or similar
3. Rotation (ON by default) will select a working account; if it picks the signed-out default, re-login there

## See also

- `ProviderInstanceEnvironment.ts`: instance + environment construction
- `ClaudeTextGeneration.ts`: text generation routing logic
- `TextGenerationUtils.ts`: title generation pipeline
- `DesktopBackendConfiguration.ts`: CH3 server env setup (where the leak originated)
