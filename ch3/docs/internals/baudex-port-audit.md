# What the BauDex port left behind

CH3 was ported from a further-along fork of the same tree. Every gate that ran during
that port — typecheck, 6,800 tests, a blind QA pass — reads the diff that exists, and an
absent feature leaves no line in a diff. Three features were found missing only because
somebody asked about them by name: the Maple model catalogue, the Maple pricing colours,
and `spawn_model_agent`. This file exists so the next one is found by running a command.

Regenerate the raw lists with `node scripts/port-audit.ts` (add `--json` for machine
output). It compares against refs kept in this repository — `refs/port/base` (`23102fa`,
the common ancestor), `refs/port/baudex` (`fe4e12d`, the other fork) and
`refs/port/ch3-pre` (`e573b5d`, this fork before the port). They were fetched out of a
scratch clone in `/tmp` that would not have survived a reboot.

**Every line the script prints must appear below with a verdict.** A line that does not
is an unanswered question, not an omission.

## What this can and cannot see

Two axes, both mechanical:

- **Files** the other fork tracks that do not exist here.
- **Exported names**, for files both forks carry, that the other fork exports and this
  one does not. That is what catches a file taken in part — a component deleted from a
  module that was otherwise ported, which is exactly how the `spawn_model_agent` card
  went missing while the tool it renders was never brought over either.

Neither axis sees a behaviour deleted from inside a function whose name still exists.
That gap is real and nothing here closes it; what these guarantee is that no whole file
and no exported surface disappears unnoticed.

## Verdicts, as of 2026-09-13

| Verdict   | Files | Meaning                                                     |
| --------- | ----- | ----------------------------------------------------------- |
| Cockpit   | 48    | The orchestrator cockpit, deliberately unported             |
| Corporate | 119   | Belongs to the other fork's employer, deliberately stripped |
| Rejected  | 28    | Judged not worth having here, with a reason                 |
| Open      | 31    | No decision yet — the queue below                           |

The 31 open files are four features, not thirty-one decisions. Seventeen files moved
from Open to Corporate on 2026-09-13 after their module docs were read rather than their
paths pattern-matched — see "Read, then reclassified" below.

## Open questions

These are the only rows that could still turn into "you never ported X". Each is a
feature, with what it does and what it would cost.

### Maple runtime beyond the catalogue (24 files)

- `apps/server/src/provider/maple/MapleActivation.test.ts`
- `apps/server/src/provider/maple/MapleActivation.ts`
- `apps/server/src/provider/maple/MapleKeyVault.test.ts`
- `apps/server/src/provider/maple/MapleKeyVault.ts`
- `apps/server/src/provider/maple/MapleProxySupervisor.test.ts`
- `apps/server/src/provider/maple/MapleProxySupervisor.ts`
- `apps/server/src/provider/maple/README.md`
- `apps/server/src/provider/maple/mapleProxyState.ts`
- `apps/server/src/provider/maple/mapleUpstreamRejection.test.ts`
- `apps/server/src/provider/maple/mapleUpstreamRejection.ts`
- `apps/web/src/components/auth/MapleVaultUnlock.tsx`
- `apps/web/src/components/settings/MapleProviderStatus.logic.test.ts`
- `apps/web/src/components/settings/MapleProviderStatus.logic.ts`
- `apps/web/src/components/settings/MapleProviderStatus.tsx`
- `apps/web/src/state/maple.ts`
- `native/maple-proxy/Cargo.lock`
- `native/maple-proxy/Cargo.toml`
- `native/maple-proxy/src/main.rs`
- `packages/client-runtime/src/state/maple.ts`
- `packages/contracts/src/maple.ts`
- `packages/shared/src/mapleAccountFailover.test.ts`
- `packages/shared/src/mapleAccountFailover.ts`
- `packages/shared/src/mapleKeyVault.test.ts`
- `packages/shared/src/mapleKeyVault.ts`

### CI workflow split (5 files)

- `.github/workflows/build-dmg.yml`
- `.github/workflows/ci-coverage.yml`
- `.github/workflows/ci-e2e-tests.yml`
- `.github/workflows/ci-pre-commit-checks.yml`
- `.github/workflows/ci-test.yml`

### OpenCode user guide and driver test (2 files)

- `apps/server/src/provider/Drivers/OpenCodeDriver.test.ts`
- `docs/user/providers-opencode.md`

### Recommendations

**Maple runtime.** `MapleKeyVault`, `mapleKeyVault` and `MapleVaultUnlock` are the sealed
1Password vault and stay out — a plain setting replaces them, and this machine already
supplies `MAPLE_API_KEY` from the environment. The rest is not corporate:
`MapleActivation` reports the three independent things that must be true before a Maple
request can work, `mapleUpstreamRejection` classifies an exhausted account out of an
upstream error, `MapleProxySupervisor` starts and watches the proxy, and
`MapleProviderStatus` is the panel that shows all of it. That panel's health check reads
the body of `/health` rather than its status code, which is the precise failure that
took an hour on 2026-09-13: a Docker container answering `200 {"service":"whapi-mock"}`
on port 8080 was indistinguishable from the real proxy to CH3, to `start-proxy.sh
--status`, and to me. **Recommend porting the activation, rejection and status surface,
minus the vault row.** `mapleAccountFailover` assumes two Maple subscriptions and is a
separate decision. `native/maple-proxy` is a 3-file MIT wrapper crate; the built binary
already lives at `~/Desktop/maple-stack/bin/maple-proxy`, so bringing the crate only
matters if the DMG should ship its own.

**CI workflow split.** Five workflows that split what `ci.yml` does here into
pre-commit checks, tests, coverage, e2e and a DMG build. `vite.config.ts` and
`docs/internals/scripts.md` in this fork referred to `ci-pre-commit-checks.yml` until
`6abd304` corrected them, which is the tell that the split was half-inherited.
**Low priority; matters only when CI runs on this repo.**

**OpenCode user guide.** `docs/user/providers-opencode.md` is linked from `README.md`
and does not exist here — one of the dangling links the QA pass reported.
**Recommend porting it, de-corporatised.** `OpenCodeDriver.test.ts` covers the account
failover wiring, so it follows the Maple failover decision.

## Read, then reclassified (17 files)

Both of these were in the open queue until their module docs were read. Recording the
reason matters more than the verdict: "it mentions Baubap" is the same heuristic that
deleted the Maple catalogue, and the correction has to come from reading the code.

**The skills catalogue** (5 files) is not a skills browser. Its own first line is
"The Baubap skills catalogue": it reads `baubap-skills/skills/<name>/SKILL.md` out of a
project registered as the Baubap Skills default project, and installs from there into
`~/.claude/skills`. Without that repository and that default project it has nothing to
list. **Corporate.**

- `apps/server/src/skills/SkillCatalog.test.ts`
- `apps/server/src/skills/SkillCatalog.ts`
- `apps/web/src/state/skills.ts`
- `packages/client-runtime/src/state/skills.ts`
- `packages/contracts/src/skills.ts`

**The MCP shelf** (12 files) is "the sixth Baubap superpower" in its own words — every MCP
server the company runs, with a dot per server saying whether this machine has it and
whether it answers. The catalogue is the feature; without the company's server list there
is no shelf. **Corporate.**

Its three parsers are genuinely generic and stay out anyway, for a different reason:
`mcpLoginOutput` pulls the authorization URL out of `claude mcp login --no-browser`
(which prints it wrapped in an OSC 8 escape, often split across a line break),
`mcpListOutput` reads `claude mcp list`, and `ClaudeMcpConfigChange` applies a config
edit. Nothing in this fork calls any of them, and code with no caller is the entropy this
repository's rules forbid. If CH3 ever grows its own MCP settings surface, take them then
— they are the awkward part of that work, already solved.

- `apps/server/src/mcp/ClaudeMcpConfigChange.test.ts`
- `apps/server/src/mcp/ClaudeMcpConfigChange.ts`
- `apps/server/src/mcp/mcpListOutput.test.ts`
- `apps/server/src/mcp/mcpListOutput.ts`
- `apps/server/src/mcp/mcpLoginOutput.test.ts`
- `apps/server/src/mcp/mcpLoginOutput.ts`
- `apps/web/src/components/mcp/McpCatalog.test.tsx`
- `apps/web/src/components/mcp/McpCatalog.tsx`
- `apps/web/src/routes/_chat.mcp.tsx`
- `apps/web/src/state/mcpCatalog.ts`
- `packages/client-runtime/src/state/mcpCatalog.ts`
- `packages/contracts/src/mcpCatalog.ts`

## Long-diff files: read line-for-line (40 files)

A third axis, orthogonal to the script's file/symbol comparison: every `.ts`/`.tsx` path
both forks carry where `refs/port/baudex`'s copy runs 40+ lines longer than this fork's
(`node_modules`, `_generated` and `dist` excluded). A big diff between two files that both
exist can hide a feature no absent-file or absent-symbol check would ever see — the same
gap the "What this can and cannot see" section admits by name. All 40 read below, each
against its own diff; every one turned out to be more lines of an already-decided feature
(Cockpit/Corporate/Rejected/Open-Maple) or of a legacy-model roster this fork dropped, not
a new undecided feature.

- `apps/web/src/components/settings/ClaudeAccountSwitcher.logic.test.ts` (baudex 1207 / here 818, +389): tests for `fablePoolRowLock`'s percentage message and the "signed in as X in Y's slot" roster-squatter label — Corporate (hard-coded roster + Fable pool).
- `apps/server/src/ws.ts` (3804 / 3427, +377): `unlockSealedContent` (the 1Password-backed GitHub-token and Maple-key vault unlock) plus the Corporate/Cockpit service wiring — `BaubapMcpCatalog`, `SkillCatalog`, `OrchestratorManager`, `BaubapRepositoryDiscovery`, `MeteredModelUse`, GitHub identity/contribution, `WorkspaceIdentity`.
- `packages/contracts/src/rpc.ts` (1451 / 1130, +321): the RPC method map and schemas for the orchestrator (Cockpit), workspace/MCP/skills/repository-discovery/metered-model-use RPCs (Corporate) and `mapleUnlock` (Open) — all already listed in "Exported names absent" above.
- `apps/web/src/components/ChatView.tsx` (8134 / 7874, +260): wires `MeteredModelDialog`, the metering account, and `requiredModelToOpenOn`/`requiredModelToConfirmBeforeSend` (RedSight's Opus requirement) into the main send path — Corporate model-access tiers + default projects.
- `apps/web/src/modelSelection.test.ts` (714 / 478, +236): tests for `TIER_POLICIES`/`applyModelAccessPolicy` narrowing the provider snapshot to the standard tier's model set — Corporate.
- `apps/web/src/components/settings/ClaudeAccountSwitcher.logic.ts` (745 / 562, +183): `fablePoolRowLock`, the roster-email display fallback, and the roster-vs-discovered account ordering rule — Corporate.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` (3454 / 3273, +181): tests for orchestrator-thread auto-titling off a Business Problem run's own text, and for restarting a Claude session after `ClaudeMcpConfigChange` — Cockpit + Corporate MCP config-change.
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (5501 / 5324, +177): tests mapping withdrawn/legacy effort levels (Opus 4.6/4.7's `max`→`high`/`xhigh`, Haiku 4.5 ignoring effort) onto the CLI's `--effort` flag — same legacy-model family as `ClaudeProvider.ts` below.
- `apps/server/src/provider/Layers/OpenCodeProvider.test.ts` (776 / 609, +167): tests asserting the OpenCode driver renames itself "Maple," restricts its model list to the connected `maple` upstream, and refuses to relabel another OpenCode-Zen vendor's free models (Big Pickle, Hy3 Free) as Maple's — behavior the current driver (still branded "OpenCode", lists every connected provider) does not implement; not on the open Maple-runtime list because the current driver already carries the Maple catalogue and pricing sort ported this session.
- `apps/desktop/src/window/claudeSignInFlow.test.ts` (275 / 109, +166): tests for the automated sign-in handoff/close-delay state machine below — Rejected.
- `apps/server/src/provider/Drivers/ClaudeAccounts.test.ts` (941 / 776, +165): tests for `CLAUDE_ACCOUNT_ROSTER` discovery and the hide-outside-Mexico rule, keyed to `claudio.*@baubap.com` — Corporate.
- `apps/desktop/src/window/claudeSignInFlow.ts` (310 / 155, +155): the hidden-then-shown window state machine (`CLAUDE_AUTO_SIGN_IN_HANDOFF_MS`, `CLAUDE_OAUTH_AUTOMATED_CLOSE_DELAY_MS`) that drives an automated Claude sign-in to completion — Rejected (automated Claude sign-in).
- `apps/server/src/provider/Layers/ClaudeProvider.ts` (1035 / 882, +153) [previously read]: four legacy model definitions (Opus 4.5–4.8, Sonnet 4.6, Haiku 4.5) and the withdrawn `max`/`ultracode`/`ultrathink` effort levels those older models still need — none of which the current five-model roster (Fable, Opus 5, Sonnet 5) requires.
- `apps/server/src/server.test.ts` (7951 / 7800, +151): test-layer wiring for the same Corporate/Cockpit/Open-Maple services as `server.ts` below (a disabled `MapleProxySupervisor` stub, `OrchestratorManager`, GitHub identity/contribution, `ManagedClones`, `WorkspaceIdentity`, `ClaudeMcpConfigChange`).
- `apps/web/src/components/chat/ProviderModelPicker.tsx` (354 / 218, +136) [previously read]: the `MeteredModelDialog` confirmation flow (`isMeteredModelChoice`, `tierPolicy`, `meteredFallbackModelSlugs`) gating Premium models behind a use-case confirmation — Corporate model-access tiers/metering.
- `apps/web/src/components/settings/ClaudeAccountSwitcher.tsx` (1212 / 1084, +128): wires the roster email fallback, the automated-sign-in mailbox status/hint, and the Fable-pool row lock into the account list UI — Rejected + Corporate.
- `apps/web/src/composerDraftStore.ts` (3785 / 3676, +109): adds `modelSelectionSeeded` plus `requiredModelToOpenOn`/tier-default wiring so a draft's seeded model can be outranked by a project's requirement or a person's own pick — Corporate (model-access tiers + default projects).
- `apps/desktop/src/updates/DesktopUpdates.test.ts` (709 / 610, +99): tests for the `CH3Installer`-driven update flow — offering every release regardless of channel, tailing `install.sh`'s log — Rejected, private release channel.
- `apps/server/src/server.ts` (798 / 704, +94): boots the orchestrator (Cockpit), the Maple key vault/proxy supervisor (Open), and the Corporate layer group — metering, GitHub identity/contribution, managed clones, default-project seeding, MCP config-change.
- `apps/server/src/provider/Drivers/ClaudeAccounts.ts` (1274 / 1187, +87): `CLAUDE_ACCOUNT_ROSTER` enumeration, `isHiddenClaudeAccount`'s hide-outside-Mexico rule, and roster-email resolution for account rows — Corporate.
- `scripts/build-desktop-artifact.ts` (2418 / 2337, +81): `IncompletePackagedBuildConfigError` (already noted as deleted on purpose), signed-macOS-build config (`CH3_APPLE_TEAM_ID`, provisioning profile, Clerk passkey domain), and a `maple-proxy` binary staging entry.
- `apps/web/src/state/projects.ts` (102 / 28, +74): `projectDiscoverBaubapRepositories`, `workspaceDefaultProjects`, `workspaceDefaultProjectsRefresh` RPC atoms — Corporate (private repository discovery + seeded default projects).
- `apps/web/src/components/CommandPalette.tsx` (2467 / 2397, +70): adds a "Discover Baubap projects" command (`DiscoverProjectsDialog`, `RepositoryMonogram`) and a "Baubap MCPs" command opening the MCP shelf — Corporate.
- `scripts/lib/public-config.ts` (241 / 173, +68): defines `PACKAGED_BUILD_INPUTS`/`describePackagedBuildConfig` plus Clerk/relay/mobile-OTLP env plumbing — the packaged-build secrets gate already Rejected as deleted on purpose.
- `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts` (483 / 416, +67): tests for Haiku's `thinking` toggle and for withdrawn effort levels (Max/Ultracode/Ultrathink) degrading to the model default — same legacy-model support as `ClaudeProvider.ts`.
- `apps/web/src/routes/_chat.draft.$draftId.tsx` (154 / 88, +66): routes a draft to `OrchestratorThreadView` (Cockpit), `SkillsCatalog`, or `ProjectLauncher` (Corporate default projects) ahead of the plain composer.
- `apps/desktop/src/window/DesktopWindow.test.ts` (1284 / 1223, +61): tests for the hidden/visible sign-in window choice driven by the roster + automated-sign-in hint — Rejected/Corporate.
- `apps/desktop/src/updates/updateMachine.test.ts` (218 / 164, +54): tests for the desktop auto-updater's `install.sh`-driven error/retry states — Rejected, private release channel.
- `packages/contracts/src/project.ts` (352 / 299, +53): `BaubapRepositoryCandidate`/`ProjectDiscoverBaubapRepositories*` schemas for the private-repository discovery dialog — Corporate.
- `apps/desktop/src/window/claudeSignInEmailHint.test.ts` (132 / 80, +52): tests for the roster-only automated sign-in email hint, including the personal `conrad@baubap.com` carve-out — Rejected/Corporate.
- `apps/server/src/cli/config.ts` (537 / 486, +51): adds Google Workspace client config/env scrubbing (Corporate), a `maple-proxy` bootstrap pass-through (Open), and generic CH3 OTLP tracing/log-level config knobs (not corporate, but arrives in the same diff).
- `packages/contracts/src/claudeAccounts.ts` (423 / 373, +50): `ClaudeSignInEmailHintPayload`/`ClaudeSignInHandoff`/`ClaudeSignInMailboxStatus` schemas for automated Claude sign-in — Rejected.
- `e2e/sidebar.spec.ts` (124 / 74, +50): e2e coverage for the default-project rail's "Plain Claude" rename and the "Baubap superpowers" furl toggle plus the MCP shelf door — Corporate.
- `apps/web/src/components/chat/ChatComposer.tsx` (4103 / 4054, +49): metering account, model-access tier, and `requiredModelToOpenOn` (RedSight) wiring into the composer's model chip — Corporate.
- `apps/server/src/auth/RpcAuthorization.ts` (194 / 145, +49): RPC scope entries for the same already-decided Cockpit (orchestrator\*), Corporate (default projects, MCP catalog, skills, `workspaceGithubIdentity`, metered model use) and Open (`mapleUnlock`) methods.
- `apps/server/src/provider/opencodeRuntime.test.ts` (902 / 856, +46): tests that `MapleKeyVault`'s key reaches every OpenCode spawn's environment as `MAPLE_API_KEY` — the sealed-vault wiring the Maple recommendation above says stays out.
- `apps/desktop/src/ipc/methods/claudeSignIn.ts` (76 / 32, +44): the whole file is `claudeSignInMailboxStatus`, the IPC handler reporting the sealed Gmail mailbox's read status for automated Claude sign-in — Rejected.
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts` (821 / 778, +43): a Google Workspace OAuth client bootstrap (Corporate) and a staged `maple-proxy` native binary path (Open, Maple runtime).
- `scripts/lib/public-config.test.ts` (196 / 154, +42): tests for `PACKAGED_BUILD_INPUTS`/`describePackagedBuildConfig` (Rejected, deleted on purpose) plus Clerk/relay/OTLP env var coverage.
- `apps/web/src/components/kanban/KanbanNewThreadDialog.tsx` (365 / 324, +41): wires the model-access tier and default-project-kind gate into the kanban new-thread model picker, seeding RedSight-style required models — Corporate.

## Cockpit — deliberately unported (48 files)

The orchestrator cockpit, roughly 11,000 lines: run panes, lead-agent RPCs, script
discovery pointed at a directory this machine does not have, and forms that read the
removed tier policy. `codingRunDraftStore` is the draft store for its New coding run
form, and `docs/internals/bizorch-mcp-preflight.md` documents its preflight.

- `apps/server/src/orchestrator/Manager.test.ts`
- `apps/server/src/orchestrator/Manager.ts`
- `apps/server/src/orchestrator/README.md`
- `apps/server/src/orchestrator/RunLeaseDaemon.test.ts`
- `apps/server/src/orchestrator/RunLeaseDaemon.ts`
- `apps/server/src/orchestrator/leadAgent.test.ts`
- `apps/server/src/orchestrator/leadAgent.ts`
- `apps/server/src/orchestrator/transcript.test.ts`
- `apps/server/src/orchestrator/transcript.ts`
- `apps/server/src/orchestrator/watchDirectory.test.ts`
- `apps/server/src/orchestrator/watchDirectory.ts`
- `apps/web/src/codingRunDraftStore.test.ts`
- `apps/web/src/codingRunDraftStore.ts`
- `apps/web/src/components/orchestrator/CodingRunForm.tsx`
- `apps/web/src/components/orchestrator/LeadAgentAction.tsx`
- `apps/web/src/components/orchestrator/OrchestratorCheckpointPanel.tsx`
- `apps/web/src/components/orchestrator/OrchestratorConversation.tsx`
- `apps/web/src/components/orchestrator/OrchestratorMark.tsx`
- `apps/web/src/components/orchestrator/OrchestratorProblemForm.test.ts`
- `apps/web/src/components/orchestrator/OrchestratorProblemForm.tsx`
- `apps/web/src/components/orchestrator/OrchestratorRunSession.tsx`
- `apps/web/src/components/orchestrator/OrchestratorStageRail.tsx`
- `apps/web/src/components/orchestrator/OrchestratorThreadView.tsx`
- `apps/web/src/components/orchestrator/__fixtures__/run.happy-path.jsonl`
- `apps/web/src/components/orchestrator/__fixtures__/run.short-circuit.jsonl`
- `apps/web/src/components/orchestrator/codingRunRepositories.test.ts`
- `apps/web/src/components/orchestrator/codingRunRepositories.ts`
- `apps/web/src/components/orchestrator/leadAgentConversation.test.ts`
- `apps/web/src/components/orchestrator/leadAgentConversation.ts`
- `apps/web/src/components/orchestrator/orchestratorResumeFeedback.test.ts`
- `apps/web/src/components/orchestrator/orchestratorResumeFeedback.ts`
- `apps/web/src/components/orchestrator/orchestratorSession.test.ts`
- `apps/web/src/components/orchestrator/orchestratorSession.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadStart.test.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadStart.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadView.logic.test.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadView.logic.ts`
- `apps/web/src/components/orchestrator/useLeadAgentConversation.ts`
- `apps/web/src/components/orchestrator/useOrchestratorProject.ts`
- `apps/web/src/components/orchestrator/useOrchestratorThreadStart.ts`
- `apps/web/src/orchestratorPanesStore.ts`
- `apps/web/src/state/orchestrator.ts`
- `docs/internals/bizorch-mcp-preflight.md`
- `docs/internals/business-orchestrator-integration.md`
- `packages/client-runtime/src/state/orchestrator.ts`
- `packages/contracts/src/orchestrator.ts`
- `packages/shared/src/orchestratorModels.test.ts`
- `packages/shared/src/orchestratorModels.ts`

## Corporate — deliberately stripped (102 files)

The other fork's employer: Google Workspace sign-in with its sealed Gmail credential,
the 1Password sealing scripts and the secrets they unseal, the hard-coded account roster
with its shared Fable pool and hide-outside-Mexico rule, the model-access tiers and the
metering ledger, the seeded "superpower" default projects, private repository discovery
and the monogram table naming ~40 of their repos, the GitHub contribution toolkit that
files issues on their repo, and the user docs for onboarding their team.

These 102 had been sorted by path pattern only. Read on 2026-09-13, against `refs/port/baudex`
directly (none of the 102 exist in this checkout, which is what put them on the file axis in
the first place). Every one confirms corporate in its own words below; none flipped to a
generic core. Grouped by feature, each file with a phrase from its own doc or code.

**Google Workspace sign-in, desktop half (11 files).** `GoogleWorkspaceAuth.ts` states the
gate plainly — "CH3 opens only for a Google account in the Baubap workspace" — and the sealed
mailbox credential it unlocks is scoped to one address, sealed at build time.

- `apps/desktop/scripts/workspace-sign-in-harness.cjs` — "drives the REAL `signInToWorkspace` under a real Electron `app`"
- `apps/desktop/src/auth/DesktopWorkspaceSession.ts` — "the sealed sign-in mailbox credential is bound to the Baubap workspace domain"
- `apps/desktop/src/auth/GmailCredentialStore.test.ts` — `const DOMAIN = "baubap.com"; const MAILBOX = "claudio@baubap.com";`
- `apps/desktop/src/auth/GmailCredentialStore.ts` — "the sealed credential committed to the repository ... opened only after a verified Baubap Workspace sign-in"
- `apps/desktop/src/auth/GmailMailbox.ts` — "there is no parameter anywhere in this module that could name another [mailbox]"
- `apps/desktop/src/auth/GoogleWorkspaceAuth.test.ts` — asserts against `login_hint=juan%40baubap.com`
- `apps/desktop/src/auth/GoogleWorkspaceAuth.ts` — "CH3 opens only for a Google account in the Baubap workspace."
- `apps/desktop/src/auth/README.md` — "One Google OAuth grant for **`claudio@baubap.com`**"
- `apps/desktop/src/auth/sealedGmailCredential.json` — `"mailbox": "claudio@baubap.com", "workspaceDomain": "baubap.com"`
- `apps/desktop/src/ipc/methods/workspaceAuth.test.ts` — mocks `GoogleWorkspaceAuth.ts`'s `signInToWorkspace` directly
- `apps/desktop/src/ipc/methods/workspaceAuth.ts` — "Run the Google workspace sign-in and report what it decided."

**Server-side reporter identity (3 files).** `WorkspaceIdentity.ts`: "Every issue and pull
request CH3 opens is authored on GitHub by the one account the sealed token belongs to ...
something has to carry the reporter."

- `apps/server/src/auth/README.md` — "why authorization here is enforced by the type system"; scopes it defines are generic, but the file documents `RpcAuthorization.ts`, whose own rows are Cockpit/Corporate below
- `apps/server/src/auth/WorkspaceIdentity.test.ts` — "the line these tests defend is `opened by joao@baubap.com`"
- `apps/server/src/auth/WorkspaceIdentity.ts` — "Every issue and pull request CH3 opens is authored on GitHub by the one account the sealed token belongs to"

**GitHub identity and contribution (6 files).** `GithubIdentity.ts`: "CH3 ships a sealed
Baubap credential that can write to five repositories. It exists for one population: a
Baubap employee with a Google account and no GitHub account."

- `apps/server/src/contribution/GithubContributions.test.ts` — "these tests must never create a real issue on `Baubap/ch3`"
- `apps/server/src/contribution/GithubContributions.ts` — "Filing what a Baubap colleague found, on a repository they may have no account for"
- `apps/server/src/github/GithubIdentity.test.ts` — "`/opt/homebrew/bin/gh` genuinely exists on most Baubap machines"
- `apps/server/src/github/GithubIdentity.ts` — "CH3 ships a sealed Baubap credential that can write to five repositories"
- `apps/server/src/github/gitCredentialEnvironment.test.ts` — "carries the sealed credential in the environment, never in an argument" (the sealed Baubap GitHub token)
- `apps/server/src/github/gitCredentialEnvironment.ts` — "`ManagedClones`, which clones and fetches, and `contribution/GithubContributions`, which pushes a branch"

**Baubap MCP catalogue + contribution MCP toolkit (5 files).** `BaubapMcpCatalog.ts`: "An MCP
server is how an agent reaches Metabase, the code graph, Notion, Datadog, Sentry, Linear,
Braze or Google Workspace." `tools.ts`: "The sealed Baubap token can push branches and open
pull requests on five repositories."

- `apps/server/src/mcp/BaubapMcpCatalog.test.ts` — imports `BRAZE_MCP_HOST` from `@ch3tools/shared/baubapMcp`
- `apps/server/src/mcp/BaubapMcpCatalog.ts` — "The Baubap MCP catalogue, and what this machine has of it."
- `apps/server/src/mcp/toolkits/contribution/handlers.test.ts` — "there is no author parameter, so an agent cannot name a reporter even if it tries"
- `apps/server/src/mcp/toolkits/contribution/handlers.ts` — depends on `../../../contribution/GithubContributions.ts`
- `apps/server/src/mcp/toolkits/contribution/tools.ts` — "The sealed Baubap token can push branches and open pull requests on five repositories"

**Metered-model ledger (3 files).** `MeteredModelUse.ts`: "CH3 asks for a reason before it
will run a metered model — Claude Fable 5.1 on the Premium tier, Claude Opus 5 on Standard —
because both draw a multiple ... from one shared, company-wide quota."

- `apps/server/src/persistence/MeteredModelUse.test.ts` — exercises `MeteredModelUse.MeteredModelUseRepository` against the migration below
- `apps/server/src/persistence/MeteredModelUse.ts` — "both draw a multiple of their tier's default model from one shared, company-wide quota"
- `apps/server/src/persistence/Migrations/037_MeteredModelUse.ts` — "This table never leaves the machine ... not attached to any telemetry payload"

**Default-project seeding, repository discovery, managed clones (11 files).**
`DefaultProjects.ts`: "Seeding the five projects every Baubap engineer starts with."
`ManagedClones.ts`: "CH3 used to ship the Baubap repositories as an encrypted payload
inside the dmg."

- `apps/server/src/project/BaubapRepositoryDiscovery.test.ts` — uses `RepositoryIdentity`/`OrchestrationProjectShell` fixtures built for the discovery walk below
- `apps/server/src/project/BaubapRepositoryDiscovery.ts` — imports `isBaubapRepositoryCanonicalKey` and the `BaubapRepositoryCandidate` contract
- `apps/server/src/project/DefaultProjectLocator.ts` — "Finding the engineer's own clone of one of the four default repositories"
- `apps/server/src/project/DefaultProjectSites.test.ts` — "`DefaultProjects` and `ManagedClones` both ask these functions"
- `apps/server/src/project/DefaultProjectSites.ts` — "on the normal Baubap machine it downloaded 146 MB nobody would ever open"
- `apps/server/src/project/DefaultProjects.test.ts` — imports `DEFAULT_PROJECT_DEFINITIONS` from `@ch3tools/shared/defaultProjects`
- `apps/server/src/project/DefaultProjects.ts` — "Seeding the five projects every Baubap engineer starts with"
- `apps/server/src/project/DefaultProjectsSeed.ts` — "a cold machine clones five repositories, and CH3's own history is the slow one"
- `apps/server/src/project/ManagedClones.test.ts` — tests the store this doc's intro calls "private repository discovery"'s clone half
- `apps/server/src/project/ManagedClones.ts` — "CH3 used to ship the Baubap repositories as an encrypted payload inside the dmg"
- `apps/server/src/project/defaultProjectsPresence.test.ts` — `it.layer(...)("a superpower's directory", ...)`

**Sealed Maple keys blob (1 file).**

- `apps/server/src/provider/maple/sealedMapleKeys.json` — `"workspaceDomain": "baubap.com"`

**1Password-sealed secret vaults (5 files).** `BundleDecryptKey.ts`: "That key is not in the
artifact. It is read here, from the `Ai Tools` 1Password vault." `GithubTokenVault.ts`:
"Locked until a Google Workspace sign-in reports the Baubap domain."

- `apps/server/src/secrets/BundleDecryptKey.test.ts` — exercises the `Ai Tools` 1Password read path below
- `apps/server/src/secrets/BundleDecryptKey.ts` — "read here, from the `Ai Tools` 1Password vault over the `op` CLI"
- `apps/server/src/secrets/GithubTokenVault.test.ts` — `const WORKSPACE_DOMAIN = "baubap.com";`
- `apps/server/src/secrets/GithubTokenVault.ts` — "Locked until a Google Workspace sign-in reports the Baubap domain"
- `apps/server/src/secrets/sealedGithubToken.json` — `"workspaceDomain": "baubap.com"`

**Web: repository discovery, monogram, sealed-content gate (9 files).**
`RepositoryMonogram.tsx`: "Monogram tiles for Baubap repositories." `WorkspaceAccessGate.tsx`:
"CH3 is an internal Baubap tool, so the desktop app opens only for a Google account in the
Baubap workspace."

- `apps/web/src/components/DiscoverProjectsDialog.tsx` — "Link the Baubap repositories already checked out on this machine"
- `apps/web/src/components/ProjectFavicon.test.tsx` — `const BAUBAP_API = "github.com/baubap/baubap-api";`
- `apps/web/src/components/RepositoryMonogram.test.tsx` — reads `REPOSITORY_MONOGRAM_BY_CANONICAL_KEY`
- `apps/web/src/components/RepositoryMonogram.tsx` — "Baubap's repos are backend services, policy engines and SQL"
- `apps/web/src/components/auth/SealedContentUnlock.tsx` — "can only run once a Baubap Google account has signed in on this machine"
- `apps/web/src/components/auth/VpnRecommendationDialog.tsx` — "CH3 opens what it ships sealed with a key it can fetch from Baubap's internal network"
- `apps/web/src/components/auth/WorkspaceAccessGate.tsx` — "CH3 is an internal Baubap tool, so the desktop app opens only for a Google account in the Baubap workspace"
- `apps/web/src/components/auth/sealedContentGate.logic.test.ts` — tests the gate whose payloads are "the RedSight bundle and the Maple keys"
- `apps/web/src/components/auth/sealedContentGate.logic.ts` — "The unlock is what opens the RedSight bundle and the Maple keys"

**Metered-model confirmation dialog (3 files).** `MeteredModelDialog.tsx`: "draws a multiple
of the rest of a conversation's usage from one pool Baubap shares company-wide."

- `apps/web/src/components/chat/MeteredModelDialog.logic.test.ts` — asserts the fallback sentence the dialog reads out for a metered model
- `apps/web/src/components/chat/MeteredModelDialog.logic.ts` — formats the footer for the dialog quoted below
- `apps/web/src/components/chat/MeteredModelDialog.tsx` — "one pool Baubap shares company-wide — 4× for Claude Fable 5.1 and Kimi K3"

**Default-project rail, launcher, skills catalogue UI (12 files).**
`DefaultProjectsRail.tsx`: "Baubap superpowers — the five projects pinned above the
conversation list." `launchActions.ts`: "What each Baubap superpower offers you the moment
you open it."

- `apps/web/src/components/defaultProjects/DefaultProjectsRail.tsx` — "Baubap superpowers — the five projects pinned above the conversation list"
- `apps/web/src/components/defaultProjects/ProjectLauncher.tsx` — "Opening CH3 or RedSight lands here rather than on an empty composer"
- `apps/web/src/components/defaultProjects/SkillsCatalog.test.tsx` — builds `BaubapSkill` fixtures for the shelf below
- `apps/web/src/components/defaultProjects/SkillsCatalog.tsx` — imports `type { BaubapSkill, EnvironmentId }`
- `apps/web/src/components/defaultProjects/launchActions.test.ts` — "gives RedSight the four jobs it is opened for"
- `apps/web/src/components/defaultProjects/launchActions.ts` — "What each Baubap superpower offers you the moment you open it"
- `apps/web/src/components/defaultProjects/requiredModel.logic.test.ts` — "names Opus for RedSight, and says whether the seat has to be asked"
- `apps/web/src/components/defaultProjects/requiredModel.logic.ts` — "RedSight's instructions refuse to start on anything but Opus with extended thinking"
- `apps/web/src/components/defaultProjects/skillSections.logic.test.ts` — "treats a company procedure as a process, including ones written for engineers"
- `apps/web/src/components/defaultProjects/skillSections.logic.ts` — "Which shelf a Baubap skill belongs on"
- `apps/web/src/components/defaultProjects/useDefaultProjectKind.ts` — "Which Baubap superpower this project is, if it is one"
- `apps/web/src/components/defaultProjects/useProjectLaunch.ts` — "Open a superpower: a new conversation in its project, and nothing else"

**MCP shelf monogram (1 file).**

- `apps/web/src/components/mcp/mcpShelfMonogram.ts` — "The tile for the Baubap MCP shelf ... BAU/DEX, RED, SKILLS, ORCH"

**Default-projects store (2 files).**

- `apps/web/src/defaultProjectsStore.test.ts` — "stops a launch running on the tier default" for a superpower launch submission
- `apps/web/src/defaultProjectsStore.ts` — "Whether the Baubap superpowers section is unfurled"

**Web state: metering, model-access tier, sealed-content unlock (3 files).**

- `apps/web/src/state/meteringAccount.ts` — "The Claude account a metering decision is being made on"
- `apps/web/src/state/modelAccess.ts` — "the model tier, and the workspace domain that unseals what the build ships encrypted"
- `apps/web/src/state/sealedContent.ts` — "Ask an environment to open what its build ships sealed — the RedSight bundle and the Maple keys"

**Docs: repository access, keyring, provenance audit (3 files).**

- `docs/internals/github-repository-access.md` — "How CH3 puts the Baubap repositories on an engineer's machine"
- `docs/operations/ch3-keyring-setup.md` — "CH3 ships three things encrypted inside the app"; vault is `Ai Tools`
- `docs/security/fork-provenance-audit.md` — "Audience: Baubap engineering leadership"

**User docs: superpowers, discovery, model access, onboarding (4 files).**

- `docs/user/baubap-projects.md` — "# Baubap superpowers" / "Using CH3 at Baubap?"
- `docs/user/discover-baubap-projects.md` — "Joining Baubap means cloning a lot of repositories"
- `docs/user/model-access.md` — "CH3 draws on capacity Baubap pays for once and everyone shares"
- `docs/user/onboarding-baubap-team.md` — "Ambiente base de Claude Code / CH3 de Baubap"

**Workspace-access wire schema (1 file).**

- `packages/contracts/src/workspaceAccess.ts` — "CH3 opens only for a Google account in the Baubap workspace; these are the shapes the desktop shell and the renderer exchange about it"

**Shared pure rules: MCP catalogue, account roster, default projects, token vaults, model access (14 files).**
`claudeAccountRoster.ts`: "The Baubap Claude accounts CH3 ships knowing about."
`modelAccess.ts`: "Baubap pays for one shared pool of agent capacity, and every CH3
install draws on it."

- `packages/shared/src/baubapMcp.test.ts` — "names every server exactly once" against `BAUBAP_MCP_DEFINITIONS`
- `packages/shared/src/baubapMcp.ts` — "The MCP servers Baubap runs, and who may install which"
- `packages/shared/src/claudeAccountRoster.test.ts` — "opens with Claudio Cero in slot zero" (`claudio.cero@baubap.com`)
- `packages/shared/src/claudeAccountRoster.ts` — "The Baubap Claude accounts CH3 ships knowing about"
- `packages/shared/src/defaultProjects.test.ts` — "is Opus for RedSight, whose instructions refuse anything else"
- `packages/shared/src/defaultProjects.ts` — "The six projects every Baubap engineer has, whether or not they cloned them"
- `packages/shared/src/githubTokenVault.test.ts` — `const DOMAIN = "baubap.com";`
- `packages/shared/src/githubTokenVault.ts` — "the GitHub token CH3 acts on Baubap repositories with"
- `packages/shared/src/gmailCredentialVault.test.ts` — `const MAILBOX = "claudio@baubap.com";`
- `packages/shared/src/gmailCredentialVault.ts` — "`claudio@baubap.com` is a dedicated sink account: Claude's sign-in magic links land in it"
- `packages/shared/src/modelAccess.test.ts` — imports `CLAUDE_ACCOUNT_ROSTER`, `TOP_TIER_EMAILS`, `FABLE_POOL_ACCOUNT_EMAILS`
- `packages/shared/src/modelAccess.ts` — "Baubap pays for one shared pool of agent capacity, and every CH3 install draws on it"
- `packages/shared/src/workspaceAccess.test.ts` — checks `WORKSPACE_DOMAIN` against decoded Google id-token claims
- `packages/shared/src/workspaceAccess.ts` — "CH3 is an internal Baubap tool, so the desktop app opens only for a Google account in the Baubap workspace"

**Authoring-time sealing scripts (5 files).** `seal-github-token.ts`: "resource owner
`Baubap`, over exactly the five repositories the default projects name."

- `scripts/lib/one-password.ts` — "Reading secrets out of 1Password from the authoring scripts"
- `scripts/seal-github-token.ts` — "resource owner `Baubap`, over exactly the five repositories the default projects name"
- `scripts/seal-gmail-credential.ts` — "Seal the Claude sign-in mailbox credential into the committed blob"
- `scripts/seal-maple-keys.ts` — "Seal the two Maple API keys into the committed blob"
- `scripts/verify-github-token.ts` — "Prove the sealed GitHub token is the one in 1Password"

No file in this bucket flipped: all 102 name Baubap, a sealed 1Password payload, the account
roster, or the metering pool in their own first paragraph or their own test fixtures — none
read as generic code that happened to be swept up by a path pattern.

## Rejected with a reason (28 files)

- **Automated Claude sign-in** (`claudeAutoSignIn*`, `claudeSignInAutomation*`,
  `claudeMagicLink*`, the sign-in harness): needs a special token for hard-coded
  accounts, and was refused outright when the port was specified.
- **Private release channel** (`CH3Installer*`, `githubUpdateToken*`, `installScript*`,
  `install.sh`): downloads a release from a private repository with a sealed token.
- **`migrateLegacyStorageKeys.ts`**: provably a no-op here — both its prefixes are the
  same string after the brand rename, so its loop always continues. Deleted in `6abd304`.
- **`scripts/mobile-showcase-environment.ts`**: byte-identical duplicate of
  `showcase-environment.ts`, collapsed into one seeder in `6abd304`.
- **Their repository furniture**: `CLAUDE.md`, `CH3-SYNC.md`, `.plans/`, their agent
  documents, CODEOWNERS, PR template and the PR-description workflow.

- `.github/CODEOWNERS`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yaml`
- `.github/workflows/pr-description.yml`
- `.plans/stability-macos-audit.md`
- `.plans/subtractive-pass.md`
- `CH3-SYNC.md`
- `CLAUDE.md`
- `LLM coding agent documents/CH3 Brain Agent.md`
- `LLM coding agent documents/CH3 Coding Agent.md`
- `LLM coding agent documents/STACKED_PR_MERGE_PLAYBOOK.md`
- `LLM coding agent documents/TEST_DOCUMENTATION.md`
- `apps/desktop/scripts/claude-sign-in-flow-harness.cjs`
- `apps/desktop/src/auth/claudeMagicLink.test.ts`
- `apps/desktop/src/auth/claudeMagicLink.ts`
- `apps/desktop/src/updates/CH3Installer.test.ts`
- `apps/desktop/src/updates/CH3Installer.ts`
- `apps/desktop/src/updates/githubUpdateToken.test.ts`
- `apps/desktop/src/updates/githubUpdateToken.ts`
- `apps/desktop/src/updates/installScript.test.ts`
- `apps/desktop/src/window/claudeAutoSignIn.test.ts`
- `apps/desktop/src/window/claudeAutoSignIn.ts`
- `apps/desktop/src/window/claudeAutoSignInPort.ts`
- `apps/desktop/src/window/claudeSignInAutomation.test.ts`
- `apps/desktop/src/window/claudeSignInAutomation.ts`
- `apps/web/src/migrateLegacyStorageKeys.ts`
- `install.sh`
- `scripts/mobile-showcase-environment.ts`

## Exported names absent from files both forks carry (61 across 19 files)

All 61 are accounted for by the verdicts above, with three exceptions worth stating:

- `CH3_MCP_TOOL_TIMEOUT_MS` and `CH3_CODEX_LAUNCH_ARGS_ENV` are **renames**, not
  absences: this fork uses the `CH3CODE_` namespace for its own runtime variables, and
  conflating the two namespaces is what leaked the server's whole environment into every
  terminal until `24109eb`. Likewise `MINIMUM_CLAUDE_FABLE_5_1_VERSION` is
  `MINIMUM_CLAUDE_FABLE_VERSION` here.
- `PACKAGED_BUILD_INPUTS`, `describePackagedBuildConfig`, `PackagedBuildConfigReport` and
  `IncompletePackagedBuildConfigError` were **deleted on purpose**: the gate only makes
  sense for an artifact carrying mandatory baked secrets, and this one carries none.
- `getAutoUpdateDisabledReason` belongs to the private release channel above.

- `packages/contracts/src/rpc.ts` — MeteredModelUseRecord, WsMapleUnlockRpc, WsOrchestratorAbortRunRpc, WsOrchestratorAnswerCheckpointRpc, WsOrchestratorLeadAgentRpc, WsOrchestratorListRunsRpc, WsOrchestratorReadFileRpc, WsOrchestratorRepositoryBranchesRpc, WsOrchestratorResumeRunRpc, WsOrchestratorStartRunRpc, WsOrchestratorStatusRpc, WsProjectsDiscoverBaubapRepositoriesRpc, WsServerRecordMeteredModelUseRpc, WsSkillsInstallRpc, WsSkillsListRpc, WsSkillsRemoveRpc, WsSubscribeOrchestratorEventsRpc, WsSubscribeOrchestratorTranscriptRpc, WsWorkspaceGithubIdentityRpc, WsWorkspaceListDefaultProjectsRpc, WsWorkspaceMcpCatalogRpc, WsWorkspaceMcpInstallRpc, WsWorkspaceMcpRemoveRpc, WsWorkspaceMcpServerActionRpc, WsWorkspaceProbeKeyEndpointRpc, WsWorkspaceRefreshDefaultProjectsRpc, WsWorkspaceUnlockSealedContentRpc
- `apps/desktop/src/ipc/channels.ts` — CLAUDE_SIGN_IN_HANDOFF_CHANNEL, CLAUDE_SIGN_IN_MAILBOX_STATUS_CHANNEL, WORKSPACE_SESSION_RESTORE_CHANNEL, WORKSPACE_SIGN_IN_CHANNEL
- `packages/contracts/src/project.ts` — BaubapRepositoryCandidate, ProjectDiscoverBaubapRepositoriesError, ProjectDiscoverBaubapRepositoriesInput, ProjectDiscoverBaubapRepositoriesResult
- `apps/desktop/src/window/claudeSignInFlow.ts` — CLAUDE_AUTO_SIGN_IN_HANDOFF_MS, CLAUDE_AUTO_SIGN_IN_HANDOFF_TIMEOUT_DETAIL, CLAUDE_OAUTH_AUTOMATED_CLOSE_DELAY_MS
- `apps/web/src/components/settings/ClaudeAccountSwitcher.logic.ts` — fablePoolRowLock, withReclaimedRosterSlots, withoutDuplicateRosterSlots
- `apps/web/src/state/projects.ts` — projectDiscoverBaubapRepositories, workspaceDefaultProjects, workspaceDefaultProjectsRefresh
- `scripts/lib/public-config.ts` — PACKAGED_BUILD_INPUTS, PackagedBuildConfigReport, describePackagedBuildConfig
- `apps/web/src/components/Icons.tsx` — BaubapIcon, MapleIcon
- `packages/contracts/src/claudeAccounts.ts` — ClaudeSignInHandoff, ClaudeSignInMailboxStatus
- `apps/desktop/src/ipc/methods/claudeSignIn.ts` — claudeSignInMailboxStatus
- `apps/desktop/src/updates/DesktopUpdates.ts` — getAutoUpdateDisabledReason
- `apps/server/src/config.ts` — GoogleWorkspaceClient
- `apps/server/src/mcp/McpHttpServer.ts` — ContributionToolkitRegistrationLive
- `apps/server/src/mcp/McpProviderSession.ts` — CH3_MCP_TOOL_TIMEOUT_MS
- `apps/server/src/provider/Layers/ClaudeProvider.ts` — MINIMUM_CLAUDE_FABLE_5_1_VERSION
- `apps/server/src/provider/Layers/codexLaunchArgs.ts` — CH3_CODEX_LAUNCH_ARGS_ENV
- `apps/server/src/ws.ts` — unlockSealedContent
- `packages/shared/src/git.ts` — isBaubapRepositoryCanonicalKey
- `scripts/build-desktop-artifact.ts` — IncompletePackagedBuildConfigError

## Keeping this true

Run `node scripts/port-audit.ts` after any port work. Anything it prints that is not in
this file is undecided; anything decided moves to the section that matches, with the
reason written in the same sentence. When a feature is ported, its rows leave this file
entirely — the script stops printing them.
